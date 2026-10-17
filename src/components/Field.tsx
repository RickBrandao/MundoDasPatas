import type { ReactNode } from 'react';

interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  error?: string;
  errorId?: string;
  hint?: ReactNode;
  full?: boolean;
}

/**
 * Campo de formulário: o rótulo envolve só o texto e o controle, e o erro fica fora dele,
 * para não contaminar o nome acessível (o controle aponta para o erro via aria-describedby).
 */
export function Field({ label, children, error, errorId, hint, full }: FieldProps) {
  return (
    <div className={full ? 'field field--full' : 'field'}>
      <label className="field__label">
        {label}
        {children}
      </label>
      {hint}
      {error && (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
