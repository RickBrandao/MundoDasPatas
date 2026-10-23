import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { ConfirmContext, ToastContext, useConfirm, useStore, useToast, type ConfirmFn, type ToastFn } from '../../app/contexts';
import { StoreProvider } from '../../app/StoreProvider';
import type { AuthUser } from '../../services/auth/authClient';
import { createAdminHttp } from '../../services/auth/adminHttp';
import { createAdminStoreApi } from '../../services/http/adminStoreApi';
import type { StoreApi } from '../../services/storeApi';
import { useAdminSession } from '../auth/adminSession';

/** Intervalo mínimo entre reconfirmações de acesso disparadas por 401/403 nos dados (evita ciclos). */
const RECHECK_COOLDOWN_MS = 30_000;
const lastRecheck = new WeakMap<AuthUser, number>();

function buildAdminApi(apiBaseUrl: string, user: AuthUser, signal: AbortSignal, recheck: () => void): StoreApi {
  const http = createAdminHttp(apiBaseUrl);
  return createAdminStoreApi({
    send: (path, init) => http.request(user, path, init),
    signal,
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
 * Tudo fica preso ao escopo da sessão (`session.signal`): quando ela termina, a API para de enviar,
 * cancela o que está em andamento e descarta respostas tardias; mensagens e confirmações abertas
 * pelo painel também deixam de aparecer. Uma nova sessão recebe um escopo novo (nova API).
 */
export function AdminStoreProvider({ apiBaseUrl, children }: { apiBaseUrl: string; children: ReactNode }) {
  const { session, retry } = useAdminSession();
  const user = session.status === 'authorized' ? session.user : null;
  const signal = session.status === 'authorized' ? session.signal : null;
  const api = useMemo(() => (user && signal ? buildAdminApi(apiBaseUrl, user, signal, retry) : null), [apiBaseUrl, user, signal, retry]);

  if (!api || !signal) return null;
  return (
    <SessionFeedback signal={signal}>
      <StoreProvider api={api}>
        <PendingWritesReporter />
        {children}
      </StoreProvider>
    </SessionFeedback>
  );
}

/** Toast e confirmação do painel: depois do fim da sessão, nenhuma mensagem tardia aparece e diálogos fecham. */
function SessionFeedback({ signal, children }: { signal: AbortSignal; children: ReactNode }) {
  const toast = useToast();
  const confirm = useConfirm();
  const scopedToast = useCallback<ToastFn>((message) => {
    if (!signal.aborted) toast(message);
  }, [signal, toast]);
  const scopedConfirm = useCallback<ConfirmFn>((o) => confirm({ ...o, signal }), [signal, confirm]);
  return (
    <ToastContext.Provider value={scopedToast}>
      <ConfirmContext.Provider value={scopedConfirm}>{children}</ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}

/** Informa à sessão quantas gravações estão sem resposta (aviso ao sair). */
function PendingWritesReporter() {
  const { pendingWrites } = useStore();
  const { reportPendingWrites } = useAdminSession();
  useEffect(() => {
    reportPendingWrites(pendingWrites);
  }, [pendingWrites, reportPendingWrites]);
  return null;
}
