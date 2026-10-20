import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import type { AdminAccess } from '../../services/auth/adminAccess';
import { createCartStorage } from '../../services/cartStorage';
import { createLocalStoreApi } from '../../services/localStoreApi';
import { createMemoryStorage } from '../../services/storage';
import { createFakeAuth, deferred, fakeUser, json, type FakeUser } from '../../test/fakeAuth';

const ADMIN = fakeUser('admin-uid', 'dono@exemplo.com');
const INTRUSO = fakeUser('intruso-uid', 'intruso@exemplo.com');
const ACCOUNTS = {
  'dono@exemplo.com': { password: 'senha-correta', user: ADMIN },
  'intruso@exemplo.com': { password: 'senha-intruso', user: INTRUSO },
};

/** Backend simulado: /admin/me responde conforme o token (ou a função dada). */
function stubApi(handler: (token: string) => Promise<Response> | Response) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') ?? '';
    return handler(token);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const backendAllowlist = (token: string) =>
  token.startsWith('token-admin-uid') ? json(200, { uid: 'admin-uid' }) : json(403, { error: { code: 'forbidden' } });

function renderApp(hash: string, access: AdminAccess) {
  window.location.hash = hash;
  const storage = createMemoryStorage();
  render(<App api={createLocalStoreApi({ storage })} cartStorage={createCartStorage(storage)} adminAccess={access} />);
  return userEvent.setup();
}

const panelHeading = () => screen.queryByRole('heading', { level: 1, name: 'Visão geral' });

async function login(user: ReturnType<typeof userEvent.setup>, email: string, password: string) {
  await user.type(await screen.findByLabelText('E-mail'), email);
  await user.type(screen.getByLabelText('Senha'), password);
  await user.click(screen.getByRole('button', { name: 'Entrar' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('painel com Firebase Authentication', () => {
  it('acesso direto sem sessão leva ao login, sem mostrar o painel', async () => {
    const fetchMock = stubApi(backendAllowlist);
    const { access } = createFakeAuth();
    renderApp('#/admin/produtos', access);
    expect(await screen.findByRole('heading', { level: 1, name: 'Entrar' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/admin/login');
    expect(screen.queryByRole('heading', { level: 1, name: 'Produtos' })).toBeNull();
    expect(screen.getByLabelText('E-mail')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Senha')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('link', { name: 'Voltar à loja' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('login válido: carrega, confirma no servidor e volta à página pedida', async () => {
    const me = deferred<Response>();
    const fetchMock = stubApi(() => me.promise);
    const { access, client } = createFakeAuth({ accounts: ACCOUNTS });
    const user = renderApp('#/admin/produtos', access);

    await login(user, 'dono@exemplo.com', 'senha-correta');
    expect(client.signIn).toHaveBeenCalledWith('dono@exemplo.com', 'senha-correta');
    // Autenticado no Firebase, mas ainda sem a confirmação do servidor: o painel não aparece.
    expect(await screen.findByText('Confirmando sua permissão no servidor…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Produtos' })).toBeNull();

    me.resolve(json(200, { uid: 'admin-uid' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Produtos' })).toBeInTheDocument();
    expect(new Headers(fetchMock.mock.calls[0][1]!.headers).get('Authorization')).toBe('Bearer token-admin-uid');
    expect(screen.getByText(/dados demonstrativos armazenados neste navegador/)).toBeInTheDocument();
    expect(screen.queryByText('Demonstração · sem login')).toBeNull();
  });

  it('mostra o estado de carregamento enquanto o Firebase valida as credenciais', async () => {
    stubApi(backendAllowlist);
    const { access, client } = createFakeAuth({ accounts: ACCOUNTS });
    const pending = deferred<void>();
    client.signIn.mockImplementationOnce(() => pending.promise);
    const user = renderApp('#/admin/login', access);
    await login(user, 'dono@exemplo.com', 'senha-correta');
    const button = screen.getByRole('button', { name: 'Entrando…' });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText('Senha')).toBeDisabled();
    await act(async () => pending.reject(Object.assign(new Error('x'), { code: 'auth/network-request-failed' })));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sem conexão com o serviço de login');
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();
  });

  it('credenciais inválidas mostram mensagem genérica e não abrem o painel', async () => {
    const fetchMock = stubApi(backendAllowlist);
    const { access } = createFakeAuth({ accounts: ACCOUNTS });
    const user = renderApp('#/admin/login', access);
    await login(user, 'dono@exemplo.com', 'errada');
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.');
    expect(panelHeading()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('campos vazios não chamam o Firebase', async () => {
    stubApi(backendAllowlist);
    const { access, client } = createFakeAuth({ accounts: ACCOUNTS });
    const user = renderApp('#/admin/login', access);
    await user.click(await screen.findByRole('button', { name: 'Entrar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Informe e-mail e senha.');
    expect(client.signIn).not.toHaveBeenCalled();
  });

  it('sessão restaurada abre o painel sem pedir login e sem exibi-lo antes da confirmação', async () => {
    const me = deferred<Response>();
    stubApi(() => me.promise);
    const { access } = createFakeAuth({ initialUser: ADMIN });
    renderApp('#/admin/visao-geral', access);
    expect(await screen.findByText('Confirmando sua permissão no servidor…')).toBeInTheDocument();
    expect(panelHeading()).toBeNull();
    expect(screen.queryByLabelText('Senha')).toBeNull();
    me.resolve(json(200, { uid: 'admin-uid' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Visão geral' })).toBeInTheDocument();
  });

  it('UID não autorizado pelo backend recebe acesso negado e pode sair', async () => {
    stubApi(backendAllowlist);
    const { access, client } = createFakeAuth({ accounts: ACCOUNTS });
    const user = renderApp('#/admin/login', access);
    await login(user, 'intruso@exemplo.com', 'senha-intruso');
    expect(await screen.findByRole('heading', { level: 1, name: 'Acesso negado' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('intruso@exemplo.com não tem permissão');
    expect(panelHeading()).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Sair e entrar com outra conta' }));
    expect(client.signOut).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { level: 1, name: 'Entrar' })).toBeInTheDocument();
  });

  it.each([
    ['servidor indisponível (503)', () => json(503, { error: { code: 'service_unavailable' } }), 'O servidor não conseguiu confirmar'],
    [
      'falha de rede',
      () => {
        throw new TypeError('Failed to fetch');
      },
      'Não foi possível conectar ao servidor',
    ],
  ])('%s não libera o painel; "Tentar novamente" repete a verificação', async (_name, failure, message) => {
    let down = true;
    stubApi((token) => (down ? failure() : backendAllowlist(token)));
    const { access } = createFakeAuth({ initialUser: ADMIN });
    const user = renderApp('#/admin/visao-geral', access);
    expect(await screen.findByRole('heading', { level: 1, name: 'Acesso não confirmado' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(panelHeading()).toBeNull();

    down = false;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Visão geral' })).toBeInTheDocument();
  });

  it('token recusado pelo servidor encerra a sessão', async () => {
    stubApi(() => json(401, { error: { code: 'unauthorized' } }));
    const { access, client } = createFakeAuth({ initialUser: ADMIN });
    renderApp('#/admin/visao-geral', access);
    expect(await screen.findByText('Sua sessão expirou ou foi encerrada. Entre novamente.')).toBeInTheDocument();
    expect(client.signOut).toHaveBeenCalled();
    expect(panelHeading()).toBeNull();
  });

  it('logout encerra a sessão e bloqueia o acesso direto ao painel', async () => {
    stubApi(backendAllowlist);
    const { access, client } = createFakeAuth({ initialUser: ADMIN });
    const user = renderApp('#/admin/visao-geral', access);
    expect(await screen.findByRole('heading', { level: 1, name: 'Visão geral' })).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Sair' })[0]);
    expect(client.signOut).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Você saiu do painel.')).toBeInTheDocument();
    expect(panelHeading()).toBeNull();

    act(() => {
      window.location.hash = '#/admin/produtos';
    });
    // Espera o redirecionamento (a tela de login anterior é substituída pela nova).
    await waitFor(() => expect(window.location.hash).toBe('#/admin/login'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Entrar' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Produtos' })).toBeNull();
  });

  it('sessão encerrada pelo Firebase (expirada/revogada) fecha o painel', async () => {
    stubApi(backendAllowlist);
    const { access, emit } = createFakeAuth({ initialUser: ADMIN });
    renderApp('#/admin/visao-geral', access);
    expect(await screen.findByRole('heading', { level: 1, name: 'Visão geral' })).toBeInTheDocument();
    act(() => emit(null));
    expect(await screen.findByRole('heading', { level: 1, name: 'Entrar' })).toBeInTheDocument();
    expect(panelHeading()).toBeNull();
  });

  it('resposta antiga do servidor após logout é ignorada', async () => {
    const me = deferred<Response>();
    stubApi(() => me.promise);
    const { access, emit } = createFakeAuth({ initialUser: ADMIN });
    renderApp('#/admin/visao-geral', access);
    expect(await screen.findByText('Confirmando sua permissão no servidor…')).toBeInTheDocument();
    act(() => emit(null));
    expect(await screen.findByRole('heading', { level: 1, name: 'Entrar' })).toBeInTheDocument();
    await act(async () => me.resolve(json(200, { uid: 'admin-uid' })));
    expect(panelHeading()).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Entrar' })).toBeInTheDocument();
  });

  it('troca de usuário: a autorização do anterior não vale para o novo', async () => {
    const responses = new Map<string, ReturnType<typeof deferred<Response>>>();
    stubApi((token) => {
      const d = deferred<Response>();
      responses.set(token, d);
      return d.promise;
    });
    const { access, emit } = createFakeAuth({ initialUser: ADMIN });
    renderApp('#/admin/visao-geral', access);
    await waitFor(() => expect(responses.has('token-admin-uid')).toBe(true));
    act(() => emit(INTRUSO as FakeUser));
    await waitFor(() => expect(responses.has('token-intruso-uid')).toBe(true));

    // A resposta do administrador chega depois da troca: precisa ser descartada.
    await act(async () => responses.get('token-admin-uid')!.resolve(json(200, { uid: 'admin-uid' })));
    expect(panelHeading()).toBeNull();
    await act(async () => responses.get('token-intruso-uid')!.resolve(json(403, {})));
    expect(await screen.findByRole('heading', { level: 1, name: 'Acesso negado' })).toBeInTheDocument();
  });

  it('a loja pública continua acessível e não carrega o Firebase', async () => {
    const { access, loadAuthClient } = createFakeAuth();
    renderApp('#/', access);
    expect(await screen.findByRole('heading', { name: /Tudo para o bem-estar/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Painel$/ })).toBeInTheDocument();
    expect(loadAuthClient).not.toHaveBeenCalled();
  });

  it('falha ao carregar o SDK bloqueia o painel', async () => {
    const { access, loadAuthClient } = createFakeAuth();
    loadAuthClient.mockRejectedValue(new Error('rede'));
    renderApp('#/admin/visao-geral', access);
    expect(await screen.findByRole('heading', { level: 1, name: 'Login indisponível' })).toBeInTheDocument();
    expect(panelHeading()).toBeNull();
  });

  it('configuração incompleta bloqueia o painel (sem cair na demonstração)', async () => {
    renderApp('#/admin/visao-geral', { mode: 'misconfigured', problems: ['VITE_FIREBASE_PROJECT_ID não definida.'] });
    expect(await screen.findByRole('heading', { level: 1, name: 'Painel indisponível' })).toBeInTheDocument();
    expect(screen.getByText('VITE_FIREBASE_PROJECT_ID não definida.')).toBeInTheDocument();
    expect(panelHeading()).toBeNull();
  });
});
