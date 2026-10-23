import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API, json } from '../../test/fakeAuth';
import { createFakeBackend, type FakeBackend } from '../../test/fakeBackend';
import { createAdminStoreApi } from './adminStoreApi';
import { createIdempotencyKeys } from './idempotency';

let backend: FakeBackend;
const TOKEN = 'token-admin-uid';

function adminApi(options: Partial<Parameters<typeof createAdminStoreApi>[0]> = {}) {
  return createAdminStoreApi({
    send: (path, init) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${TOKEN}`);
      return fetch(`${API}${path}`, { ...init, headers });
    },
    sleep: async () => undefined,
    ...options,
  });
}

const product = (over: object = {}) => ({
  id: null,
  name: 'Ração Teste 1 kg',
  categoryId: backend.db.categories[0].id,
  brand: '',
  description: '',
  imageUrl: '',
  price: '49,90',
  showPrice: true,
  stock: '5',
  minStock: '2',
  published: true,
  featured: false,
  ...over,
});

beforeEach(() => {
  backend = createFakeBackend().install();
});
afterEach(() => vi.unstubAllGlobals());

describe('createAdminStoreApi (FastAPI simulado)', () => {
  it('banco vazio: carrega listas vazias e indicadores zerados', async () => {
    const r = await adminApi().load();
    expect(r.data).toMatchObject({ categories: [], products: [], sales: [], movements: [] });
    expect(r.data.settings.whatsapp).toBe('');
    expect(r.dashboard?.catalog.active).toBe(0);
    expect(r.dashboard?.salesLast30Days).toEqual({ count: 0, units: 0 });
    // Nada é gravado só por carregar (nem configurações padrão).
    expect(backend.writes()).toHaveLength(0);
    expect(backend.db.settings).toBeNull();
  });

  it('cadastro de categoria e produto: IDs e datas vêm do servidor; estado relido após gravar', async () => {
    const api = adminApi();
    await api.load();
    const c = await api.saveCategory({ id: null, name: 'Rações' });
    expect(c.ok && c.created).toBe(true);
    const p = await api.saveProduct(product());
    if (!p.ok) throw new Error(p.error);
    expect(p.product.id).toBe(backend.db.products[0].id);
    expect(p.product.stock).toBe(5);
    expect(p.data.movements[0]).toMatchObject({ type: 'cadastro', qty: 5 });
    expect(backend.calls.find((x) => x.method === 'POST' && x.path === '/api/v1/admin/products')?.body).toMatchObject({ priceCents: 4990, stock: 5 });
  });

  it('venda envia Idempotency-Key; a mesma chave após resposta perdida não duplica a venda', async () => {
    backend.seedCategory('Rações');
    const pid = backend.seedProduct({ categoryId: backend.db.categories[0].id, name: 'Ração', stock: 5 }).id;
    const api = adminApi({ retryDelaysMs: [] }); // sem repetição automática: simula a nova tentativa manual
    await api.load();
    const keys = createIdempotencyKeys();
    const items = [{ productId: pid, qty: 2 }];
    const intent = JSON.stringify(items);

    backend.loseNextResponse('POST', '/api/v1/admin/sales');
    const first = await api.registerSale(items, { idempotencyKey: keys.keyFor(intent) });
    expect(first.ok).toBe(false);
    expect(!first.ok && first.unknownOutcome).toBe(true);
    expect(!first.ok && first.error).toMatch(/tentar de novo com segurança/);

    const second = await api.registerSale(items, { idempotencyKey: keys.keyFor(intent) });
    expect(second.ok).toBe(true);
    const posts = backend.calls.filter((x) => x.method === 'POST' && x.path === '/api/v1/admin/sales');
    expect(posts).toHaveLength(2);
    expect(posts[0].idempotencyKey).toBe(posts[1].idempotencyKey);
    expect(backend.db.sales).toHaveLength(1);
    expect(backend.db.products[0].stock).toBe(3);
  });

  it('falha de rede e 503 database_busy: repete automaticamente com a mesma chave', async () => {
    backend.seedCategory('Rações');
    const pid = backend.seedProduct({ categoryId: backend.db.categories[0].id, name: 'Ração', stock: 5 }).id;
    const api = adminApi();
    await api.load();
    backend.failNext('POST', '/api/v1/admin/stock/movements', 'network');
    backend.failNext('POST', '/api/v1/admin/stock/movements', json(503, { error: { code: 'database_busy', message: 'x' } }));
    const r = await api.moveStock({ productId: pid, type: 'entrada', qty: '4', note: '' });
    expect(r.ok && r.product.stock).toBe(9);
    const posts = backend.calls.filter((x) => x.path === '/api/v1/admin/stock/movements' && x.method === 'POST');
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((x) => x.idempotencyKey)).size).toBe(1);
    expect(backend.db.movements.filter((m) => m.type === 'entrada')).toHaveLength(1);
  });

  it('cadastros não são repetidos automaticamente após falha de rede', async () => {
    backend.seedCategory('Rações');
    const api = adminApi();
    await api.load();
    backend.failNext('POST', '/api/v1/admin/products', 'network');
    const r = await api.saveProduct(product());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/confira a lista antes de repetir/);
    expect(backend.calls.filter((x) => x.method === 'POST' && x.path === '/api/v1/admin/products')).toHaveLength(1);
  });

  it('409 de categoria duplicada vem com o erro do campo e a lista relida', async () => {
    backend.seedCategory('Ração');
    const api = adminApi();
    await api.load();
    const r = await api.saveCategory({ id: null, name: 'RACAO' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.fieldErrors?.name).toBe('Já existe uma categoria com esse nome.');
    expect(!r.ok && r.refreshed?.data.categories).toHaveLength(1);
  });

  it('409 de estoque insuficiente não é repetido e relê o estado', async () => {
    backend.seedCategory('Rações');
    const pid = backend.seedProduct({ categoryId: backend.db.categories[0].id, name: 'Ração', stock: 1 }).id;
    const api = adminApi();
    await api.load();
    const r = await api.registerSale([{ productId: pid, qty: 3 }]);
    expect(r).toMatchObject({ ok: false, error: 'Estoque insuficiente.' });
    expect(backend.calls.filter((x) => x.path === '/api/v1/admin/sales' && x.method === 'POST')).toHaveLength(1);
  });

  it('422 do servidor é mapeado para os campos do formulário de produto', async () => {
    backend.seedCategory('Rações');
    const api = adminApi();
    await api.load();
    backend.failNext(
      'POST',
      '/api/v1/admin/products',
      json(422, { error: { code: 'validation_error', message: 'Revise os campos destacados.', fieldErrors: { priceCents: 'Input should be greater than 0' } } }),
    );
    const r = await api.saveProduct(product());
    expect(!r.ok && r.fieldErrors).toEqual({ price: 'Valor inválido.' });
  });

  it('cancelamento estorna uma única vez; repetir com a mesma chave devolve o mesmo resultado', async () => {
    backend.seedCategory('Rações');
    const pid = backend.seedProduct({ categoryId: backend.db.categories[0].id, name: 'Ração', stock: 5 }).id;
    const api = adminApi();
    await api.load();
    const sale = await api.registerSale([{ productId: pid, qty: 2 }]);
    if (!sale.ok) throw new Error(sale.error);
    backend.loseNextResponse('POST', `/api/v1/admin/sales/${sale.sale.id}/cancel`);
    const r = await api.cancelSale(sale.sale.id, { idempotencyKey: 'cancel-key-1' });
    // A primeira resposta se perdeu; a repetição automática (mesma chave) recebe o snapshot.
    expect(r.ok).toBe(true);
    expect(backend.db.products[0].stock).toBe(5);
    expect(backend.db.movements.filter((m) => m.type === 'estorno')).toHaveLength(1);
    const again = await api.cancelSale(sale.sale.id, { idempotencyKey: 'outra-chave-2' });
    expect(again).toMatchObject({ ok: false });
    expect(backend.db.products[0].stock).toBe(5);
  });

  it('escrita confirmada com releitura falhando: aplica a resposta e sinaliza stale', async () => {
    backend.seedCategory('Rações');
    const api = adminApi();
    await api.load();
    backend.failNext('GET', '/api/v1/admin/products', 'network');
    const r = await api.saveProduct(product());
    expect(r.ok && r.stale).toBe(true);
    expect(r.ok && r.data.products).toHaveLength(1);
  });

  it('401/403 nos dados pede a reconfirmação da sessão', async () => {
    const onAuthFailure = vi.fn();
    backend.failNext('GET', '/api/v1/admin/products', json(401, { error: { code: 'unauthorized', message: 'x' } }));
    await expect(adminApi({ onAuthFailure }).load()).rejects.toThrow();
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it('configurações: validação local, PUT completo e nunca restaura a demonstração', async () => {
    const api = adminApi();
    const { data } = await api.load();
    const bad = await api.saveSettings({ ...data.settings, whatsapp: '123' });
    expect(!bad.ok && bad.fieldErrors?.whatsapp).toBeTruthy();
    expect(backend.writes()).toHaveLength(0);
    const ok = await api.saveSettings({ ...data.settings, whatsapp: '(11) 98888-7777', about: ' Loja ' });
    expect(ok.ok && ok.data.settings).toMatchObject({ whatsapp: '(11) 98888-7777', about: 'Loja' });
    expect((await api.resetDemo()).ok).toBe(false);
  });
});
