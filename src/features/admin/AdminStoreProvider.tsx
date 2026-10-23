import { useMemo, type ReactNode } from 'react';
import { StoreProvider } from '../../app/StoreProvider';
import type { AuthUser } from '../../services/auth/authClient';
import { createAdminHttp } from '../../services/auth/adminHttp';
import { createAdminStoreApi } from '../../services/http/adminStoreApi';
import type { StoreApi } from '../../services/storeApi';
import { useAdminSession } from '../auth/adminSession';

/** Intervalo mínimo entre reconfirmações de acesso disparadas por 401/403 nos dados (evita ciclos). */
const RECHECK_COOLDOWN_MS = 30_000;
const lastRecheck = new WeakMap<AuthUser, number>();

function buildAdminApi(apiBaseUrl: string, user: AuthUser, recheck: () => void): StoreApi {
  const http = createAdminHttp(apiBaseUrl);
  return createAdminStoreApi({
    send: (path, init) => http.request(user, path, init),
    // Token recusado ou acesso revogado durante o uso: reconfirma a sessão (pode encerrar o painel).
    onAuthFailure: () => {
      const now = Date.now();
      if (now - (lastRecheck.get(user) ?? 0) < RECHECK_COOLDOWN_MS) return;
      lastRecheck.set(user, now);
      recheck();
    },
  });
}

/**
 * Dados do painel vindos da API administrativa. Só é montado dentro de `AdminGate`, ou seja,
 * depois de `GET /api/v1/admin/me` confirmar o acesso: nenhuma chamada administrativa acontece antes.
 *
 * Substitui o `StoreContext` da loja apenas dentro do painel; ao sair (logout, troca de usuário),
 * o provedor é desmontado e os dados administrativos deixam a memória da página.
 */
export function AdminStoreProvider({ apiBaseUrl, children }: { apiBaseUrl: string; children: ReactNode }) {
  const { session, retry } = useAdminSession();
  const user = session.status === 'authorized' ? session.user : null;
  const api = useMemo(() => (user ? buildAdminApi(apiBaseUrl, user, retry) : null), [apiBaseUrl, user, retry]);

  if (!api) return null;
  return <StoreProvider api={api}>{children}</StoreProvider>;
}
