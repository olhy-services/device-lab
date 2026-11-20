import {
  Bell,
  Camera,
  ChevronLeft,
  Circle,
  type LucideIcon,
  Power,
  RotateCw,
  SlidersHorizontal,
  Square,
  Video,
  Volume1,
  Volume2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { DeviceButton } from '../../shared/schema';
import { api, saveBlob, stamp } from '../api';
import type { Mirror } from '../useMirror';

const GROUPS: readonly (readonly { button: DeviceButton; label: string; icon: LucideIcon }[])[] = [
  [
    { button: 'back', label: 'Voltar (botão direito na tela)', icon: ChevronLeft },
    { button: 'home', label: 'Início (botão do meio na tela)', icon: Circle },
    { button: 'recents', label: 'Apps recentes', icon: Square },
  ],
  [
    { button: 'notifications', label: 'Abrir notificações', icon: Bell },
    { button: 'quick-settings', label: 'Abrir configurações rápidas', icon: SlidersHorizontal },
  ],
  [
    { button: 'volume-up', label: 'Aumentar volume', icon: Volume2 },
    { button: 'volume-down', label: 'Diminuir volume', icon: Volume1 },
    { button: 'power', label: 'Liga/desliga a tela', icon: Power },
    { button: 'rotate', label: 'Girar a tela', icon: RotateCw },
  ],
];

interface DeviceControlsProps {
  serial: string;
  mirror: Mirror;
  onError(message: string): void;
}

/** Botões físicos do aparelho + captura de tela e gravação. */
export function DeviceControls({ serial, mirror, onError }: DeviceControlsProps) {
  const live = mirror.status.kind === 'live';
  const [shooting, setShooting] = useState(false);

  async function takeScreenshot() {
    setShooting(true);
    try {
      saveBlob(await api.screenshot(serial), `tela-${stamp()}.png`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setShooting(false);
    }
  }

  return (
    <div className="controls" role="toolbar" aria-label="Botões do aparelho" aria-orientation="vertical">
      {GROUPS.map((group, i) => (
        <div className="controls-group" key={i}>
          {group.map(({ button, label, icon: Icon }) => (
            <button
              key={button}
              type="button"
              className="btn icon ghost"
              title={label}
              aria-label={label}
              disabled={!live}
              onClick={() => mirror.send({ type: 'button', button })}
            >
              <Icon size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
      ))}
      <div className="controls-group">
        <button
          type="button"
          className="btn icon ghost"
          title="Captura de tela (PNG em resolução cheia)"
          aria-label="Captura de tela"
          disabled={shooting}
          onClick={() => void takeScreenshot()}
        >
          <Camera size={17} aria-hidden="true" />
        </button>
        <Recorder mirror={mirror} onError={onError} />
      </div>
    </div>
  );
}

/** Grava o que está no espelho (WebM), direto do canvas. */
function Recorder({ mirror, onError }: { mirror: Mirror; onError(message: string): void }) {
  const recorder = useRef<MediaRecorder | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const live = mirror.status.kind === 'live';

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [startedAt]);

  // O espelho caiu no meio da gravação: fecha o arquivo com o que já foi gravado.
  useEffect(() => {
    if (!live && recorder.current?.state === 'recording') recorder.current.stop();
  }, [live]);

  function start() {
    const canvas = mirror.canvasRef.current;
    if (!canvas) return;
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    if (!type) {
      onError('Este navegador não grava vídeo (MediaRecorder sem WebM).');
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 8_000_000 });
    rec.ondataavailable = (event) => chunks.push(event.data);
    rec.onstop = () => {
      saveBlob(new Blob(chunks, { type: 'video/webm' }), `gravacao-${stamp()}.webm`);
      recorder.current = null;
      setStartedAt(null);
    };
    rec.start(1_000);
    recorder.current = rec;
    const at = Date.now();
    setStartedAt(at);
    setNow(at);
  }

  const recording = startedAt !== null;
  const seconds = recording ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const label = recording ? 'Parar gravação e baixar' : 'Gravar a tela (WebM)';

  return (
    <button
      type="button"
      className="btn icon ghost record"
      title={label}
      aria-label={label}
      aria-pressed={recording}
      disabled={!live && !recording}
      onClick={() => (recording ? recorder.current?.stop() : start())}
    >
      {recording ? (
        <span className="record-time num">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </span>
      ) : (
        <Video size={17} aria-hidden="true" />
      )}
    </button>
  );
}
