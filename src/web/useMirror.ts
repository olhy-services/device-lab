import { type ScrcpyMediaStreamPacket, ScrcpyVideoCodecId } from '@yume-chan/scrcpy';
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import {
  type ControlMessage,
  ScreenEventSchema,
  VIDEO_FLAG_HAS_PTS,
  VIDEO_FLAG_KEYFRAME,
  VIDEO_HEADER_BYTES,
  VIDEO_PACKET_CONFIG,
} from '../shared/schema';

export type MirrorStatus =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'error'; message: string }
  | { kind: 'closed'; message: string };

export interface Mirror {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  status: MirrorStatus;
  /** Tamanho do vídeo (as coordenadas do toque são nessa escala). */
  size: { width: number; height: number } | null;
  /** Último texto copiado no aparelho (sincroniza com a área de transferência daqui). */
  deviceClipboard: string | null;
  /** Muda a cada conexão: use como `key` do canvas (um contexto WebGL novo por sessão). */
  sessionKey: string;
  send(message: ControlMessage): void;
  reconnect(): void;
}

function toPacket(buffer: ArrayBuffer): ScrcpyMediaStreamPacket | null {
  if (buffer.byteLength < VIDEO_HEADER_BYTES) return null;
  const view = new DataView(buffer);
  const data = new Uint8Array(buffer, VIDEO_HEADER_BYTES);
  if (view.getUint8(0) === VIDEO_PACKET_CONFIG) return { type: 'configuration', data };
  const flags = view.getUint8(1);
  return {
    type: 'data',
    keyframe: (flags & VIDEO_FLAG_KEYFRAME) !== 0,
    pts: (flags & VIDEO_FLAG_HAS_PTS) !== 0 ? view.getBigInt64(2) : undefined,
    data,
  };
}

const CODECS: readonly ScrcpyVideoCodecId[] = Object.values(ScrcpyVideoCodecId);
const SUPPORTED = WebCodecsVideoDecoder.isSupported;
const UNSUPPORTED: MirrorStatus = {
  kind: 'error',
  message: 'Este navegador não tem WebCodecs. Use Chrome, Edge ou Firefox recentes.',
};

export function useMirror(serial: string): Mirror {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<MirrorStatus>({ kind: 'connecting' });
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [deviceClipboard, setDeviceClipboard] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [lastKey, setLastKey] = useState(`${serial}:${attempt}`);

  // Trocou de aparelho ou pediu reconexão: volta ao estado inicial já neste render.
  if (lastKey !== `${serial}:${attempt}`) {
    setLastKey(`${serial}:${attempt}`);
    setStatus({ kind: 'connecting' });
    setSize(null);
  }

  useEffect(() => {
    if (!SUPPORTED) return;
    const socket = new WebSocket(`ws://${location.host}/ws/screen/${encodeURIComponent(serial)}`);
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    let decoder: WebCodecsVideoDecoder | null = null;
    let writer: WritableStreamDefaultWriter<ScrcpyMediaStreamPacket> | null = null;
    let closedByUs = false;

    const fail = (message: string) => {
      setStatus({ kind: 'error', message });
      socket.close();
    };

    socket.onmessage = (message: MessageEvent<unknown>) => {
      if (message.data instanceof ArrayBuffer) {
        const packet = toPacket(message.data);
        if (packet && writer) {
          writer.write(packet).catch(() => fail('O decodificador de vídeo parou. Reconecte.'));
        }
        return;
      }
      if (typeof message.data !== 'string') return;
      let value: unknown;
      try {
        value = JSON.parse(message.data);
      } catch {
        return;
      }
      const event = ScreenEventSchema.safeParse(value);
      if (!event.success) return;
      const data = event.data;
      switch (data.type) {
        case 'ready': {
          const canvas = canvasRef.current;
          const codec = CODECS.find((c) => c === data.codec);
          if (!canvas || codec === undefined) {
            fail('Formato de vídeo não suportado.');
            return;
          }
          const renderer = WebGLVideoFrameRenderer.isSupported
            ? new WebGLVideoFrameRenderer(canvas)
            : new BitmapVideoFrameRenderer(canvas);
          decoder?.dispose();
          decoder = new WebCodecsVideoDecoder({ codec, renderer });
          writer = decoder.writable.getWriter();
          decoder.sizeChanged(({ width, height }) => setSize({ width, height }));
          if (data.width > 0 && data.height > 0) setSize({ width: data.width, height: data.height });
          setStatus({ kind: 'live' });
          return;
        }
        case 'size':
          setSize({ width: data.width, height: data.height });
          return;
        case 'clipboard':
          setDeviceClipboard(data.text);
          // Só funciona com a aba em foco; se não der, o texto fica disponível na interface.
          navigator.clipboard?.writeText(data.text).catch(() => undefined);
          return;
        case 'error':
          setStatus({ kind: 'error', message: data.message });
          return;
        case 'closed':
          setStatus({ kind: 'closed', message: data.message });
          return;
      }
    };
    socket.onclose = () => {
      if (closedByUs) return;
      setStatus((current) =>
        current.kind === 'error' || current.kind === 'closed'
          ? current
          : { kind: 'closed', message: 'A conexão com o espelhamento caiu.' },
      );
    };

    return () => {
      closedByUs = true;
      socketRef.current = null;
      socket.close();
      writer?.releaseLock();
      decoder?.dispose();
    };
  }, [serial, attempt]);

  const send = useCallback((message: ControlMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  return { canvasRef, status: SUPPORTED ? status : UNSUPPORTED, size, deviceClipboard, sessionKey: lastKey, send, reconnect };
}
