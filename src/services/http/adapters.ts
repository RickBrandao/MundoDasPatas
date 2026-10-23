/**
 * Conversão entre os DTOs do FastAPI (camelCase, datas ISO 8601 UTC) e o modelo do frontend
 * (`src/domain/types.ts`, datas em milissegundos). Valores monetários seguem em centavos inteiros
 * e os IDs são sempre os do servidor.
 *
 * Toda resposta é conferida: campo ausente ou de tipo inesperado lança `InvalidResponse`
 * (a interface mostra erro em vez de exibir dados incompletos).
 */
import type { Category, FieldErrors, MovementType, Product, Sale, SaleStatus, Settings, StockMovement, StockStatus, StoreData } from '../../domain/types';
import type { ProductFormInput } from '../../domain/operations';

export class InvalidResponse extends Error {
  constructor(what: string) {
    super(`Resposta inválida do servidor: ${what}`);
    this.name = 'InvalidResponse';
  }
}

type Obj = Record<string, unknown>;

const obj = (v: unknown, what: string): Obj => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new InvalidResponse(what);
  return v as Obj;
};
const arr = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new InvalidResponse(what);
  return v;
};
const str = (o: Obj, k: string): string => {
  if (typeof o[k] !== 'string') throw new InvalidResponse(k);
  return o[k];
};
const bool = (o: Obj, k: string): boolean => {
  if (typeof o[k] !== 'boolean') throw new InvalidResponse(k);
  return o[k];
};
const int = (o: Obj, k: string): number => {
  if (!Number.isInteger(o[k])) throw new InvalidResponse(k);
  return o[k] as number;
};
const intOrNull = (o: Obj, k: string): number | null => (o[k] === null ? null : int(o, k));
const oneOf = <T extends string>(o: Obj, k: string, values: readonly T[]): T => {
  const v = str(o, k);
  if (!(values as readonly string[]).includes(v)) throw new InvalidResponse(k);
  return v as T;
};

/** ISO 8601 → milissegundos (UTC). */
export function toMillis(o: Obj, k: string): number {
  const ms = Date.parse(str(o, k));
  if (!Number.isFinite(ms)) throw new InvalidResponse(k);
  return ms;
}

const STOCK_STATUS = ['ok', 'low', 'out'] as const;
const MOVEMENT_TYPES = ['entrada', 'ajuste', 'venda', 'estorno', 'cadastro'] as const satisfies readonly MovementType[];
const SALE_STATUS = ['concluida', 'cancelada'] as const satisfies readonly SaleStatus[];

/** Sem sequências locais: os IDs vêm do servidor. */
const NO_SEQ = { product: 0, sale: 0, movement: 0, category: 0 };

/* ------------------------------------------------------------------ categorias */

export function toCategory(raw: unknown): Category {
  const o = obj(raw, 'categoria');
  return { id: str(o, 'id'), name: str(o, 'name'), icon: str(o, 'icon'), active: o.active === undefined ? true : bool(o, 'active') };
}

/* ------------------------------------------------------------------ produtos */

export function toProduct(raw: unknown): Product {
  const o = obj(raw, 'produto');
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    categoryId: str(o, 'categoryId'),
    brand: str(o, 'brand'),
    description: str(o, 'description'),
    imageUrl: str(o, 'imageUrl'),
    priceCents: intOrNull(o, 'priceCents'),
    showPrice: bool(o, 'showPrice'),
    stock: int(o, 'stock'),
    minStock: int(o, 'minStock'),
    published: bool(o, 'published'),
    featured: bool(o, 'featured'),
    archived: bool(o, 'archived'),
    createdAt: toMillis(o, 'createdAt'),
    updatedAt: toMillis(o, 'updatedAt'),
  };
}

/**
 * Produto do catálogo público. O servidor já aplicou publicação, arquivamento, categoria ativa
 * e "mostrar esgotados", e não expõe estoque mínimo nem datas: `minStock` é escolhido para que
 * `stockStatus()` do frontend reproduza o `stockStatus` calculado pelo servidor.
 */
export function toPublicProduct(raw: unknown): Product {
  const o = obj(raw, 'produto');
  const stock = int(o, 'stock');
  const status: StockStatus = oneOf(o, 'stockStatus', STOCK_STATUS);
  const priceCents = intOrNull(o, 'priceCents');
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    categoryId: str(o, 'categoryId'),
    brand: str(o, 'brand'),
    description: str(o, 'description'),
    imageUrl: str(o, 'imageUrl'),
    priceCents,
    showPrice: priceCents != null,
    stock,
    minStock: status === 'low' ? stock : 0,
    published: true,
    featured: bool(o, 'featured'),
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Data URLs (fotos da demonstração) nunca vão ao servidor: o backend só aceita https:// ou vazio. */
export const serverImageUrl = (url: string) => (url.startsWith('https://') ? url : '');

export interface ProductPayload {
  name: string;
  description: string;
  categoryId: string;
  brand: string;
  imageUrl: string;
  priceCents: number | null;
  showPrice: boolean;
  minStock: number;
  published: boolean;
  featured: boolean;
}

/** Corpo de criação/edição a partir do formulário já validado (`validateProductForm`). */
export function productPayload(f: ProductFormInput, v: { priceCents: number | null; minStock: number }): ProductPayload {
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    categoryId: f.categoryId,
    brand: f.brand.trim(),
    imageUrl: serverImageUrl(f.imageUrl),
    priceCents: v.priceCents,
    showPrice: f.showPrice && v.priceCents != null && v.priceCents > 0,
    minStock: v.minStock,
    published: f.published,
    featured: f.featured,
  };
}

/** Nomes de campo do servidor → campos dos formulários do frontend. */
const PRODUCT_FIELDS: Record<string, string> = { priceCents: 'price', imageUrl: 'image' };

export function productFieldErrors(errors: FieldErrors | undefined): FieldErrors | undefined {
  if (!errors) return undefined;
  const out: FieldErrors = {};
  for (const [k, v] of Object.entries(errors)) out[PRODUCT_FIELDS[k] ?? k] = v;
  return out;
}

/* ------------------------------------------------------------------ estoque e vendas */

export function toMovement(raw: unknown): StockMovement {
  const o = obj(raw, 'movimentação');
  return {
    id: str(o, 'id'),
    productId: str(o, 'productId'),
    type: oneOf(o, 'type', MOVEMENT_TYPES),
    qty: int(o, 'qty'),
    date: toMillis(o, 'createdAt'),
    note: str(o, 'note'),
    origin: str(o, 'origin'),
  };
}

export function toSale(raw: unknown): Sale {
  const o = obj(raw, 'venda');
  const sale: Sale = {
    id: str(o, 'id'),
    date: toMillis(o, 'createdAt'),
    status: oneOf(o, 'status', SALE_STATUS),
    items: arr(o.items, 'items').map((i) => {
      const item = obj(i, 'item');
      return { productId: str(item, 'productId'), qty: int(item, 'qty') };
    }),
  };
  if (o.cancelledAt != null) sale.cancelledAt = toMillis(o, 'cancelledAt');
  return sale;
}

/* ------------------------------------------------------------------ configurações */

export function toSettings(raw: unknown): Settings {
  const o = obj(raw, 'configurações');
  return {
    storeName: str(o, 'storeName'),
    whatsapp: str(o, 'whatsapp'),
    address: str(o, 'address'),
    hours: str(o, 'hours'),
    about: str(o, 'about'),
    showOutOfStock: bool(o, 'showOutOfStock'),
    showFeatured: bool(o, 'showFeatured'),
  };
}

/** `PublicStore` não expõe `showOutOfStock`: o filtro de esgotados já foi aplicado pelo servidor. */
export function toPublicSettings(raw: unknown): Settings {
  const o = obj(raw, 'loja');
  return {
    storeName: str(o, 'storeName'),
    whatsapp: str(o, 'whatsapp'),
    address: str(o, 'address'),
    hours: str(o, 'hours'),
    about: str(o, 'about'),
    showOutOfStock: true,
    showFeatured: bool(o, 'showFeatured'),
  };
}

export const settingsPayload = (s: Settings) => ({
  storeName: s.storeName.trim(),
  whatsapp: s.whatsapp.trim(),
  address: s.address.trim(),
  hours: s.hours.trim(),
  about: s.about.trim(),
  showOutOfStock: s.showOutOfStock,
  showFeatured: s.showFeatured,
});

/* ------------------------------------------------------------------ catálogo e painel */

/** `GET /public/catalog` → estado da vitrine. Vendas e movimentações nunca existem na área pública. */
export function toPublicStoreData(raw: unknown): StoreData {
  const o = obj(raw, 'catálogo');
  return {
    categories: arr(o.categories, 'categories').map(toCategory),
    products: arr(o.products, 'products').map(toPublicProduct),
    sales: [],
    movements: [],
    settings: toPublicSettings(o.store),
    seq: NO_SEQ,
  };
}

export interface AdminPayloads {
  products: unknown;
  categories: unknown;
  sales: unknown;
  movements: unknown;
  settings: unknown;
}

export function toAdminStoreData(p: AdminPayloads): StoreData {
  return {
    categories: arr(p.categories, 'categories').map(toCategory),
    products: arr(p.products, 'products').map(toProduct),
    sales: arr(p.sales, 'sales').map(toSale),
    movements: arr(p.movements, 'movements').map(toMovement),
    settings: toSettings(p.settings),
    seq: NO_SEQ,
  };
}

/** Indicadores calculados pelo servidor (`GET /admin/dashboard`). */
export interface DashboardSummary {
  catalog: {
    active: number;
    visible: number;
    published: number;
    notPublished: number;
    hiddenByCategory: number;
    hiddenOutOfStock: number;
    inactiveCategories: number;
    ok: number;
    low: number;
    out: number;
  };
  salesLast7Days: { count: number; units: number };
  salesLast30Days: { count: number; units: number };
}

export function toDashboard(raw: unknown): DashboardSummary {
  const o = obj(raw, 'dashboard');
  const c = obj(o.catalog, 'catalog');
  const sales = (k: string) => {
    const s = obj(o[k], k);
    return { count: int(s, 'count'), units: int(s, 'units') };
  };
  return {
    catalog: {
      active: int(c, 'active'),
      visible: int(c, 'visible'),
      published: int(c, 'published'),
      notPublished: int(c, 'notPublished'),
      hiddenByCategory: int(c, 'hiddenByCategory'),
      hiddenOutOfStock: int(c, 'hiddenOutOfStock'),
      inactiveCategories: int(c, 'inactiveCategories'),
      ok: int(c, 'ok'),
      low: int(c, 'low'),
      out: int(c, 'out'),
    },
    salesLast7Days: sales('salesLast7Days'),
    salesLast30Days: sales('salesLast30Days'),
  };
}
