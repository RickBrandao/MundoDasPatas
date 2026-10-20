import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Field } from '../../components/Field';
import { useAdminSession } from './adminSession';
import { AuthShell } from './AuthShell';

const DEFAULT_TARGET = '/admin/visao-geral';

/** Destino após o login: só rotas internas do painel (nunca a própria tela de login). */
function targetFrom(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/admin/') && !from.startsWith('/admin/login') ? from : DEFAULT_TARGET;
}

export function LoginPage() {
  const { session, signIn } = useAdminSession();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.status === 'starting') {
    return (
      <AuthShell title="Entrar">
        <p className="auth-status" role="status" aria-busy="true">
          <span className="auth-spinner" aria-hidden="true" />
          Carregando…
        </p>
      </AuthShell>
    );
  }
  if (session.status === 'failed') {
    return (
      <AuthShell title="Login indisponível">
        <div role="alert" className="alert alert--danger">
          {session.message}
        </div>
      </AuthShell>
    );
  }
  // Já autenticado no Firebase: o painel decide (verificação, acesso negado ou liberado).
  if (session.status !== 'signedOut') return <Navigate to={targetFrom(location.state)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!email.trim() || !password) {
      setError('Informe e-mail e senha.');
      return;
    }
    setPending(true);
    setError(null);
    const result = await signIn(email.trim(), password);
    // Em caso de sucesso, a sessão muda e esta tela redireciona sozinha.
    if (!result.ok) {
      setError(result.message);
      setPending(false);
    }
  };

  const notice = !error && !pending ? session.notice : null;

  return (
    <AuthShell title="Entrar">
      <p className="auth-card__lead">Acesso restrito à equipe da loja.</p>
      {notice && (
        <p className="notice notice--info" role="status">
          {notice}
        </p>
      )}
      <form className="auth-form" onSubmit={(e) => void submit(e)} noValidate aria-busy={pending}>
        <Field label="E-mail">
          <input
            className="input"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={pending}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
          />
        </Field>
        <Field label="Senha">
          <input
            className="input"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
          />
        </Field>
        {error && (
          <div id="login-error" role="alert" className="alert alert--danger">
            {error}
          </div>
        )}
        <button type="submit" className="btn btn--primary btn--lg auth-card__action" disabled={pending}>
          {pending && <span className="auth-spinner auth-spinner--light" aria-hidden="true" />}
          {pending ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </AuthShell>
  );
}
