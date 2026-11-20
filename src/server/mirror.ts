import { fileURLToPath } from 'node:url';

import { AdbServerClient } from '@yume-chan/adb';
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from '@yume-chan/adb-scrcpy';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { BIN } from '@yume-chan/fetch-scrcpy-server';
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidKeyEventMeta,
  AndroidMotionEventAction,
  type ScrcpyControlMessageWriter,
  type ScrcpyMediaStreamPacket,
} from '@yume-chan/scrcpy';
import { WritableStream } from '@yume-chan/stream-extra';
import type { WebSocket } from 'ws';

import {
  type ControlMessage,
  type DeviceButton,
  type ScreenEvent,
  VIDEO_FLAG_HAS_PTS,
  VIDEO_FLAG_KEYFRAME,
  VIDEO_HEADER_BYTES,
  VIDEO_PACKET_CONFIG,
  VIDEO_PACKET_DATA,
} from '../shared/schema';
import { adb, shell } from './adb';
import { errorMessage, withTimeout } from './exec';

/** O servidor do scrcpy apaga o próprio .jar ao iniciar: é enviado de novo a cada sessão. */
const REMOTE_JAR = '/data/local/tmp/device-lab-scrcpy.jar';
const SERVER_BIN = fileURLToPath(BIN);
/** Acima disso o navegador está atrasado: pula quadros até o próximo keyframe. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const STOP_GRACE_MS = 4_000;

const KEY_CODES = new Map<string, AndroidKeyCode>(Object.entries(AndroidKeyCode));
const META = {
  none: AndroidKeyEventMeta.None,
  shift: AndroidKeyEventMeta.Shift,
  ctrl: AndroidKeyEventMeta.Ctrl,
  alt: AndroidKeyEventMeta.Alt,
} as const;
const TOUCH_ACTION = {
  down: AndroidMotionEventAction.Down,
  move: AndroidMotionEventAction.Move,
  up: AndroidMotionEventAction.Up,
  cancel: AndroidMotionEventAction.Cancel,
} as const;
const BUTTON_KEYS: Partial<Record<DeviceButton, AndroidKeyCode>> = {
  home: AndroidKeyCode.AndroidHome,
  recents: AndroidKeyCode.AndroidAppSwitch,
  power: AndroidKeyCode.Power,
  'volume-up': AndroidKeyCode.VolumeUp,
  'volume-down': AndroidKeyCode.VolumeDown,
};

let adbClient: AdbServerClient | null = null;
const getAdbClient = () =>
  (adbClient ??= new AdbServerClient(new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 })));

interface Viewer {
  socket: WebSocket;
  /** Só volta a receber vídeo a partir de um keyframe (entrou agora ou ficou para trás). */
  waitingKeyframe: boolean;
}

/**
 * Um espelhamento por aparelho, compartilhado por todas as abas abertas nele.
 * Começa quando a primeira aba conecta e termina pouco depois da última sair.
 */
export class MirrorSession {
  private readonly viewers = new Set<Viewer>();
  private client: AdbScrcpyClient<AdbScrcpyOptions3_3_3<true>> | null = null;
  private controller: ScrcpyControlMessageWriter | null = null;
  private starting: Promise<void> | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private config: ScrcpyMediaStreamPacket | null = null;
  private ready: Extract<ScreenEvent, { type: 'ready' }> | null = null;
  private lastReset = 0;

  constructor(
    readonly serial: string,
    private readonly onEnd: () => void,
  ) {}

  get viewerCount(): number {
    return this.viewers.size;
  }

  attach(socket: WebSocket): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    const viewer: Viewer = { socket, waitingKeyframe: true };
    this.viewers.add(viewer);
    socket.on('close', () => this.detach(viewer));

    this.starting ??= this.start().catch((error: unknown) => {
      this.broadcast({ type: 'error', message: friendlyStartError(error) });
      void this.stop();
    });
    void this.starting.then(() => {
      if (!this.ready || !this.viewers.has(viewer)) return;
      send(socket, this.ready);
      if (this.config) sendPacket(socket, this.config);
      this.requestKeyframe(true);
    });
  }

  private detach(viewer: Viewer): void {
    this.viewers.delete(viewer);
    if (this.viewers.size > 0 || this.stopTimer) return;
    // Recarregar a aba não deve reiniciar o espelhamento.
    this.stopTimer = setTimeout(() => void this.stop(), STOP_GRACE_MS);
  }

  private async start(): Promise<void> {
    await adb(this.serial, ['push', SERVER_BIN, REMOTE_JAR], 30_000);
    const device = await withTimeout(
      getAdbClient().createAdb({ serial: this.serial }),
      8_000,
      'O adb não respondeu ao abrir o aparelho',
    );
    const options = new AdbScrcpyOptions3_3_3({
      audio: false,
      videoCodec: 'h264',
      maxSize: 1600,
      videoBitRate: 6_000_000,
      maxFps: 60,
      control: true,
      clipboardAutosync: true,
      stayAwake: true,
      powerOffOnClose: false,
    });
    const client = await withTimeout(
      AdbScrcpyClient.start(device, REMOTE_JAR, options),
      15_000,
      'O espelhamento não iniciou a tempo',
    );
    this.client = client;
    this.controller = client.controller ?? null;

    // Toda saída precisa ser consumida, senão a conexão trava.
    void client.output
      .pipeTo(
        new WritableStream<string>({
          write: (line) => {
            if (process.env.DEVICE_LAB_DEBUG) console.log(`[scrcpy ${this.serial}] ${line}`);
          },
        }),
      )
      .catch(() => undefined);
    void client.clipboard
      ?.pipeTo(new WritableStream<string>({ write: (text) => this.broadcast({ type: 'clipboard', text }) }))
      .catch(() => undefined);
    void client.exited.then(() => {
      if (this.client !== client) return;
      this.broadcast({ type: 'closed', message: 'O espelhamento foi encerrado pelo aparelho.' });
      void this.stop();
    });

    const videoStream = client.videoStream;
    if (!videoStream) throw new Error('O scrcpy iniciou sem vídeo');
    const video = await withTimeout(videoStream, 10_000, 'O vídeo da tela não chegou');
    this.ready = { type: 'ready', codec: video.metadata.codec, width: video.width, height: video.height };
    video.sizeChanged(({ width, height }) => {
      if (this.ready) this.ready = { ...this.ready, width, height };
      this.broadcast({ type: 'size', width, height });
    });
    void video.stream
      .pipeTo(new WritableStream<ScrcpyMediaStreamPacket>({ write: (packet) => this.fanOut(packet) }))
      .catch(() => undefined);
  }

  private fanOut(packet: ScrcpyMediaStreamPacket): void {
    if (packet.type === 'configuration') {
      this.config = packet;
      for (const viewer of this.viewers) sendPacket(viewer.socket, packet);
      return;
    }
    const keyframe = packet.keyframe === true;
    for (const viewer of this.viewers) {
      if (viewer.waitingKeyframe && !keyframe) continue;
      if (!keyframe && viewer.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        viewer.waitingKeyframe = true;
        this.requestKeyframe(false);
        continue;
      }
      viewer.waitingKeyframe = false;
      sendPacket(viewer.socket, packet);
    }
  }

  /** Pede ao encoder um keyframe novo (aba que entrou agora ou que ficou para trás). */
  private requestKeyframe(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastReset < 2_000) return;
    this.lastReset = now;
    void this.controller?.resetVideo().catch(() => undefined);
  }

  private broadcast(event: ScreenEvent): void {
    for (const viewer of this.viewers) send(viewer.socket, event);
  }

  async control(message: ControlMessage): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    switch (message.type) {
      case 'touch':
        return controller.injectTouch({
          action: TOUCH_ACTION[message.action],
          pointerId: BigInt(message.pointerId),
          pointerX: message.x,
          pointerY: message.y,
          videoWidth: message.width,
          videoHeight: message.height,
          pressure: message.action === 'up' ? 0 : message.pressure,
          actionButton: 0,
          buttons: 0,
        });
      case 'scroll':
        return controller.injectScroll({
          pointerX: message.x,
          pointerY: message.y,
          videoWidth: message.width,
          videoHeight: message.height,
          scrollX: message.dx,
          scrollY: message.dy,
          buttons: 0,
        });
      case 'key': {
        const keyCode = KEY_CODES.get(message.code);
        if (keyCode === undefined) return;
        return controller.injectKeyCode({
          action: message.action === 'down' ? AndroidKeyEventAction.Down : AndroidKeyEventAction.Up,
          keyCode,
          repeat: 0,
          metaState: META[message.meta],
        });
      }
      case 'text':
        // O scrcpy só digita ASCII; acentos e emoji entram colando.
        if (/^[\x20-\x7e]*$/.test(message.text)) return controller.injectText(message.text);
        return controller.setClipboard({ sequence: 0n, paste: true, content: message.text });
      case 'paste':
        return controller.setClipboard({ sequence: 0n, paste: true, content: message.text });
      case 'button':
        return this.pressButton(controller, message.button);
      case 'keyframe':
        this.requestKeyframe(true);
        return;
    }
  }

  /**
   * O `rotateDevice` do scrcpy só mexe na rotação do usuário, que o Android ignora com o giro automático ligado.
   * Travar a rotação no sentido oposto funciona nos dois casos (e é o que o botão promete).
   */
  private async rotate(): Promise<void> {
    const out = await shell(this.serial, "dumpsys display | grep -m 1 -oE 'mCurrentOrientation=[0-9]' ; true");
    const current = Number(/mCurrentOrientation=(\d)/.exec(out)?.[1] ?? 0);
    await shell(this.serial, `wm user-rotation lock ${current % 2 === 0 ? 1 : 0}`);
  }

  private async pressButton(controller: ScrcpyControlMessageWriter, button: DeviceButton): Promise<void> {
    switch (button) {
      case 'back':
        await controller.backOrScreenOn(AndroidKeyEventAction.Down);
        return controller.backOrScreenOn(AndroidKeyEventAction.Up);
      case 'notifications':
        return controller.expandNotificationPanel();
      case 'quick-settings':
        return controller.expandSettingPanel();
      case 'rotate':
        return this.rotate();
      default: {
        const keyCode = BUTTON_KEYS[button];
        if (keyCode === undefined) return;
        const base = { keyCode, repeat: 0, metaState: AndroidKeyEventMeta.None };
        await controller.injectKeyCode({ ...base, action: AndroidKeyEventAction.Down });
        return controller.injectKeyCode({ ...base, action: AndroidKeyEventAction.Up });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const client = this.client;
    this.client = null;
    this.controller = null;
    this.starting = null;
    this.config = null;
    this.ready = null;
    for (const viewer of this.viewers) viewer.socket.close(1000, 'fim');
    this.viewers.clear();
    this.onEnd();
    if (client) await withTimeout(client.close(), 5_000, 'scrcpy não fechou').catch(() => undefined);
  }
}

function friendlyStartError(error: unknown): string {
  const message = errorMessage(error);
  if (/exited prematurely/i.test(message)) {
    return 'O servidor de espelhamento fechou ao iniciar. Desbloqueie o aparelho e tente de novo.';
  }
  return `Não foi possível espelhar: ${message}`;
}

function send(socket: WebSocket, event: ScreenEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}

/** [tipo:u8][flags:u8][pts:i64 big-endian] + dados. */
function sendPacket(socket: WebSocket, packet: ScrcpyMediaStreamPacket): void {
  if (socket.readyState !== socket.OPEN) return;
  const frame = new Uint8Array(VIDEO_HEADER_BYTES + packet.data.length);
  const view = new DataView(frame.buffer);
  if (packet.type === 'configuration') {
    view.setUint8(0, VIDEO_PACKET_CONFIG);
  } else {
    view.setUint8(0, VIDEO_PACKET_DATA);
    let flags = packet.keyframe ? VIDEO_FLAG_KEYFRAME : 0;
    if (packet.pts !== undefined) {
      flags |= VIDEO_FLAG_HAS_PTS;
      view.setBigInt64(2, packet.pts);
    }
    view.setUint8(1, flags);
  }
  frame.set(packet.data, VIDEO_HEADER_BYTES);
  socket.send(frame);
}
