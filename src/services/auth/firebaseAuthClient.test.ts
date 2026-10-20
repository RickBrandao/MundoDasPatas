import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  apps: [] as { name: string }[],
  initializeApp: vi.fn(),
  initializeAuth: vi.fn(),
  getAuth: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
}));

vi.mock('firebase/app', () => ({
  getApps: () => sdk.apps,
  initializeApp: (config: unknown, name: string) => {
    sdk.initializeApp(config, name);
    const app = { name };
    sdk.apps.push(app);
    return app;
  },
}));
vi.mock('firebase/auth', () => ({
  browserSessionPersistence: { type: 'SESSION' },
  initializeAuth: (app: unknown, deps: unknown) => {
    sdk.initializeAuth(app, deps);
    return { app };
  },
  getAuth: (app: unknown) => {
    sdk.getAuth(app);
    return { app };
  },
  signInWithEmailAndPassword: (...args: unknown[]) => sdk.signInWithEmailAndPassword(...args),
  signOut: (...args: unknown[]) => sdk.signOut(...args),
  onAuthStateChanged: (...args: unknown[]) => sdk.onAuthStateChanged(...args),
}));

const { createFirebaseAuthClient } = await import('./firebaseAuthClient');

const config = { apiKey: 'k', authDomain: 'd', projectId: 'p', appId: 'a', messagingSenderId: 'm' };

describe('cliente Firebase Authentication', () => {
  it('inicializa uma vez, com persistência restrita à aba, e delega ao SDK', async () => {
    const client = createFirebaseAuthClient(config);
    expect(sdk.initializeApp).toHaveBeenCalledWith(config, 'mundo-das-patas-admin');
    expect(sdk.initializeAuth).toHaveBeenCalledWith(expect.anything(), { persistence: { type: 'SESSION' } });

    await client.signIn('dono@exemplo.com', 'senha');
    expect(sdk.signInWithEmailAndPassword).toHaveBeenCalledWith(expect.anything(), 'dono@exemplo.com', 'senha');
    await client.signOut();
    expect(sdk.signOut).toHaveBeenCalledTimes(1);

    // Recarregamento a quente: reaproveita a instância existente.
    createFirebaseAuthClient(config);
    expect(sdk.initializeApp).toHaveBeenCalledTimes(1);
    expect(sdk.getAuth).toHaveBeenCalledTimes(1);
  });

  it('propaga o erro do SDK com o código para a tela tratar', async () => {
    sdk.signInWithEmailAndPassword.mockRejectedValueOnce(Object.assign(new Error('Firebase: Error'), { code: 'auth/invalid-credential' }));
    const client = createFirebaseAuthClient(config);
    await expect(client.signIn('a@b.c', 'x')).rejects.toMatchObject({ code: 'auth/invalid-credential' });
  });
});
