import { vi } from 'vitest';
import type { AdminAccess } from '../services/auth/adminAccess';
import type { AuthClient, AuthUser } from '../services/auth/authClient';

export const API = 'http://api.test';

export interface FakeUser extends AuthUser {
  getIdToken: ReturnType<typeof vi.fn<(forceRefresh?: boolean) => Promise<string>>>;
}

export function fakeUser(uid = 'admin-uid', email: string | null = 'dono@exemplo.com'): FakeUser {
  return { uid, email, getIdToken: vi.fn(async (force?: boolean) => (force ? `token-${uid}-novo` : `token-${uid}`)) };
}

/**
 * Firebase Authentication simulado: sessão restaurada opcional, contas aceitas e eventos controlados.
 */
export function createFakeAuth(options: { initialUser?: FakeUser; accounts?: Record<string, { password: string; user: FakeUser }> } = {}) {
  let current: FakeUser | null = options.initialUser ?? null;
  const listeners = new Set<(u: AuthUser | null) => void>();
  const emit = (user: FakeUser | null) => {
    current = user;
    listeners.forEach((l) => l(user));
  };
  const client = {
    onAuthStateChanged: vi.fn((listener: (u: AuthUser | null) => void) => {
      listeners.add(listener);
      // Como o SDK: o estado inicial (sessão restaurada ou não) chega de forma assíncrona.
      queueMicrotask(() => {
        if (listeners.has(listener)) listener(current);
      });
      return () => {
        listeners.delete(listener);
      };
    }),
    signIn: vi.fn(async (email: string, password: string) => {
      const account = options.accounts?.[email];
      if (!account || account.password !== password) {
        throw Object.assign(new Error('Firebase: Error (auth/invalid-credential).'), { code: 'auth/invalid-credential' });
      }
      emit(account.user);
    }),
    signOut: vi.fn(async () => emit(null)),
  } satisfies AuthClient;
  const loadAuthClient = vi.fn(async (): Promise<AuthClient> => client);
  const access: AdminAccess = { mode: 'firebase', apiBaseUrl: API, loadAuthClient };
  return { client, access, loadAuthClient, emit };
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Promessa controlada pelo teste (respostas do servidor que chegam depois). */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
