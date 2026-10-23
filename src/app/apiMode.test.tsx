import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminAccess } from '../services/auth/adminAccess';
import { createCartStorage } from '../services/cartStorage';
import type { DataSource } from '../services/dataSource';
import { createPublicStoreApi } from '../services/http/publicStoreApi';
import { createLocalStoreApi } from '../services/localStoreApi';
import { createMemoryStorage } from '../services/storage';
import { API, createFakeAuth, fakeUser, json } from '../test/fakeAuth';
import { createFakeBackend, type FakeBackend } from '../test/fakeBackend';
import { App } from './App';

const ADMIN = fakeUser('admin-uid', 'dono@exemplo.com');
const API_SOURCE: DataSource = { kind: 'api', apiBaseUrl: API };

function renderApi(hash: string, options: { access?: AdminAccess; dataSource?: DataSource } = {}) {
  window.location.hash = hash;
  const storage = createMemoryStorage();
  const access = options.access ?? createFakeAuth({ initialUser: ADMIN }).access;
  const utils = render(
    <App api={createPublicStoreApi(API)} cartStorage={createCartStorage(storage)} adminAccess={access} dataSource={options.dataSource ?? API_SOURCE} />,
  );
  return { ...utils, storage, user: userEvent.setup() };
}

const catalog = () => within(document.getElementById('produtos')!);
const heading = (name: string) => screen.findByRole('heading', { level: 1, name }, { timeout: 3000 });
const dialog = (name: string) => screen.findByRole('dialog', { name });

function seedStore(backend: FakeBackend) {
  const racoes = backend.seedCategory('Rações');
  const bola = backend.seedProduct({ categoryId: racoes.id, name: 'Bola Real', stock: 4, minStock: 1 });
  backend.seedProduct({ categoryId: racoes.id, name: 'Produto Oculto', published: false });
  return { racoes, bola };
}

afterEach(() => vi.unstubAllGlobals());

describe('loja pública com a API', () => {
  it('banco vazio: catálogo vazio sem erro e sem nenhuma chamada administrativa', async () => {
    const backend = createFakeBackend().install();
    renderApi('#/');
    expect(await screen.findByRole('heading', { name: /Tudo para o bem-estar/ })).toBeInTheDocument();
    expect(screen.getByText('Nenhum produto encontrado')).toBeInTheDocument();
    expect(screen.getByText(/Em breve, novidades para o seu pet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(backend.calls.map((c) => c.path)).toEqual(['/api/v1/public/catalog']);
    expect(backend.calls[0].token).toBeNull();
  });

  it('exibe dados reais do servidor; produtos ocultos não chegam ao visitante', async () => {
    const backend = createFakeBackend().install();
    seedStore(backend);
    renderApi('#/');
    expect(await screen.findByRole('button', { name: 'Ver detalhes de Bola Real' })).toBeInTheDocument();
    expect(catalog().getByText('1 produto')).toBeInTheDocument();
    expect(screen.queryByText('Produto Oculto')).toBeNull();
    expect(backend.adminCalls()).toHaveLength(0);
  });

  it('falha do servidor: mostra erro (sem cair para os dados locais) e permite tentar de novo', async () => {
    const backend = createFakeBackend().install();
    seedStore(backend);
    backend.failNext('GET', '/api/v1/public/catalog', json(503, { error: { code: 'database_unavailable', message: 'detalhe interno' } }));
    const { user } = renderApi('#/');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível carregar o catálogo. Serviço temporariamente indisponível.');
    expect(alert).not.toHaveTextContent('detalhe interno');
    // Nenhum dado fictício da demonstração aparece.
    expect(screen.queryByText(/NutriPata/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('button', { name: 'Ver detalhes de Bola Real' })).toBeInTheDocument();
  });

  it('encomenda pelo WhatsApp não cria venda nem altera estoque', async () => {
    const backend = createFakeBackend().install();
    seedStore(backend);
    const { user } = renderApi('#/');
    await screen.findByRole('button', { name: 'Ver detalhes de Bola Real' });
    await user.click(catalog().getByRole('button', { name: /Adicionar/ }));
    await user.click(screen.getByRole('button', { name: 'Abrir encomenda (1 item)' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Sua encomenda' })).getByRole('button', { name: 'Encomendar pelo WhatsApp' }));
    expect(await dialog('Encomendar pelo WhatsApp')).toBeInTheDocument();
    expect(backend.writes()).toHaveLength(0);
    expect(backend.db.products.find((p) => p.name === 'Bola Real')!.stock).toBe(4);
  });
});

describe('painel com Firebase + API', () => {
  it('sem sessão: nenhuma chamada administrativa antes do login', async () => {
    const backend = createFakeBackend().install();
    renderApi('#/admin/produtos', { access: createFakeAuth().access });
    expect(await heading('Entrar')).toBeInTheDocument();
    expect(backend.adminCalls()).toHaveLength(0);
  });

  it('dados administrativos só são pedidos depois de /admin/me autorizar', async () => {
    const backend = createFakeBackend().install();
    renderApi('#/admin/visao-geral');
    expect(await heading('Visão geral')).toBeInTheDocument();
    const admin = backend.adminCalls();
    expect(admin[0].path).toBe('/api/v1/admin/me');
    expect(admin.slice(1).every((c) => c.token === 'token-admin-uid')).toBe(true);
    expect(admin.slice(1).map((c) => c.path.split('?')[0]).sort()).toEqual(
      ['/api/v1/admin/categories', '/api/v1/admin/dashboard', '/api/v1/admin/products', '/api/v1/admin/sales', '/api/v1/admin/settings', '/api/v1/admin/stock/movements'].sort(),
    );
  });

  it('usuário não autorizado não recebe nenhum dado administrativo', async () => {
    const backend = createFakeBackend().install();
    const intruso = fakeUser('intruso-uid', 'intruso@exemplo.com');
    renderApi('#/admin/vendas', { access: createFakeAuth({ initialUser: intruso }).access });
    expect(await heading('Acesso negado')).toBeInTheDocument();
    expect(backend.dataCalls()).toHaveLength(0);
  });

  it('banco vazio: painel zerado, aviso de categorias e sem restaurar demonstração', async () => {
    createFakeBackend().install();
    const { user } = renderApi('#/admin/visao-geral');
    expect(await heading('Visão geral')).toBeInTheDocument();
    expect(screen.getByText('Desenvolvimento · servidor')).toBeInTheDocument();
    expect(screen.getByText(/dados reais gravados no Cloud Firestore/)).toBeInTheDocument();
    expect(screen.getByText('Sem movimentações registradas.')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma venda registrada nos últimos 30 dias.')).toBeInTheDocument();
    await user.click(screen.getAllByRole('link', { name: 'Categorias' })[0]);
    expect(await screen.findByText('Nenhuma categoria cadastrada')).toBeInTheDocument();
    await user.click(screen.getAllByRole('link', { name: 'Configurações' })[0]);
    expect(screen.queryByRole('button', { name: 'Restaurar dados de demonstração' })).toBeNull();
  });

  it('fluxo completo: categoria → produto → entrada → venda → cancelamento → indicadores, persistindo após recarregar', async () => {
    const backend = createFakeBackend().install();
    const first = renderApi('#/admin/categorias');
    const { user } = first;
    expect(await heading('Categorias')).toBeInTheDocument();

    // Primeira categoria (banco vazio).
    await user.click(screen.getByRole('button', { name: 'Nova categoria' }));
    await user.type(within(await dialog('Nova categoria')).getByLabelText('Nome da categoria'), 'Rações');
    await user.click(within(screen.getByRole('dialog', { name: 'Nova categoria' })).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('Categoria criada.')).toBeInTheDocument();
    expect(backend.db.categories.map((c) => c.name)).toEqual(['Rações']);

    // Conflito 409 compreensível.
    await user.click(screen.getByRole('button', { name: 'Nova categoria' }));
    const dup = await dialog('Nova categoria');
    await user.type(within(dup).getByLabelText('Nome da categoria'), 'racoes');
    await user.click(within(dup).getByRole('button', { name: 'Salvar' }));
    expect(await within(dup).findByText('Já existe uma categoria com esse nome.')).toBeInTheDocument();
    await user.click(within(dup).getByRole('button', { name: 'Cancelar' }));

    // Primeiro produto, sem upload de foto disponível.
    await user.click(screen.getAllByRole('link', { name: 'Produtos' })[0]);
    await user.click(await screen.findByRole('button', { name: 'Novo produto' }));
    const form = await dialog('Novo produto');
    expect(within(form).queryByText('Escolher imagem')).toBeNull();
    expect(within(form).getByText(/envio de fotos ainda não está disponível/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Nome do produto *'), 'Ração Real 1 kg');
    await user.type(within(form).getByLabelText('Preço (R$)'), '39,90');
    await user.clear(within(form).getByLabelText('Quantidade inicial em estoque'));
    await user.type(within(form).getByLabelText('Quantidade inicial em estoque'), '3');
    await user.click(within(form).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Produto cadastrado e publicado no catálogo.')).toBeInTheDocument();
    const saved = backend.db.products[0];
    expect(saved).toMatchObject({ name: 'Ração Real 1 kg', priceCents: 3990, stock: 3, imageUrl: '' });

    // Edição.
    await user.click(screen.getByRole('button', { name: 'Ração Real 1 kg' }));
    const edit = await dialog('Editar produto');
    await user.clear(within(edit).getByLabelText('Estoque mínimo'));
    await user.type(within(edit).getByLabelText('Estoque mínimo'), '5');
    await user.click(within(edit).getByRole('button', { name: 'Salvar produto' }));
    expect(await screen.findByText('Alterações salvas.')).toBeInTheDocument();
    expect(backend.db.products[0].minStock).toBe(5);

    // Entrada de estoque.
    await user.click(screen.getAllByRole('link', { name: 'Estoque' })[0]);
    await user.click(await screen.findByRole('button', { name: /Entrada/ }));
    const mv = await dialog('Movimentar estoque');
    await user.type(within(mv).getByLabelText('Quantidade recebida'), '7');
    await user.click(within(mv).getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByText('Estoque atualizado: Ração Real 1 kg agora tem 10 un.')).toBeInTheDocument();
    expect(backend.calls.find((c) => c.path === '/api/v1/admin/stock/movements' && c.method === 'POST')?.idempotencyKey).toMatch(/^[0-9a-f-]{32,36}$/);

    // Venda (duplo clique registra uma única venda).
    await user.click(screen.getAllByRole('button', { name: 'Registrar venda' })[0]);
    const sale = await dialog('Registrar venda');
    await user.selectOptions(within(sale).getByLabelText('Produto'), saved.id);
    await user.clear(within(sale).getByLabelText('Qtd.'));
    await user.type(within(sale).getByLabelText('Qtd.'), '4');
    await user.click(within(sale).getByRole('button', { name: 'Adicionar' }));
    await user.dblClick(within(sale).getByRole('button', { name: 'Confirmar venda' }));
    expect(await screen.findByText(/^Venda #[0-9A-F]{8} registrada\. Estoque atualizado\.$/)).toBeInTheDocument();
    expect(backend.db.sales).toHaveLength(1);
    expect(backend.db.products[0].stock).toBe(6);

    // Indicadores do servidor.
    await user.click(screen.getAllByRole('link', { name: 'Visão geral' })[0]);
    const unitsMetric = (await screen.findByText('Unidades vendidas · 30 dias')).closest('.metric')!;
    expect(unitsMetric).toHaveTextContent('4');
    expect(unitsMetric).toHaveTextContent('1 venda concluída');

    // Cancelamento com estorno.
    await user.click(screen.getAllByRole('link', { name: 'Vendas' })[0]);
    await user.click(await screen.findByRole('button', { name: 'Cancelar e estornar' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancelar e estornar' }));
    expect(await screen.findByText(/^Venda #[0-9A-F]{8} cancelada\. Estoque estornado\.$/)).toBeInTheDocument();
    expect(backend.db.products[0].stock).toBe(10);
    expect(backend.db.sales[0].status).toBe('cancelada');

    // Recarregar a página: tudo vem do servidor, nada do navegador.
    first.unmount();
    expect(first.storage.getItem('mdp-react-demo-v1')).toBeNull();
    const reload = renderApi('#/admin/vendas');
    expect(await heading('Vendas')).toBeInTheDocument();
    expect(await screen.findByText('Cancelada')).toBeInTheDocument();
    await reload.user.click(screen.getAllByRole('link', { name: 'Estoque' })[0]);
    const row = (await screen.findByText('Ração Real 1 kg', { selector: '.stock-row__name' })).closest('.admin-row')!;
    expect(row.querySelector('.stock-row__num')).toHaveTextContent('10');
    expect(row).toHaveTextContent('mín. 5');
  }, 30_000);

  it('venda com 503 database_busy é repetida com a mesma chave sem duplicar', async () => {
    const backend = createFakeBackend().install();
    const { bola } = seedStore(backend);
    const { user } = renderApi('#/admin/vendas');
    expect(await heading('Vendas')).toBeInTheDocument();
    backend.failNext('POST', '/api/v1/admin/sales', json(503, { error: { code: 'database_busy', message: 'x' } }));
    await user.click(screen.getAllByRole('button', { name: 'Registrar venda' })[0]);
    const sale = await dialog('Registrar venda');
    await user.selectOptions(within(sale).getByLabelText('Produto'), bola.id);
    await user.click(within(sale).getByRole('button', { name: 'Adicionar' }));
    await user.click(within(sale).getByRole('button', { name: 'Confirmar venda' }));
    expect(await screen.findByText(/registrada\. Estoque atualizado\./, {}, { timeout: 5000 })).toBeInTheDocument();
    const posts = backend.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/admin/sales');
    expect(posts).toHaveLength(2);
    expect(posts[0].idempotencyKey).toBe(posts[1].idempotencyKey);
    expect(backend.db.sales).toHaveLength(1);
  });

  it('falha de rede persistente na venda: mensagem segura e nova tentativa usa a mesma chave', async () => {
    const backend = createFakeBackend().install();
    const { bola } = seedStore(backend);
    const { user } = renderApi('#/admin/vendas');
    expect(await heading('Vendas')).toBeInTheDocument();
    // Aplicada no servidor, mas todas as respostas se perdem (inclusive as repetições automáticas).
    for (let i = 0; i < 3; i++) backend.loseNextResponse('POST', '/api/v1/admin/sales');
    await user.click(screen.getAllByRole('button', { name: 'Registrar venda' })[0]);
    const sale = await dialog('Registrar venda');
    await user.selectOptions(within(sale).getByLabelText('Produto'), bola.id);
    await user.click(within(sale).getByRole('button', { name: 'Adicionar' }));
    await user.click(within(sale).getByRole('button', { name: 'Confirmar venda' }));
    expect(await within(sale).findByText(/não será registrada duas vezes/, {}, { timeout: 8000 })).toBeInTheDocument();

    await user.click(within(sale).getByRole('button', { name: 'Confirmar venda' }));
    expect(await screen.findByText(/registrada\. Estoque atualizado\./)).toBeInTheDocument();
    const keys = new Set(backend.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/admin/sales').map((c) => c.idempotencyKey));
    expect(keys.size).toBe(1);
    expect(backend.db.sales).toHaveLength(1);
    expect(backend.db.products.find((p) => p.id === bola.id)!.stock).toBe(3);
  }, 20_000);

  it('logout descarta os dados do painel e nenhuma chamada administrativa é feita depois', async () => {
    const backend = createFakeBackend().install();
    seedStore(backend);
    const { user } = renderApi('#/admin/produtos');
    expect(await screen.findByRole('button', { name: 'Bola Real' })).toBeInTheDocument();
    const before = backend.adminCalls().length;
    await user.click(screen.getAllByRole('button', { name: 'Sair' })[0]);
    expect(await heading('Entrar')).toBeInTheDocument();
    expect(screen.queryByText('Produto Oculto')).toBeNull();
    act(() => {
      window.location.hash = '#/admin/vendas';
    });
    await waitFor(() => expect(window.location.hash).toBe('#/admin/login'));
    expect(backend.adminCalls()).toHaveLength(before);
  });

  it('API com painel em modo demo é bloqueada (dados reais nunca ficam sem login)', async () => {
    const backend = createFakeBackend().install();
    renderApi('#/admin/visao-geral', { access: { mode: 'demo' } });
    expect(await heading('Painel indisponível')).toBeInTheDocument();
    expect(screen.getByText(/exige VITE_ADMIN_AUTH_MODE=firebase/)).toBeInTheDocument();
    expect(backend.adminCalls()).toHaveLength(0);
  });

  it('Firebase com dados locais é bloqueado (sem fallback para o navegador)', async () => {
    window.location.hash = '#/admin/visao-geral';
    const storage = createMemoryStorage();
    const { access, loadAuthClient } = createFakeAuth({ initialUser: ADMIN });
    render(<App api={createLocalStoreApi({ storage })} cartStorage={createCartStorage(storage)} adminAccess={access} dataSource={{ kind: 'local' }} />);
    expect(await heading('Painel indisponível')).toBeInTheDocument();
    expect(screen.getByText(/exige VITE_STORE_DATA_SOURCE=api/)).toBeInTheDocument();
    expect(loadAuthClient).not.toHaveBeenCalled();
  });

  it('origem de dados inválida bloqueia o painel', async () => {
    createFakeBackend().install();
    renderApi('#/admin/visao-geral', { dataSource: { kind: 'misconfigured', problems: ['VITE_STORE_DATA_SOURCE deve ser "local" ou "api".'] } });
    expect(await heading('Painel indisponível')).toBeInTheDocument();
    expect(screen.getByText('VITE_STORE_DATA_SOURCE deve ser "local" ou "api".')).toBeInTheDocument();
  });
});
