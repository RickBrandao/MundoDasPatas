import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdminAccess } from '../../services/auth/adminAccess';
import { createAdminHttp, verifyAdmin } from '../../services/auth/adminHttp';
import { signInErrorMessage, type AuthClient, type AuthUser } from '../../services/auth/authClient';
import { AdminSessionContext, type AdminSession, type AdminSessionValue } from './adminSession';

/** Ao voltar para a aba depois desse intervalo, o acesso é confirmado de novo no servidor. */
const RECHECK_AFTER_MS = 5 * 60_000;

const MSG = {
  loggedOut: 'Você saiu do painel.',
  expired: 'Sua sessão expirou ou foi encerrada. Entre novamente.',
  signOutFailed: 'Não foi possível encerrar a sessão por completo. Feche esta aba do navegador.',
  network: 'Não foi possível conectar ao servidor para confirmar seu acesso. Verifique a conexão e tente novamente.',
  server: 'O servidor não conseguiu confirmar seu acesso agora. Tente novamente em instantes.',
  loadFailed: 'Não foi possível carregar o serviço de login. Verifique a conexão e recarregue a página.',
  notReady: 'O serviço de login ainda está carregando. Tente novamente em instantes.',
  pendingWrites:
    'Uma operação estava em andamento quando a sessão foi encerrada: ela pode ter sido concluída no servidor. Confira Vendas e Estoque no próximo acesso.',
};

interface Props {
  access: Extract<AdminAccess, { mode: 'firebase' }>;
  children: ReactNode;
}

/**
 * Sessão administrativa: observa o Firebase Authentication e confirma cada usuário em
 * `GET /api/v1/admin/me` antes de liberar o painel.
 *
 * Corridas: cada verificação tem um `AbortController`; logout, troca de usuário, nova verificação
 * ou desmontagem cancelam a anterior, e respostas de um usuário que não é mais o atual são descartadas.
 *
 * Ciclo de vida da sessão (TASK 06E): cada autorização abre um escopo com um `AbortController` novo,
 * entregue ao painel em `session.signal`. Logout, expiração, revogação, troca de usuário, nova
 * verificação (não silenciosa) e desmontagem abortam o escopo: requisições administrativas ainda não
 * enviadas não saem, as em andamento são canceladas, esperas de nova tentativa terminam e respostas
 * tardias são descartadas. Um escopo abortado nunca é reutilizado.
 *
 * Limite: abortar não desfaz no servidor o que já foi gravado. Se havia gravação em andamento,
 * o aviso de saída pede que o resultado seja conferido no próximo acesso.
 */
export function AdminAuthProvider({ access, children }: Props) {
  const [session, setSession] = useState<AdminSession>({ status: 'starting' });
  const clientRef = useRef<AuthClient | null>(null);
  const userRef = useRef<AuthUser | null>(null);
  const pendingRef = useRef<AbortController | null>(null);
  const verifiedAtRef = useRef(0);
  const scopeRef = useRef<{ user: AuthUser; controller: AbortController } | null>(null);
  const pendingWritesRef = useRef(0);
  const http = useMemo(() => createAdminHttp(access.apiBaseUrl), [access.apiBaseUrl]);

  const cancelPending = useCallback(() => {
    pendingRef.current?.abort();
    pendingRef.current = null;
  }, []);

  /** Encerra o escopo da sessão: toda operação administrativa ligada a ele é cancelada. */
  const closeScope = useCallback(() => {
    scopeRef.current?.controller.abort();
    scopeRef.current = null;
  }, []);

  /** Mesmo usuário já autorizado (revalidação silenciosa) mantém o escopo; caso contrário, abre um novo. */
  const openScope = useCallback(
    (user: AuthUser) => {
      const current = scopeRef.current;
      if (current && current.user === user && !current.controller.signal.aborted) return current.controller.signal;
      closeScope();
      const controller = new AbortController();
      scopeRef.current = { user, controller };
      return controller.signal;
    },
    [closeScope],
  );

  const endSession = useCallback(
    async (notice: string | null) => {
      // A interface é limpa antes de aguardar o Firebase: nada do painel continua visível.
      cancelPending();
      closeScope();
      const pending = pendingWritesRef.current > 0;
      pendingWritesRef.current = 0;
      userRef.current = null;
      setSession({ status: 'signedOut', notice: pending && notice ? `${notice} ${MSG.pendingWrites}` : notice });
      try {
        await clientRef.current?.signOut();
      } catch {
        setSession({ status: 'signedOut', notice: MSG.signOutFailed });
      }
    },
    [cancelPending, closeScope],
  );

  const verify = useCallback(
    (user: AuthUser, background = false) => {
      cancelPending();
      const controller = new AbortController();
      pendingRef.current = controller;
      if (!background) {
        // O painel sai da tela durante a verificação: as operações da sessão anterior terminam aqui.
        closeScope();
        setSession({ status: 'verifying', user });
      }
      void verifyAdmin(http, user, controller.signal).then((result) => {
        if (controller.signal.aborted || userRef.current !== user) return;
        pendingRef.current = null;
        switch (result.status) {
          case 'authorized':
            verifiedAtRef.current = Date.now();
            setSession({ status: 'authorized', user, signal: openScope(user) });
            return;
          case 'forbidden':
            closeScope();
            setSession({ status: 'forbidden', user });
            return;
          case 'unauthenticated':
            void endSession(MSG.expired);
            return;
          case 'unavailable':
            // Revalidação em segundo plano com o painel já aberto: uma falha temporária não o fecha.
            // Na verificação inicial, o painel continua bloqueado.
            if (!background) setSession({ status: 'unavailable', user, message: result.reason === 'network' ? MSG.network : MSG.server });
            return;
        }
      });
    },
    [http, cancelPending, endSession, openScope, closeScope],
  );

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    access.loadAuthClient().then(
      (client) => {
        if (!active) return;
        clientRef.current = client;
        unsubscribe = client.onAuthStateChanged((user) => {
          if (!active) return;
          userRef.current = user;
          if (user) {
            verify(user);
          } else {
            cancelPending();
            closeScope();
            setSession((s) => (s.status === 'signedOut' ? s : { status: 'signedOut', notice: null }));
          }
        });
      },
      () => {
        if (active) setSession({ status: 'failed', message: MSG.loadFailed });
      },
    );
    return () => {
      active = false;
      unsubscribe?.();
      cancelPending();
      closeScope();
    };
  }, [access, verify, cancelPending, closeScope]);

  // Sessão revogada ou administrador removido enquanto o painel estava aberto.
  useEffect(() => {
    if (session.status !== 'authorized') return;
    const { user } = session;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - verifiedAtRef.current > RECHECK_AFTER_MS) verify(user, true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [session, verify]);

  // Estável: o painel (AdminStoreProvider) a usa sem ser recriado a cada atualização da sessão.
  const retry = useCallback(() => {
    if (userRef.current) verify(userRef.current);
  }, [verify]);

  /** Gravações em andamento no painel (para o aviso de saída). */
  const reportPendingWrites = useCallback((count: number) => {
    pendingWritesRef.current = count;
  }, []);

  const value = useMemo<AdminSessionValue>(
    () => ({
      session,
      signIn: async (email, password) => {
        const client = clientRef.current;
        if (!client) return { ok: false, message: MSG.notReady };
        try {
          await client.signIn(email, password);
          return { ok: true };
        } catch (error) {
          return { ok: false, message: signInErrorMessage(error) };
        }
      },
      signOut: () => endSession(MSG.loggedOut),
      retry,
      reportPendingWrites,
    }),
    [session, endSession, retry, reportPendingWrites],
  );

  return <AdminSessionContext.Provider value={value}>{children}</AdminSessionContext.Provider>;
}
