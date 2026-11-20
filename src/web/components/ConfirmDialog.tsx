import { type ReactNode, useEffect, useRef } from 'react';

export interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** Ação que apaga algo: o botão de confirmar vira vermelho. */
  tone: 'danger' | 'default';
  onConfirm(): void;
}

/** Confirmação dentro da página (nada de window.confirm). Esc ou Cancelar fecham. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose(): void }) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (request && !dialog.open) dialog.showModal();
    if (!request && dialog.open) dialog.close();
  }, [request]);

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="confirm-title">
      {request && (
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault();
            request.onConfirm();
            onClose();
          }}
        >
          <h2 id="confirm-title">{request.title}</h2>
          <div className="dialog-body">{request.body}</div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose} autoFocus>
              Cancelar
            </button>
            <button type="submit" className={request.tone === 'danger' ? 'btn danger' : 'btn primary'}>
              {request.confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
