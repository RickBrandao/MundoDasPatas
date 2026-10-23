/**
 * Smoke test integrado: camada de dados do React (`createPublicStoreApi`, `createAdminStoreApi`,
 * `createAdminHttp`, `verifyAdmin`) → FastAPI real → Cloud Firestore **Emulator** + Auth Emulator.
 *
 * Proteções contra o banco real (o teste aborta antes de qualquer escrita se alguma falhar):
 * - o projeto precisa começar com `demo-` (projetos "demo" do Firebase não existem na nuvem);
 * - `GET /health` da API precisa informar `database.status = "emulator"`;
 * - os documentos gravados pela API são lidos diretamente no emulador, provando a conexão.
 *
 * Executar com `npm run test:e2e:emulator`: o runner sobe emuladores e API e define E2E_API_URL,
 * E2E_PROJECT_ID, FIRESTORE_EMULATOR_HOST e FIREBASE_AUTH_EMULATOR_HOST (todas obrigatórias, locais).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../services/auth/authClient';
import { createAdminHttp, verifyAdmin } from '../services/auth/adminHttp';
import { createAdminStoreApi } from '../services/http/adminStoreApi';
import { createPublicStoreApi } from '../services/http/publicStoreApi';
import type { StoreApi } from '../services/storeApi';

// Definidas por scripts/e2e-emulator.mjs (`npm run test:e2e:emulator`). Sem padrões: ausência aborta.
const API_URL = process.env.E2E_API_URL ?? '';
const PROJECT = process.env.E2E_PROJECT_ID ?? '';
const FIRESTORE = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '';
const LOOPBACK = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const ADMIN_UID = 'e2e-admin-uid';
const OTHER_UID = 'e2e-intruso-uid';

async function ensureUser(localId: string, email: string, password: string) {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, email, password }),
  });
  if (!r.ok && !(await r.text()).includes('DUPLICATE')) throw new Error(`Auth Emulator recusou o usuário ${localId}`);
}

/** Usuário autenticado no Auth Emulator (mesmo contrato do Firebase Web SDK usado pelo painel). */
async function signIn(uid: string, email: string, password: string): Promise<AuthUser> {
  const login = async () => {
    const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const body = (await r.json()) as { idToken?: string };
    if (!body.idToken) throw new Error('login no Auth Emulator falhou');
    return body.idToken;
  };
  let token = await login();
  return {
    uid,
    email,
    getIdToken: async (force) => {
      if (force) token = await login();
      return token;
    },
  };
}

const emulatorDocs = async (collection: string) => {
  const r = await fetch(`http://${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${collection}?pageSize=300`, {
    headers: { Authorization: 'Bearer owner' },
  });
  return ((await r.json()) as { documents?: { name: string }[] }).documents ?? [];
};

const adminApiFor = (user: AuthUser) => {
  const http = createAdminHttp(API_URL);
  return createAdminStoreApi({ send: (path, init) => http.request(user, path, init) });
};

let admin: AuthUser;
let api: StoreApi;

beforeAll(async () => {
  if (!PROJECT.startsWith('demo-')) throw new Error(`Projeto ${PROJECT || '(ausente)'} não é de emulação: abortado.`);
  if (!LOOPBACK.test(FIRESTORE) || !LOOPBACK.test(AUTH)) throw new Error('FIRESTORE_EMULATOR_HOST/FIREBASE_AUTH_EMULATOR_HOST ausentes ou fora da máquina local: abortado.');
  if (!LOOPBACK.test(new URL(API_URL || 'http://invalido').host)) throw new Error('E2E_API_URL ausente ou fora da máquina local: abortado.');
  const health = (await (await fetch(`${API_URL}/health`)).json()) as { dependencies: { database: { status: string } } };
  if (health.dependencies.database.status !== 'emulator') throw new Error('A API não está ligada ao Firestore Emulator: abortado.');
  // Banco do emulador limpo (somente o emulador aceita esta rota).
  const wipe = await fetch(`http://${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  expect(wipe.ok).toBe(true);
  await ensureUser(ADMIN_UID, 'admin@e2e.test', 'senha-e2e-123');
  await ensureUser(OTHER_UID, 'intruso@e2e.test', 'senha-e2e-456');
  admin = await signIn(ADMIN_UID, 'admin@e2e.test', 'senha-e2e-123');
  api = adminApiFor(admin);
});

describe('React → FastAPI → Firestore Emulator', () => {
  it('banco vazio: catálogo público vazio, painel zerado e nada gravado só por ler', async () => {
    const pub = await createPublicStoreApi(API_URL).load();
    expect(pub.data.products).toEqual([]);
    expect(pub.data.categories).toEqual([]);
    expect(pub.data.settings.storeName).toBe('Mundo das Patas');

    expect(await verifyAdmin(createAdminHttp(API_URL), admin)).toEqual({ status: 'authorized', uid: ADMIN_UID });
    const r = await api.load();
    expect(r.data).toMatchObject({ products: [], categories: [], sales: [], movements: [] });
    expect(r.dashboard?.catalog.active).toBe(0);
    expect(await emulatorDocs('settings')).toEqual([]);
  });

  it('usuário fora da lista de administradores não acessa nada', async () => {
    const intruso = await signIn(OTHER_UID, 'intruso@e2e.test', 'senha-e2e-456');
    expect(await verifyAdmin(createAdminHttp(API_URL), intruso)).toEqual({ status: 'forbidden' });
    await expect(adminApiFor(intruso).load()).rejects.toThrow(/403/);
  });

  it('cadastros, estoque, venda idempotente, cancelamento único, dashboard e persistência', async () => {
    const cat = await api.saveCategory({ id: null, name: 'Rações' });
    expect(cat.ok).toBe(true);
    const dup = await api.saveCategory({ id: null, name: 'RACOES' });
    expect(dup).toMatchObject({ ok: false, fieldErrors: { name: 'Já existe uma categoria com esse nome.' } });

    const categoryId = (cat.ok && cat.data.categories[0].id) as string;
    const created = await api.saveProduct({
      id: null,
      name: 'Ração E2E 1 kg',
      categoryId,
      brand: 'Teste',
      description: '',
      imageUrl: 'data:image/jpeg;base64,AAAA', // descartada pelo adaptador (sem upload nesta versão)
      price: '39,90',
      showPrice: true,
      stock: '3',
      minStock: '2',
      published: true,
      featured: false,
    });
    if (!created.ok) throw new Error(created.error);
    const pid = created.product.id;
    expect(created.product).toMatchObject({ priceCents: 3990, stock: 3, imageUrl: '' });
    expect(pid).toMatch(/^[0-9a-f]{32}$/);

    const flags = await api.patchProduct(pid, { featured: true });
    expect(flags.ok && flags.data.products[0].featured).toBe(true);

    const entry = await api.moveStock({ productId: pid, type: 'entrada', qty: '7', note: '' }, { idempotencyKey: 'e2e-move-0001' });
    expect(entry.ok && entry.product.stock).toBe(10);
    // Mesma chave e mesmo corpo (resposta perdida, nova tentativa): devolve o original, sem lançar de novo.
    const replay = await api.moveStock({ productId: pid, type: 'entrada', qty: '7', note: '' }, { idempotencyKey: 'e2e-move-0001' });
    expect(replay.ok && replay.product.stock).toBe(10);

    const items = [{ productId: pid, qty: 4 }];
    const sale = await api.registerSale(items, { idempotencyKey: 'e2e-sale-0001' });
    if (!sale.ok) throw new Error(sale.error);
    const again = await api.registerSale(items, { idempotencyKey: 'e2e-sale-0001' });
    expect(again.ok && again.sale.id).toBe(sale.sale.id);
    expect(await emulatorDocs('sales')).toHaveLength(1);

    const tooMuch = await api.registerSale([{ productId: pid, qty: 99 }], { idempotencyKey: 'e2e-sale-0002' });
    expect(tooMuch).toMatchObject({ ok: false, error: expect.stringMatching(/^Estoque insuficiente/) });

    const cancel = await api.cancelSale(sale.sale.id, { idempotencyKey: 'e2e-cancel-0001' });
    expect(cancel.ok).toBe(true);
    const cancelAgain = await api.cancelSale(sale.sale.id, { idempotencyKey: 'e2e-cancel-0002' });
    expect(cancelAgain.ok).toBe(false);

    const settings = await api.saveSettings({
      storeName: 'Mundo das Patas',
      whatsapp: '(11) 98888-7777',
      address: 'Rua E2E, 1',
      hours: '9h às 18h',
      about: 'Teste integrado',
      showOutOfStock: true,
      showFeatured: true,
    });
    expect(settings.ok).toBe(true);

    // "Recarregar a página": nova instância, tudo vem do servidor.
    const fresh = await adminApiFor(admin).load();
    const product = fresh.data.products.find((p) => p.id === pid)!;
    expect(product.stock).toBe(10);
    expect(fresh.data.sales[0]).toMatchObject({ id: sale.sale.id, status: 'cancelada' });
    expect(fresh.data.movements.map((m) => m.type).sort()).toEqual(['cadastro', 'entrada', 'estorno', 'venda']);
    expect(fresh.data.movements.reduce((a, m) => a + m.qty, 0)).toBe(product.stock);
    expect(fresh.dashboard?.catalog).toMatchObject({ active: 1, visible: 1 });
    expect(fresh.dashboard?.salesLast30Days).toEqual({ count: 0, units: 0 });

    const pub = await createPublicStoreApi(API_URL).load();
    expect(pub.data.products.map((p) => p.name)).toEqual(['Ração E2E 1 kg']);
    expect(pub.data.settings.whatsapp).toBe('(11) 98888-7777');
    expect(pub.data.sales).toEqual([]);

    // Os dados estão no emulador (prova de que a API não gravou em outro banco).
    expect((await emulatorDocs('products')).map((d) => d.name.split('/').pop())).toEqual([pid]);
    expect(await emulatorDocs('stock_movements')).toHaveLength(4);
    expect((await emulatorDocs('idempotency_keys')).length).toBeGreaterThanOrEqual(3);
  });

  it('duas vendas simultâneas do último item: apenas uma é registrada', async () => {
    const { data } = await api.load();
    const categoryId = data.categories[0].id;
    const p = await api.saveProduct({
      id: null, name: 'Último Item E2E', categoryId, brand: '', description: '', imageUrl: '', price: '', showPrice: false,
      stock: '1', minStock: '0', published: true, featured: false,
    });
    if (!p.ok) throw new Error(p.error);
    const [a, b] = await Promise.all([
      adminApiFor(admin).registerSale([{ productId: p.product.id, qty: 1 }], { idempotencyKey: 'e2e-race-a-0001' }),
      adminApiFor(admin).registerSale([{ productId: p.product.id, qty: 1 }], { idempotencyKey: 'e2e-race-b-0001' }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const after = await adminApiFor(admin).load();
    expect(after.data.products.find((x) => x.id === p.product.id)!.stock).toBe(0);
  });
});
