import { describe, expect, it, vi } from 'vitest';
import { resolveAdminAccess, type AdminAuthEnv } from './adminAccess';
import type { AuthClient } from './authClient';

const FULL: AdminAuthEnv = {
  VITE_ADMIN_AUTH_MODE: 'firebase',
  VITE_API_BASE_URL: 'http://localhost:8000',
  VITE_FIREBASE_API_KEY: 'chave-publica',
  VITE_FIREBASE_AUTH_DOMAIN: 'exemplo.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'exemplo',
  VITE_FIREBASE_APP_ID: '1:123:web:abc',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '123',
};
const client = {} as AuthClient;

describe('modo de acesso ao painel', () => {
  it('sem variável ou "demo": demonstração, sem tocar no Firebase', () => {
    const factory = vi.fn(async () => client);
    expect(resolveAdminAccess({}, factory)).toEqual({ mode: 'demo' });
    expect(resolveAdminAccess({ VITE_ADMIN_AUTH_MODE: 'demo' }, factory)).toEqual({ mode: 'demo' });
    // Mesmo com a configuração do Firebase presente, a demonstração não a utiliza.
    expect(resolveAdminAccess({ ...FULL, VITE_ADMIN_AUTH_MODE: 'demo' }, factory)).toEqual({ mode: 'demo' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('valor desconhecido bloqueia em vez de cair na demonstração', () => {
    expect(resolveAdminAccess({ VITE_ADMIN_AUTH_MODE: 'producao' }).mode).toBe('misconfigured');
  });

  it('modo firebase com configuração incompleta bloqueia e cita só os nomes das variáveis', () => {
    const access = resolveAdminAccess({ VITE_ADMIN_AUTH_MODE: 'firebase', VITE_FIREBASE_API_KEY: 'valor-que-nao-aparece' }, async () => client);
    expect(access.mode).toBe('misconfigured');
    const problems = access.mode === 'misconfigured' ? access.problems.join(' ') : '';
    expect(problems).toContain('VITE_FIREBASE_PROJECT_ID');
    expect(problems).toContain('VITE_API_BASE_URL');
    expect(problems).not.toContain('VITE_FIREBASE_API_KEY');
    expect(problems).not.toContain('valor-que-nao-aparece');
  });

  it.each(['localhost:8000', 'http://localhost:8000/', 'ftp://api'])('URL da API inválida (%s) bloqueia', (url) => {
    expect(resolveAdminAccess({ ...FULL, VITE_API_BASE_URL: url }, async () => client).mode).toBe('misconfigured');
  });

  it('modo firebase sem fábrica do cliente bloqueia', () => {
    expect(resolveAdminAccess(FULL).mode).toBe('misconfigured');
  });

  it('modo firebase completo: inicializa o cliente sob demanda e uma única vez', async () => {
    const factory = vi.fn(async () => client);
    const access = resolveAdminAccess(FULL, factory);
    if (access.mode !== 'firebase') throw new Error('esperado modo firebase');
    expect(access.apiBaseUrl).toBe('http://localhost:8000');
    expect(factory).not.toHaveBeenCalled();
    await Promise.all([access.loadAuthClient(), access.loadAuthClient()]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({
      apiKey: 'chave-publica',
      authDomain: 'exemplo.firebaseapp.com',
      projectId: 'exemplo',
      appId: '1:123:web:abc',
      messagingSenderId: '123',
    });
  });

  it('falha ao carregar o SDK permite nova tentativa', async () => {
    const factory = vi.fn<() => Promise<AuthClient>>().mockRejectedValueOnce(new Error('rede')).mockResolvedValueOnce(client);
    const access = resolveAdminAccess(FULL, factory);
    if (access.mode !== 'firebase') throw new Error('esperado modo firebase');
    await expect(access.loadAuthClient()).rejects.toThrow('rede');
    await expect(access.loadAuthClient()).resolves.toBe(client);
  });
});
