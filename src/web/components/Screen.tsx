import { LoaderCircle, RefreshCw } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useEffect, useRef } from 'react';

import type { Mirror } from '../useMirror';

const META_KEYS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
/** Ponteiro "dedo genérico" do scrcpy: o mouse vira um toque. */
const MOUSE_POINTER = -2;

interface ScreenProps {
  mirror: Mirror;
  label: string;
}

/**
 * A tela espelhada. Clique/arraste = toque; roda = rolagem; com a tela em foco,
 * o teclado digita no aparelho. Botão direito = Voltar, botão do meio = Início.
 */
export function Screen({ mirror, label }: ScreenProps) {
  const { canvasRef, status, size, send, sessionKey } = mirror;
  const frameRef = useRef<HTMLDivElement | null>(null);
  /** Ponteiros do navegador → ids pequenos para o Android (multitoque). */
  const pointers = useRef(new Map<number, number>());

  // Roda do mouse: o listener precisa ser não-passivo para impedir a rolagem da página.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = toVideo(canvas, event.clientX, event.clientY, size);
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1 / 3 : 1 / 100;
      const clamp = (v: number) => Math.max(-16, Math.min(16, v));
      send({
        type: 'scroll',
        ...point,
        ...size,
        dx: clamp(-event.deltaX * scale),
        dy: clamp(-event.deltaY * scale),
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasRef, send, size, sessionKey]);

  function pointerId(event: PointerEvent): number | null {
    if (event.pointerType === 'mouse') return MOUSE_POINTER;
    const known = pointers.current.get(event.pointerId);
    if (known !== undefined) return known;
    for (let id = 0; id < 10; id++) {
      if (![...pointers.current.values()].includes(id)) {
        pointers.current.set(event.pointerId, id);
        return id;
      }
    }
    return null;
  }

  function touch(event: PointerEvent<HTMLCanvasElement>, action: 'down' | 'move' | 'up' | 'cancel') {
    if (!size) return;
    const id = pointerId(event);
    if (id === null) return;
    const point = toVideo(event.currentTarget, event.clientX, event.clientY, size);
    send({ type: 'touch', action, pointerId: id, ...point, ...size, pressure: action === 'up' ? 0 : 1 });
    if (action === 'up' || action === 'cancel') pointers.current.delete(event.pointerId);
  }

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    frameRef.current?.focus({ preventScroll: true });
    if (event.pointerType === 'mouse' && event.button === 2) {
      send({ type: 'button', button: 'back' });
      return;
    }
    if (event.pointerType === 'mouse' && event.button === 1) {
      event.preventDefault();
      send({ type: 'button', button: 'home' });
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    touch(event, 'down');
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    touch(event, 'move');
  }

  function onPointerUp(event: PointerEvent<HTMLCanvasElement>, action: 'up' | 'cancel') {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    touch(event, action);
  }

  function onKey(event: KeyboardEvent<HTMLDivElement>, action: 'down' | 'up') {
    if (status.kind !== 'live' || META_KEYS.has(event.code)) return;
    const shortcut = event.ctrlKey || event.metaKey;
    // Colar daqui no aparelho.
    if (action === 'down' && shortcut && event.code === 'KeyV') {
      event.preventDefault();
      navigator.clipboard
        ?.readText()
        .then((text) => text && send({ type: 'paste', text }))
        .catch(() => undefined);
      return;
    }
    // Caractere comum: digita como texto (respeita layout do teclado e acentos).
    if (event.key.length === 1 && !shortcut && !event.altKey) {
      event.preventDefault();
      if (action === 'down') send({ type: 'text', text: event.key });
      return;
    }
    event.preventDefault();
    const meta = event.ctrlKey ? 'ctrl' : event.altKey ? 'alt' : event.shiftKey ? 'shift' : 'none';
    send({ type: 'key', action, code: event.code, meta });
  }

  // A largura sai da altura disponível × proporção do vídeo; ao girar, só a proporção muda.
  const ratio = size ? size.width / size.height : 9 / 19.5;
  const frameStyle: CSSProperties & Record<'--ar', number> = { '--ar': ratio };

  return (
    <div
      ref={frameRef}
      className="screen"
      data-orientation={ratio > 1 ? 'landscape' : 'portrait'}
      style={frameStyle}
      tabIndex={0}
      role="application"
      aria-label={`Tela de ${label}. Com foco, o teclado digita no aparelho.`}
      onKeyDown={(e) => onKey(e, 'down')}
      onKeyUp={(e) => onKey(e, 'up')}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        key={sessionKey}
        ref={canvasRef}
        className="screen-canvas"
        data-live={status.kind === 'live'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerUp(e, 'up')}
        onPointerCancel={(e) => onPointerUp(e, 'cancel')}
      />
      {status.kind !== 'live' && <ScreenOverlay mirror={mirror} />}
    </div>
  );
}

function ScreenOverlay({ mirror }: { mirror: Mirror }) {
  const { status, reconnect } = mirror;
  if (status.kind === 'connecting') {
    return (
      <div className="screen-overlay" role="status">
        <LoaderCircle size={18} className="spin" aria-hidden="true" />
        <span>Abrindo a tela…</span>
      </div>
    );
  }
  if (status.kind === 'live') return null;
  return (
    <div className="screen-overlay" role="alert">
      <span>{status.message}</span>
      <button type="button" className="btn sm" onClick={reconnect}>
        <RefreshCw size={14} aria-hidden="true" /> Reconectar
      </button>
    </div>
  );
}

function toVideo(canvas: HTMLCanvasElement, clientX: number, clientY: number, size: { width: number; height: number }) {
  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * size.width;
  const y = ((clientY - rect.top) / rect.height) * size.height;
  return {
    x: Math.max(0, Math.min(size.width, x)),
    y: Math.max(0, Math.min(size.height, y)),
  };
}
