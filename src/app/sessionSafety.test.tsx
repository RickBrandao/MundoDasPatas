/**
 * TASK 06E (P1): o fim da sessão administrativa encerra as operações em andamento.
 * O abort impede novas requisições e descarta respostas tardias, mas NÃO desfaz no servidor
 * o que já foi gravado (cenário F): isso é conferido no próximo acesso.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCartStorage } from '../services/cartStorage';
import { createPublicStoreApi } from '../services/http/publicStoreApi';
import { createLocalStoreApi } from '../services/localStoreApi';
import { createMemoryStorage } from '../services/storage';
import { API, createFakeAuth, deferred, fakeUser, json } from '../test/fakeAuth';
import { createFakeBackend, type FakeBackend } from '../test/fakeBackend';
import { App } from './App';

const ACCOUNTS = () => ({
  'a@loja.test': { password: 'senha-a', user: fakeUser('admin-uid', 'a@loja.test') },
  'b@loja.test': { password: 'senha-b', user: fakeUser('admin-uid-b', 'b@loja.test') },
});

/** /admin/me devolve o UID do próprio token (`token-<uid>`); qualquer `admin-uid*` é administrador. */
const meFromToken = (token: string) =>
  token.startsWith('token-admin-uid')
    ? json(200, { uid: token.replace(/^token-/, '').replace(/-novo$/, '') })
    : json(403, { error: { code: 'forbidden', message: 'x' } });

function setup(hash = '#/admin/vendas') {
  const backend = createFakeBackend({ me: meFromToken }).install();
  const racoes = backend.seedCategory('Rações');
  const product = backend.seedProduct({ categoryId: racoes.id, name: 'Ração Sessão', stock: 5 });
  const accounts = ACCOUNTS();
  const auth = createFakeAuth({ initialUser: accounts['a@loja.test'].user, accounts });
  window.location.hash = hash;
  const storage = createMemoryStorage();
  render(<App api={createPublicStoreApi(API)} cartStorage={createCartStorage(storage)} adminAccess={auth.access} dataSource={{ kind: 'api', apiBaseUrl: API }} />);
  return { backend, product, auth, userA: accounts['a@loja.test'].user, user: userEvent.setup() };
}

const heading = (name: string) => screen.findByRole('heading', { level: 1, name }, { timeout: 4000 });
const salePosts = (b: FakeBackend) => b.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/admin/sales');
const callsAfter = (b: FakeBackend, n: number) => b.calls.slice(n);
const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

async function startSale(user: ReturnType<typeof userEvent.setup>, productId: string) {
  await user.click(screen.getAllByRole('button', { name: 'Registrar venda' })[0]);
  const dialog = await screen.findByRole('dialog', { name: 'Registrar venda' });
  await user.selectOptions(within(dialog).getByLabelText('Produto'), productId);
  await user.click(within(dialog).getByRole('button', { name: 'Adicionar' }));
  await user.click(within(dialog).getByRole('button', { name: 'Confirmar venda' }));
}

/** Sai pelo botão; se houver confirmação de operação pendente, confirma a saída. */
async function logout(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole('button', { name: 'Sair' })[0]);
  const confirm = screen.queryByRole('alertdialog');
  if (confirm) await user.click(within(confirm).getByRole('button', { name: 'Sair mesmo assim' }));
  expect(await heading('Entrar')).toBeInTheDocument();
}

afterEach(() => vi.unstubAllGlobals());

describe('fim da sessão administrativa com operações pendentes', () => {
  it('A — logout enquanto o ID Token é obtido: nenhum POST é enviado', async () => {
    const { backend, product, userA, user } = setup();
    expect(await heading('Vendas')).toBeInTheDocument();
    const token = deferred<string>();
    userA.getIdToken.mockImplementationOnce(() => token.promise);
    await startSale(user, product.id);
    await logout(user);
    await act(async () => token.resolve('token-admin-uid'));
    await pause(50);
    expect(salePosts(backend)).toHaveLength(0);
    expect(backend.db.sales).toHaveLength(0);
  });

  it('B — logout com o fetch pendente: sinal abortado e resposta tardia descartada', async () => {
    const { backend, product, user } = setup();
    expect(await heading('Vendas')).toBeInTheDocument();
    const held = backend.hold('POST', '/api/v1/admin/sales', { apply: 'before', ignoreAbort: true });
    await startSale(user, product.id);
    await held.arrived;
    await logout(user);
    expect(held.signal?.aborted).toBe(true);
    const before = backend.calls.length;
    await act(async () => held.release());
    await pause(50);
    // O servidor pode ter gravado (não se presume o contrário); a interface encerrada não reage.
    expect(screen.queryByText(/registrada\. Estoque atualizado/)).toBeNull();
    expect(callsAfter(backend, before).filter((c) => c.path.startsWith('/api/v1/admin/'))).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 1, name: 'Entrar' })).toBeInTheDocument();
  });

  it('C — logout durante a espera de nova tentativa: a segunda requisição não sai', async () => {
    const { backend, product, user } = setup();
    expect(await heading('Vendas')).toBeInTheDocument();
    backend.failNext('POST', '/api/v1/admin/sales', json(503, { error: { code: 'database_busy', message: 'x' } }));
    await startSale(user, product.id);
    await waitFor(() => expect(salePosts(backend)).toHaveLength(1));
    await logout(user);
    await pause(2500); // maior que as esperas entre tentativas (600 ms + 1800 ms)
    expect(salePosts(backend)).toHaveLength(1);
    expect(backend.db.sales).toHaveLength(0);
  });

  it('D — troca de usuário: a resposta antiga de A não afeta a sessão de B', async () => {
    const { backend, product, user } = setup();
    expect(await heading('Vendas')).toBeInTheDocument();
    const held = backend.hold('POST', '/api/v1/admin/sales', { apply: 'before', ignoreAbort: true });
    await startSale(user, product.id);
    await held.arrived;
    await logout(user);

    await user.type(screen.getByLabelText('E-mail'), 'b@loja.test');
    await user.type(screen.getByLabelText('Senha'), 'senha-b');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await heading('Vendas')).toBeInTheDocument();
    expect(screen.getByText('b@loja.test')).toBeInTheDocument();
    const before = backend.calls.length;

    await act(async () => held.release());
    await pause(50);
    expect(screen.queryByText(/registrada\. Estoque atualizado/)).toBeNull();
    // Nenhuma chamada da sessão antiga (token de A) depois da troca.
    expect(callsAfter(backend, before).filter((c) => c.token === 'token-admin-uid')).toHaveLength(0);
    expect(screen.getByText('b@loja.test')).toBeInTheDocument();
  });

  it('E — acesso revogado durante o uso: a sessão antiga não inicia novas operações', async () => {
    const { backend, product, user } = setup();
    expect(await heading('Vendas')).toBeInTheDocument();
    backend.setMe(() => json(403, { error: { code: 'forbidden', message: 'x' } }));
    backend.failNext('POST', '/api/v1/admin/sales', json(403, { error: { code: 'forbidden', message: 'x' } }));
    await startSale(user, product.id);
    expect(await heading('Acesso negado')).toBeInTheDocument();
    const before = backend.calls.length;
    await pause(2500);
    expect(callsAfter(backend, before).filter((c) => c.path.startsWith('/api/v1/admin/') && c.path !== '/api/v1/admin/me')).toHaveLength(0);
    expect(backend.db.sales).toHaveLength(0);
  });

  it('F — gravação já confirmada no servidor: sem rollback; avisa e reconcilia no próximo acesso', async () => {
    const { backend, product, user } = setup();
    expect(await heading('Vendas')).toBeInTheDocument();
    const held = backend.hold('POST', '/api/v1/admin/sales', { apply: 'after' });
    await startSale(user, product.id);
    await held.arrived;
    expect(backend.db.sales).toHaveLength(1); // gravada; a resposta ainda não chegou

    await user.click(screen.getAllByRole('button', { name: 'Sair' })[0]);
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/pode já ter sido registrada no servidor/);
    await user.click(within(confirm).getByRole('button', { name: 'Sair mesmo assim' }));
    expect(await heading('Entrar')).toBeInTheDocument();
    expect(screen.getByText(/pode ter sido concluída no servidor/)).toBeInTheDocument();
    expect(held.signal?.aborted).toBe(true);

    // Nada de compensação automática: nenhum cancelamento foi enviado e a venda continua lá.
    expect(backend.calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(0);
    expect(backend.db.sales).toHaveLength(1);

    // Próximo acesso: o estado vem do servidor (venda registrada, estoque 4).
    await user.type(screen.getByLabelText('E-mail'), 'a@loja.test');
    await user.type(screen.getByLabelText('Senha'), 'senha-a');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await heading('Vendas')).toBeInTheDocument();
    expect(await screen.findByText('Concluída')).toBeInTheDocument();
    expect(backend.db.products.find((p) => p.id === product.id)!.stock).toBe(4);
  });

  it('B2 — logout com cabeçalhos recebidos e corpo pendente: leitura cancelada, sem sucesso tardio', async () => {
    const { backend, product, user } = setup();
    expect(await heading('Vendas')).toBeInTheDocument();
    const held = backend.hold('POST', '/api/v1/admin/sales', { apply: 'body' });
    await startSale(user, product.id);
    await held.arrived; // venda gravada, cabeçalhos entregues, corpo em leitura
    expect(backend.db.sales).toHaveLength(1);
    expect(held.signal?.aborted).toBe(false);

    await logout(user);
    expect(held.signal?.aborted).toBe(true);
    const before = backend.calls.length;
    await act(async () => held.release());
    await pause(50);
    expect(screen.queryByText(/registrada\. Estoque atualizado/)).toBeNull();
    expect(callsAfter(backend, before).filter((c) => c.path.startsWith('/api/v1/admin/'))).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 1, name: 'Entrar' })).toBeInTheDocument();
    // Sem rollback: a venda gravada continua no servidor.
    expect(backend.calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(0);
    expect(backend.db.sales).toHaveLength(1);
  });

  it('G — demonstração continua local, sem login nem chamadas HTTP', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    window.location.hash = '#/admin/vendas';
    const storage = createMemoryStorage();
    render(<App api={createLocalStoreApi({ storage })} cartStorage={createCartStorage(storage)} adminAccess={{ mode: 'demo' }} />);
    expect(await heading('Vendas')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sair' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
