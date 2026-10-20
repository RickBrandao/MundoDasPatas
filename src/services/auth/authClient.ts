/**
 * Contrato mínimo de autenticação usado pelo painel.
 *
 * A implementação real (`firebaseAuthClient.ts`) usa o Firebase Authentication e só é carregada
 * no modo `firebase`; os testes usam uma implementação falsa. Nenhum componente fala com o SDK.
 */
export interface AuthUser {
  uid: string;
  email: string | null;
  /** Token atual do SDK (renovado por ele quando expira). `forceRefresh` pede um novo ao Firebase. */
  getIdToken(forceRefresh?: boolean): Promise<string>;
}

export interface AuthClient {
  /** Chamado com a sessão restaurada e a cada login/logout. Devolve a função de cancelamento. */
  onAuthStateChanged(listener: (user: AuthUser | null) => void): () => void;
  /** Rejeita com um erro que tem `code` (ex.: `auth/invalid-credential`). */
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

/** Código de erro do Firebase (`auth/...`), quando houver. */
export function authErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Mensagens para o login: compreensíveis e sem revelar se o e-mail existe ou detalhes internos. */
export function signInErrorMessage(error: unknown): string {
  switch (authErrorCode(error)) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'E-mail ou senha incorretos.';
    case 'auth/invalid-email':
      return 'Informe um e-mail válido.';
    case 'auth/user-disabled':
      return 'Esta conta não pode entrar no momento. Fale com o responsável pelo sistema.';
    case 'auth/too-many-requests':
      return 'Muitas tentativas seguidas. Aguarde alguns minutos e tente novamente.';
    case 'auth/network-request-failed':
      return 'Sem conexão com o serviço de login. Verifique a internet e tente novamente.';
    case 'auth/operation-not-allowed':
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid.-please-pass-a-valid-api-key.':
    case 'auth/unauthorized-domain':
    case 'auth/configuration-not-found':
      return 'O login não está configurado corretamente neste ambiente.';
    default:
      return 'Não foi possível entrar agora. Tente novamente.';
  }
}
