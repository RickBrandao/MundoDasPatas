import { vi } from 'vitest';
import { normalizeText } from '../domain/format';
import { API, json } from './fakeAuth';

/**
 * FastAPI simulado em memória para os testes do frontend: mesmas rotas, formatos (camelCase,
 * datas ISO 8601), erros (`{"error": {...}}`) e regras essenciais do backend real — autorização
 * por token, unicidade de categorias, estoque transacional, idempotência e estorno único.
 *
 * Falhas controladas: `failNext` (resposta ou falha de rede antes de aplicar) e `loseNextResponse`
 * (aplica a operação e "perde" a resposta, como uma queda de conexão depois do commit).
 */
export interface Call {
  method: string;
  path: string;
  token: string | null;
  idempotencyKey: string | null;
  body: unknown;
}

interface Category {
  id: string;
  name: string;
  icon: string;
  active: boolean;
}
interface Product {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  brand: string;
  imageUrl: string;
  priceCents: number | null;
  showPrice: boolean;
  stock: number;
  minStock: number;
  published: boolean;
  featured: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
interface Movement {
  id: string;
  productId: string;
  type: string;
  qty: number;
  createdAt: string;
  note: string;
  origin: string;
  actorUid: string | null;
}
interface Sale {
  id: string;
  items: { productId: string; qty: number }[];
  status: 'concluida' | 'cancelada';
  createdAt: string;
  createdBy: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
}
type Settings = Record<'storeName' | 'whatsapp' | 'address' | 'hours' | 'about', string> & { showOutOfStock: boolean; showFeatured: boolean };

const DEFAULT_SETTINGS: Settings = {
  storeName: 'Mundo das Patas',
  whatsapp: '',
  address: '',
  hours: '',
  about: '',
  showOutOfStock: true,
  showFeatured: true,
};

type Failure = Response | 'network';
type Handler = (token: string) => Response | Promise<Response>;

const err = (status: number, code: string, message: string, fieldErrors?: Record<string, string>) =>
  json(status, { error: { code, message, ...(fieldErrors && { fieldErrors }) } });

export const allowAdmin: Handler = (token) =>
  token.startsWith('token-admin-uid') ? json(200, { uid: 'admin-uid' }) : err(403, 'forbidden', 'Você não tem permissão para esta operação.');

export function createFakeBackend(options: { me?: Handler } = {}) {
  let seq = 0;
  let clock = Date.parse('2026-10-23T12:00:00Z');
  const newId = () => `${(++seq).toString(16).padStart(8, '0')}${'a'.repeat(24)}`;
  const now = () => new Date((clock += 1000)).toISOString();

  const db = {
    categories: [] as Category[],
    products: [] as Product[],
    movements: [] as Movement[],
    sales: [] as Sale[],
    settings: null as Settings | null,
    idempotency: new Map<string, { hash: string; status: number; body: unknown }>(),
  };
  const calls: Call[] = [];
  const failures: { method: string; path: string; failure: Failure }[] = [];
  const lost: { method: string; path: string }[] = [];
  let me = options.me ?? allowAdmin;

  const settings = () => db.settings ?? DEFAULT_SETTINGS;
  const activeIds = () => new Set(db.categories.filter((c) => c.active).map((c) => c.id));
  const visible = (p: Product) => p.published && !p.archived && activeIds().has(p.categoryId) && (settings().showOutOfStock || p.stock > 0);
  const status = (p: Product) => (p.stock <= 0 ? 'out' : p.stock <= p.minStock ? 'low' : 'ok');
  const adminProduct = (p: Product) => ({ ...p, stockStatus: status(p) });
  const nameTaken = (name: string, exceptId: string | null) =>
    db.categories.some((c) => c.id !== exceptId && normalizeText(c.name) === normalizeText(name));

  function move(p: Product, type: string, qty: number, note: string, origin: string, actor: string): Movement {
    p.stock += qty;
    p.updatedAt = now();
    const m = { id: newId(), productId: p.id, type, qty, createdAt: now(), note, origin, actorUid: actor };
    db.movements.unshift(m);
    return m;
  }

  /** Idempotência: mesma chave + mesmo corpo devolve o snapshot; outro corpo, 409. */
  function idempotent(op: string, key: string | null, payload: unknown, run: () => { status: number; body: unknown } | Response): Response {
    if (!key) return err(422, 'validation_error', 'Revise os campos destacados.', { 'Idempotency-Key': 'Field required' });
    const id = `${op}:${key}`;
    const hash = JSON.stringify(payload);
    const previous = db.idempotency.get(id);
    if (previous) {
      if (previous.hash !== hash) return err(409, 'idempotency_key_reused', 'Esta chave de idempotência já foi usada com outros dados.');
      return new Response(JSON.stringify(previous.body), { status: previous.status, headers: { 'Content-Type': 'application/json', 'Idempotent-Replayed': 'true' } });
    }
    const r = run();
    if (r instanceof Response) return r;
    db.idempotency.set(id, { hash, ...r });
    return json(r.status, r.body);
  }

  function route(method: string, path: string, token: string | null, key: string | null, body: Record<string, unknown>): Response | Promise<Response> {
    const url = new URL(path, API);
    const p = url.pathname;

    if (p === '/api/v1/public/catalog' && method === 'GET') {
      const s = settings();
      return json(200, {
        store: { storeName: s.storeName, whatsapp: s.whatsapp, address: s.address, hours: s.hours, about: s.about, showFeatured: s.showFeatured },
        categories: db.categories.filter((c) => c.active).map(({ id, name, icon }) => ({ id, name, icon })),
        products: db.products.filter(visible).map((x) => ({
          id: x.id,
          name: x.name,
          description: x.description,
          categoryId: x.categoryId,
          brand: x.brand,
          imageUrl: x.imageUrl,
          priceCents: x.showPrice ? x.priceCents : null,
          featured: x.featured,
          stock: Math.max(x.stock, 0),
          stockStatus: status(x),
        })),
      });
    }

    if (!p.startsWith('/api/v1/admin/')) return err(404, 'not_found', 'Recurso não encontrado.');
    if (!token) return err(401, 'unauthorized', 'Autenticação necessária.');
    if (p === '/api/v1/admin/me') return me(token);
    if (!token.startsWith('token-admin-uid')) return err(403, 'forbidden', 'Você não tem permissão para esta operação.');
    const actor = 'admin-uid';
    const sub = p.slice('/api/v1/admin'.length);
    const limit = Number(url.searchParams.get('limit') ?? 100);

    if (method === 'GET') {
      if (sub === '/products') return json(200, db.products.map(adminProduct));
      if (sub === '/categories') return json(200, db.categories);
      if (sub === '/sales') return json(200, db.sales.slice(0, limit));
      if (sub === '/stock/movements') return json(200, db.movements.slice(0, limit));
      if (sub === '/settings') return json(200, settings());
      if (sub === '/dashboard') {
        const act = db.products.filter((x) => !x.archived);
        const pub = act.filter((x) => x.published);
        const done = db.sales.filter((s) => s.status === 'concluida');
        const units = done.reduce((a, s) => a + s.items.reduce((b, i) => b + i.qty, 0), 0);
        const count = (st: string) => act.filter((x) => status(x) === st).length;
        return json(200, {
          catalog: {
            active: act.length,
            visible: act.filter(visible).length,
            published: pub.length,
            notPublished: act.length - pub.length,
            hiddenByCategory: pub.filter((x) => !activeIds().has(x.categoryId)).length,
            hiddenOutOfStock: pub.filter((x) => activeIds().has(x.categoryId) && !settings().showOutOfStock && x.stock <= 0).length,
            inactiveCategories: db.categories.filter((c) => !c.active).length,
            ok: count('ok'),
            low: count('low'),
            out: count('out'),
          },
          salesLast7Days: { count: done.length, units },
          salesLast30Days: { count: done.length, units },
          lowStock: [],
        });
      }
    }

    if (sub === '/categories' && method === 'POST') {
      const name = String(body.name ?? '').trim();
      if (name.length < 2) return err(422, 'validation_error', 'Revise os campos destacados.', { name: 'String should have at least 2 characters' });
      if (nameTaken(name, null)) return err(409, 'conflict', 'Já existe uma categoria com esse nome.', { name: 'Já existe uma categoria com esse nome.' });
      const c = { id: newId(), name, icon: 'label', active: true };
      db.categories.push(c);
      return json(201, c);
    }
    const catMatch = /^\/categories\/([^/]+)$/.exec(sub);
    if (catMatch && method === 'PATCH') {
      const c = db.categories.find((x) => x.id === catMatch[1]);
      if (!c) return err(404, 'not_found', 'Categoria não encontrada.');
      if (typeof body.name === 'string' && nameTaken(body.name, c.id)) {
        return err(409, 'conflict', 'Já existe uma categoria com esse nome.', { name: 'Já existe uma categoria com esse nome.' });
      }
      Object.assign(c, body);
      return json(200, c);
    }

    if (sub === '/products' && method === 'POST') {
      if (!db.categories.some((c) => c.id === body.categoryId)) return err(422, 'validation_error', 'Categoria inexistente.', { categoryId: 'Categoria inexistente.' });
      if (typeof body.imageUrl === 'string' && body.imageUrl && !body.imageUrl.startsWith('https://')) {
        return err(422, 'validation_error', 'Revise os campos destacados.', { imageUrl: 'Value error, Use uma URL https:// ou deixe vazio.' });
      }
      const t = now();
      const x = { ...(body as unknown as Product), id: newId(), archived: false, createdAt: t, updatedAt: t, stock: 0 };
      db.products.unshift(x);
      const stock = Number(body.stock ?? 0);
      if (stock > 0) move(x, 'cadastro', stock, 'Estoque inicial', 'Cadastro de produto', actor);
      return json(201, adminProduct(x));
    }
    const prodMatch = /^\/products\/([^/]+)$/.exec(sub);
    if (prodMatch && method === 'PATCH') {
      const x = db.products.find((y) => y.id === prodMatch[1]);
      if (!x) return err(404, 'not_found', 'Produto não encontrado.');
      if ('stock' in body) return err(422, 'validation_error', 'Revise os campos destacados.', { stock: 'Extra inputs are not permitted' });
      Object.assign(x, body, { updatedAt: now() });
      if (x.archived) x.published = false;
      return json(200, adminProduct(x));
    }

    if (sub === '/stock/movements' && method === 'POST') {
      return idempotent('stock.move', key, body, () => {
        const x = db.products.find((y) => y.id === body.productId);
        if (!x) return err(404, 'not_found', 'Produto não encontrado.');
        const qty = Number(body.qty);
        const delta = body.type === 'entrada' ? qty : qty - x.stock;
        const m = move(x, String(body.type), delta, String(body.note || 'Entrada de mercadoria'), 'Painel', actor);
        return { status: 201, body: { movement: m, product: adminProduct(x) } };
      });
    }

    if (sub === '/sales' && method === 'POST') {
      return idempotent('sale.create', key, body, () => {
        const items = body.items as { productId: string; qty: number }[];
        for (const i of items) {
          const x = db.products.find((y) => y.id === i.productId);
          if (!x || x.archived || x.stock < i.qty) return err(409, 'insufficient_stock', 'Estoque insuficiente.');
        }
        const sale: Sale = { id: newId(), items, status: 'concluida', createdAt: now(), createdBy: actor, cancelledAt: null, cancelledBy: null };
        for (const i of items) move(db.products.find((y) => y.id === i.productId)!, 'venda', -i.qty, 'Venda registrada', `Venda ${sale.id}`, actor);
        db.sales.unshift(sale);
        return { status: 201, body: sale };
      });
    }
    const cancelMatch = /^\/sales\/([^/]+)\/cancel$/.exec(sub);
    if (cancelMatch && method === 'POST') {
      return idempotent('sale.cancel', key, { saleId: cancelMatch[1] }, () => {
        const sale = db.sales.find((s) => s.id === cancelMatch[1]);
        if (!sale) return err(404, 'not_found', 'Venda não encontrada.');
        if (sale.status === 'cancelada') return err(409, 'conflict', 'A venda já foi cancelada; o estoque já foi estornado.');
        for (const i of sale.items) move(db.products.find((y) => y.id === i.productId)!, 'estorno', i.qty, 'Cancelamento de venda', `Venda ${sale.id}`, actor);
        Object.assign(sale, { status: 'cancelada', cancelledAt: now(), cancelledBy: actor });
        return { status: 200, body: { ...sale } };
      });
    }

    if (sub === '/settings' && method === 'PUT') {
      db.settings = { ...DEFAULT_SETTINGS, ...(body as Partial<Settings>) };
      return json(200, db.settings);
    }
    return err(405, 'method_not_allowed', 'Método não permitido.');
  }

  const take = <T extends { method: string; path: string }>(list: T[], method: string, path: string) => {
    const i = list.findIndex((f) => f.method === method && path.startsWith(f.path));
    return i >= 0 ? list.splice(i, 1)[0] : undefined;
  };

  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith(API)) throw new TypeError('Failed to fetch');
    init.signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    const path = url.slice(API.length);
    const method = init.method ?? 'GET';
    const token = headers.get('Authorization')?.replace(/^Bearer /, '') ?? null;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, path, token, idempotencyKey: headers.get('Idempotency-Key'), body: init.body ? body : undefined });

    const failure = take(failures, method, path);
    if (failure) {
      if (failure.failure === 'network') throw new TypeError('Failed to fetch');
      return failure.failure.clone();
    }
    const response = await route(method, path, token, headers.get('Idempotency-Key'), body);
    if (take(lost, method, path)) throw new TypeError('Failed to fetch');
    return response;
  });

  return {
    db,
    calls,
    fetch: fetchMock,
    install() {
      vi.stubGlobal('fetch', fetchMock);
      return this;
    },
    setMe(handler: Handler) {
      me = handler;
    },
    /** A próxima requisição (método + início do caminho) falha antes de chegar ao "banco". */
    failNext(method: string, path: string, failure: Failure) {
      failures.push({ method, path, failure });
    },
    /** A próxima requisição é aplicada, mas a resposta não chega ao navegador. */
    loseNextResponse(method: string, path: string) {
      lost.push({ method, path });
    },
    adminCalls: () => calls.filter((c) => c.path.startsWith('/api/v1/admin/')),
    dataCalls: () => calls.filter((c) => c.path.startsWith('/api/v1/admin/') && c.path !== '/api/v1/admin/me'),
    writes: () => calls.filter((c) => c.method !== 'GET'),
    seedCategory(name: string, active = true) {
      const c = { id: newId(), name, icon: 'label', active };
      db.categories.push(c);
      return c;
    },
    seedProduct(over: Partial<Product> & { categoryId: string; name: string }) {
      const t = now();
      const x: Product = {
        id: newId(),
        description: '',
        brand: '',
        imageUrl: '',
        priceCents: 4990,
        showPrice: true,
        stock: 10,
        minStock: 2,
        published: true,
        featured: false,
        archived: false,
        createdAt: t,
        updatedAt: t,
        ...over,
      };
      db.products.unshift(x);
      return x;
    },
  };
}

export type FakeBackend = ReturnType<typeof createFakeBackend>;
