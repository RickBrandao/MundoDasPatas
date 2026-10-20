import { afterEach, describe, expect, it, vi } from 'vitest';
import { API, fakeUser, json } from '../../test/fakeAuth';
import { createAdminHttp, verifyAdmin } from './adminHttp';
import { signInErrorMessage } from './authClient';

const http = createAdminHttp(API);

function stubFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
    const next = responses.shift();
    if (!next) throw new Error('fetch inesperado');
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verificação administrativa (GET /admin/me)', () => {
  it('envia o ID Token do SDK no cabeçalho, sem cache e sem cookies', async () => {
    const fetchMock = stubFetch(json(200, { uid: 'admin-uid' }));
    const user = fakeUser();
    expect(await verifyAdmin(http, user)).toEqual({ status: 'authorized', uid: 'admin-uid' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/api/v1/admin/me');
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer token-admin-uid');
    expect(init!.cache).toBe('no-store');
    expect(init!.credentials).toBe('omit');
    expect(user.getIdToken).toHaveBeenCalledWith(false);
  });

  it('401 → renova o token uma vez e repete', async () => {
    const fetchMock = stubFetch(json(401, {}), json(200, { uid: 'admin-uid' }));
    const user = fakeUser();
    expect((await verifyAdmin(http, user)).status).toBe('authorized');
    expect(user.getIdToken).toHaveBeenLastCalledWith(true);
    expect(new Headers(fetchMock.mock.calls[1][1]!.headers).get('Authorization')).toBe('Bearer token-admin-uid-novo');
  });

  it('401 mesmo após renovar → sessão inválida', async () => {
    stubFetch(json(401, {}), json(401, {}));
    expect(await verifyAdmin(http, fakeUser())).toEqual({ status: 'unauthenticated' });
  });

  it('403 → sem permissão', async () => {
    stubFetch(json(403, { error: { code: 'forbidden' } }));
    expect(await verifyAdmin(http, fakeUser())).toEqual({ status: 'forbidden' });
  });

  it.each([503, 500, 404])('%i → indisponível (nunca autoriza)', async (status) => {
    stubFetch(json(status, {}));
    expect(await verifyAdmin(http, fakeUser())).toEqual({ status: 'unavailable', reason: 'server' });
  });

  it('falha de rede → indisponível', async () => {
    stubFetch(new TypeError('Failed to fetch'));
    expect(await verifyAdmin(http, fakeUser())).toEqual({ status: 'unavailable', reason: 'network' });
  });

  it('resposta 200 com UID de outro usuário ou corpo inválido não autoriza', async () => {
    stubFetch(json(200, { uid: 'outro' }), new Response('<html>', { status: 200 }));
    expect((await verifyAdmin(http, fakeUser())).status).toBe('unavailable');
    expect((await verifyAdmin(http, fakeUser())).status).toBe('unavailable');
  });

  it('sessão encerrada pelo Firebase ao renovar o token → sessão inválida, sem chamar a API', async () => {
    const fetchMock = stubFetch();
    const user = fakeUser();
    user.getIdToken.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/user-token-expired' }));
    expect(await verifyAdmin(http, user)).toEqual({ status: 'unauthenticated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sem rede ao obter o token → indisponível', async () => {
    stubFetch();
    const user = fakeUser();
    user.getIdToken.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/network-request-failed' }));
    expect(await verifyAdmin(http, user)).toEqual({ status: 'unavailable', reason: 'network' });
  });
});

describe('mensagens de login', () => {
  const err = (code: string) => Object.assign(new Error('Firebase: Error (interno).'), { code });

  it('não revelam se o e-mail existe nem detalhes internos', () => {
    expect(signInErrorMessage(err('auth/invalid-credential'))).toBe('E-mail ou senha incorretos.');
    expect(signInErrorMessage(err('auth/user-not-found'))).toBe('E-mail ou senha incorretos.');
    expect(signInErrorMessage(err('auth/wrong-password'))).toBe('E-mail ou senha incorretos.');
    expect(signInErrorMessage(err('auth/too-many-requests'))).toMatch(/Muitas tentativas/);
    expect(signInErrorMessage(err('auth/network-request-failed'))).toMatch(/Sem conexão/);
    expect(signInErrorMessage(err('auth/operation-not-allowed'))).toMatch(/não está configurado/);
    expect(signInErrorMessage(new Error('qualquer coisa'))).toBe('Não foi possível entrar agora. Tente novamente.');
    expect(signInErrorMessage(err('auth/desconhecido'))).not.toContain('auth/');
  });
});
