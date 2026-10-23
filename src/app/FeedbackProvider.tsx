import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ConfirmContext, ToastContext, type ConfirmOptions } from './contexts';

/** Toast (mensagem rápida) e diálogo de confirmação, compartilhados por loja e painel. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showToast = useCallback((message: string) => {
    clearTimeout(timer.current);
    setToast({ id: Date.now(), message });
    timer.current = setTimeout(() => setToast(null), 2800);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        if (o.signal?.aborted) return resolve(false);
        const onAbort = () => {
          resolve(false);
          setPending((p) => (p === entry ? null : p));
        };
        const entry = {
          ...o,
          resolve: (v: boolean) => {
            o.signal?.removeEventListener('abort', onAbort);
            resolve(v);
          },
        };
        o.signal?.addEventListener('abort', onAbort, { once: true });
        setPending(entry);
      }),
    [],
  );
  const answer = (v: boolean) => {
    pending?.resolve(v);
    setPending(null);
  };

  return (
    <ToastContext.Provider value={showToast}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        {pending && (
          <Modal
            role="alertdialog"
            label={pending.title}
            onClose={() => answer(false)}
            overlayClassName="overlay--confirm"
            className="dialog confirm-dialog"
          >
            <h2 className="confirm-dialog__title">{pending.title}</h2>
            <p className="confirm-dialog__text">{pending.text}</p>
            <div className="dialog-actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn--secondary btn--md" onClick={() => answer(false)}>
                Voltar
              </button>
              <button type="button" className={`btn btn--md ${pending.danger ? 'btn--danger-solid' : 'btn--primary'}`} onClick={() => answer(true)}>
                {pending.ok}
              </button>
            </div>
          </Modal>
        )}
        <div aria-live="polite" role="status" className="sr-live">
          {toast && (
            <div key={toast.id} className="toast">
              <Icon name="check_circle" />
              {toast.message}
            </div>
          )}
        </div>
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}
