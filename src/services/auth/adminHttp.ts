import { authErrorCode, type AuthUser } from './authClient';

/**
 * Cliente HTTP das rotas administrativas do FastAPI.
 *
 * - O token vem sempre do SDK (`getIdToken`), que o renova quando expira; nada é guardado aqui.
 * - `401` → tenta uma vez com token renovado à força (o anterior pode ter expirado no caminho).
 * - Sem cache e sem cookies: a autorização vai só no cabeçalho `Authorization`.
 * - `init.signal` (escopo da sessão + tempo limite) é respeitado antes do token, depois dele e no fetch.
 *
 * Futuras chamadas administrativas (TASK 06/07) devem passar por `request` em vez de repetir essa lógica.
 */
export interface AdminHttp {
  request(user: AuthUser, path: string, init?: RequestInit): Promise<Response>;
}

export function createAdminHttp(baseUrl: string): AdminHttp {
  return {
    async request(user, path, init = {}) {
      const send = async (forceRefresh: boolean) => {
        // `getIdToken` não aceita AbortSignal: a sessão é conferida antes e depois de obter o token,
        // para que nada seja enviado se ela terminou enquanto o token era obtido.
        init.signal?.throwIfAborted();
        const token = await user.getIdToken(forceRefresh);
        init.signal?.throwIfAborted();
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);
        headers.set('Accept', 'application/json');
        return fetch(`${baseUrl}${path}`, { ...init, headers, cache: 'no-store', credentials: 'omit' });
      };
      const first = await send(false);
      if (first.status !== 401) return first;
      init.signal?.throwIfAborted();
      return send(true);
    },
  };
}

export type AdminCheck =
  | { status: 'authorized'; uid: string }
  /** Token recusado mesmo após renovação: a sessão não vale mais. */
  | { status: 'unauthenticated' }
  /** Usuário autenticado, mas fora da lista de administradores do servidor. */
  | { status: 'forbidden' }
  /** Não foi possível confirmar (servidor indisponível, rede, resposta inesperada). Nunca libera o painel. */
  | { status: 'unavailable'; reason: 'server' | 'network' };

/** Situações em que o próprio SDK considera a sessão encerrada ao tentar renovar o token. */
const SESSION_ENDED_CODES = new Set(['auth/user-token-expired', 'auth/user-disabled', 'auth/user-not-found', 'auth/invalid-user-token']);

export async function verifyAdmin(http: AdminHttp, user: AuthUser, signal?: AbortSignal): Promise<AdminCheck> {
  let response: Response;
  try {
    response = await http.request(user, '/api/v1/admin/me', { signal });
  } catch (error) {
    const code = authErrorCode(error);
    if (code && SESSION_ENDED_CODES.has(code)) return { status: 'unauthenticated' };
    return { status: 'unavailable', reason: 'network' };
  }
  if (response.status === 401) return { status: 'unauthenticated' };
  if (response.status === 403) return { status: 'forbidden' };
  if (!response.ok) return { status: 'unavailable', reason: 'server' };

  const body: unknown = await response.json().catch(() => null);
  const uid = (body as { uid?: unknown } | null)?.uid;
  // O UID confirmado precisa ser o do usuário desta sessão; qualquer divergência não libera o painel.
  if (typeof uid !== 'string' || uid !== user.uid) return { status: 'unavailable', reason: 'server' };
  return { status: 'authorized', uid };
}
