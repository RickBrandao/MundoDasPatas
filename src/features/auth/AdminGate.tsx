import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { useAdminSession } from './adminSession';
import { AuthShell } from './AuthShell';

/**
 * Libera o conteúdo somente após o servidor confirmar o acesso (`authorized`).
 * Em qualquer outro estado — inclusive enquanto verifica ou se o servidor falhar — o painel não é montado.
 * A proteção real dos dados continua no FastAPI; esta é a camada de interface.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const { session, signOut, retry } = useAdminSession();
  const location = useLocation();

  switch (session.status) {
    case 'authorized':
      return children;
    case 'signedOut':
      return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
    case 'starting':
    case 'verifying':
      return (
        <AuthShell title="Verificando acesso">
          <p className="auth-status" role="status" aria-busy="true">
            <span className="auth-spinner" aria-hidden="true" />
            Confirmando sua permissão no servidor…
          </p>
        </AuthShell>
      );
    case 'forbidden':
      return (
        <AuthShell title="Acesso negado">
          <div role="alert" className="alert alert--danger">
            A conta {session.user.email ? <strong>{session.user.email}</strong> : 'utilizada'} não tem permissão para acessar o painel
            administrativo.
          </div>
          <button type="button" className="btn btn--secondary btn--lg auth-card__action" onClick={() => void signOut()}>
            <Icon name="logout" />
            Sair e entrar com outra conta
          </button>
        </AuthShell>
      );
    case 'unavailable':
      return (
        <AuthShell title="Acesso não confirmado">
          <div role="alert" className="alert alert--danger">
            {session.message}
          </div>
          <button type="button" className="btn btn--primary btn--lg auth-card__action" onClick={retry}>
            <Icon name="refresh" />
            Tentar novamente
          </button>
          <button type="button" className="btn btn--secondary btn--lg auth-card__action" onClick={() => void signOut()}>
            <Icon name="logout" />
            Sair
          </button>
        </AuthShell>
      );
    case 'failed':
      return (
        <AuthShell title="Login indisponível">
          <div role="alert" className="alert alert--danger">
            {session.message}
          </div>
        </AuthShell>
      );
  }
}
