import { createContext, useContext } from 'react';
import type { AuthUser } from '../../services/auth/authClient';

/**
 * Estado da sessão administrativa no modo `firebase`.
 * Autenticação (Firebase) e autorização (FastAPI) são etapas distintas: só `authorized` abre o painel.
 */
export type AdminSession =
  /** Carregando o SDK e restaurando a sessão salva. */
  | { status: 'starting' }
  | { status: 'signedOut'; notice: string | null }
  /** Usuário autenticado no Firebase; aguardando a confirmação do servidor. */
  | { status: 'verifying'; user: AuthUser }
  | { status: 'authorized'; user: AuthUser }
  | { status: 'forbidden'; user: AuthUser }
  /** O servidor não pôde confirmar o acesso (indisponível ou sem conexão). */
  | { status: 'unavailable'; user: AuthUser; message: string }
  /** O serviço de login não pôde ser carregado. */
  | { status: 'failed'; message: string };

export type SignInResult = { ok: true } | { ok: false; message: string };

export interface AdminSessionValue {
  session: AdminSession;
  signIn(email: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
  /** Repete a confirmação de acesso no servidor (após falha temporária). */
  retry(): void;
}

export const AdminSessionContext = createContext<AdminSessionValue | null>(null);

/** `null` no modo demonstração (sem login). */
export const useOptionalAdminSession = () => useContext(AdminSessionContext);

export function useAdminSession(): AdminSessionValue {
  const v = useContext(AdminSessionContext);
  if (!v) throw new Error('useAdminSession deve ser usado dentro de AdminAuthProvider.');
  return v;
}
