import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Pilha de modais abertos: Esc fecha apenas o que está por cima. */
const stack: string[] = [];

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface ModalProps {
  onClose: () => void;
  label: string;
  children: ReactNode;
  role?: 'dialog' | 'alertdialog';
  /** center: diálogo centralizado; drawer: painel lateral (encomenda). */
  variant?: 'center' | 'drawer';
  overlayClassName?: string;
  className?: string;
  style?: CSSProperties;
}

export function Modal({ onClose, label, children, role = 'dialog', variant = 'center', overlayClassName = '', className = 'dialog', style }: ModalProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    stack.push(id);
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && panel) {
        // Mantém o foco dentro do modal.
        const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = stack.lastIndexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [id]);

  return createPortal(
    <div
      className={`overlay ${variant === 'drawer' ? 'overlay--drawer' : ''} ${overlayClassName}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} role={role} aria-modal="true" aria-label={label} tabIndex={-1} className={className} style={style}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function CloseButton({ onClick, label = 'Fechar' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="btn-close" onClick={onClick} aria-label={label}>
      <span aria-hidden="true" className="icon" style={{ fontSize: 22 }}>
        close
      </span>
    </button>
  );
}
