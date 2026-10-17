/**
 * Operações de escrita sobre o estado da loja. Todas são funções puras:
 * recebem o estado atual e devolvem um novo estado (ou um erro), sem efeitos colaterais.
 * São usadas pela implementação local do serviço e servem de especificação para o backend.
 */
import { isNonNegativeIntString, normalizeText } from './format';
import { parseBRL } from './money';
import { normalizePhone } from './phone';
import { fail, ok } from './types';
import type {
  Category,
  FieldErrors,
  MovementType,
  Product,
  Result,
  Sale,
  SaleItem,
  Settings,
  StockMovement,
  StoreData,
} from './types';

type NewMovement = Pick<StockMovement, 'productId' | 'type' | 'qty' | 'note' | 'origin'>;

function appendMovements(data: StoreData, moves: NewMovement[], now: number): Pick<StoreData, 'movements' | 'seq'> {
  let m = data.seq.movement;
  const created = moves.map((x) => ({ ...x, id: `m${m++}`, date: now }));
  return { movements: [...created, ...data.movements], seq: { ...data.seq, movement: m } };
}

const findProduct = (data: StoreData, id: string) => data.products.find((p) => p.id === id);

/* ------------------------------------------------------------------ produtos */

export interface ProductFormInput {
  id: string | null;
  name: string;
  categoryId: string;
  brand: string;
  description: string;
  imageUrl: string;
  price: string;
  showPrice: boolean;
  /** Só é usado no cadastro; depois o estoque muda apenas por movimentações. */
  stock: string;
  minStock: string;
  published: boolean;
  featured: boolean;
}

export function validateProductForm(f: ProductFormInput, categories: Category[]): Result<{
  priceCents: number | null;
  stock: number;
  minStock: number;
}> {
  const e: FieldErrors = {};
  const isNew = f.id == null;
  if (f.name.trim().length < 3) e.name = 'Informe o nome do produto (mínimo 3 caracteres).';
  if (!f.categoryId) e.categoryId = 'Selecione uma categoria.';
  else if (!categories.some((c) => c.id === f.categoryId)) e.categoryId = 'Categoria inexistente.';

  const priceText = f.price.trim();
  let priceCents = parseBRL(priceText);
  if (priceText && !(priceCents != null && priceCents > 0)) {
    e.price = 'Valor inválido. Use o formato 49,90 ou 1.234,56.';
    priceCents = null;
  }
  if (f.showPrice && !priceText) e.price = 'Informe o preço ou desmarque “Exibir preço no catálogo”.';
  if (isNew && !isNonNegativeIntString(f.stock)) e.stock = 'Informe um número inteiro (0 ou mais).';
  if (!isNonNegativeIntString(f.minStock)) e.minStock = 'Informe um número inteiro (0 ou mais).';

  if (Object.keys(e).length) return fail('Revise os campos destacados.', e);
  return ok({
    priceCents,
    stock: isNew ? parseInt(f.stock, 10) : 0,
    minStock: parseInt(f.minStock, 10),
  });
}

export function saveProduct(data: StoreData, f: ProductFormInput, now: number): Result<{ data: StoreData; product: Product }> {
  const v = validateProductForm(f, data.categories);
  if (!v.ok) return v;
  const { priceCents, stock, minStock } = v.value;
  const base = {
    name: f.name.trim(),
    categoryId: f.categoryId,
    brand: f.brand.trim(),
    description: f.description.trim(),
    imageUrl: f.imageUrl,
    priceCents,
    showPrice: f.showPrice && priceCents != null && priceCents > 0,
    minStock,
    published: f.published,
    featured: f.featured,
    updatedAt: now,
  };

  if (f.id == null) {
    const id = `p${data.seq.product}`;
    const product: Product = { id, ...base, stock, archived: false, createdAt: now };
    const mv =
      stock > 0
        ? appendMovements(data, [{ productId: id, type: 'cadastro', qty: stock, note: 'Estoque inicial', origin: 'Cadastro de produto' }], now)
        : { movements: data.movements, seq: data.seq };
    return ok({
      product,
      data: { ...data, products: [product, ...data.products], movements: mv.movements, seq: { ...mv.seq, product: data.seq.product + 1 } },
    });
  }

  const current = findProduct(data, f.id);
  if (!current) return fail('Produto não encontrado.');
  const product: Product = { ...current, ...base };
  return ok({ product, data: { ...data, products: data.products.map((p) => (p.id === f.id ? product : p)) } });
}

export type ProductFlags = Partial<Pick<Product, 'published' | 'featured' | 'archived'>>;

export function patchProductFlags(data: StoreData, id: string, flags: ProductFlags, now: number): Result<StoreData> {
  const current = findProduct(data, id);
  if (!current) return fail('Produto não encontrado.');
  const next = { ...current, ...flags, updatedAt: now };
  if (next.archived) next.published = false; // arquivado nunca fica publicado
  return ok({ ...data, products: data.products.map((p) => (p.id === id ? next : p)) });
}

/* ------------------------------------------------------------------ estoque */

export interface StockMoveInput {
  productId: string;
  type: Extract<MovementType, 'entrada' | 'ajuste'>;
  qty: string;
  note: string;
}

export function applyStockMove(data: StoreData, m: StockMoveInput, now: number): Result<{ data: StoreData; product: Product }> {
  const p = findProduct(data, m.productId);
  if (!p) return fail('Produto não encontrado.');
  if (!isNonNegativeIntString(m.qty)) return fail('Informe um número inteiro.');
  const q = parseInt(m.qty, 10);
  let delta: number;
  if (m.type === 'entrada') {
    if (q <= 0) return fail('A entrada deve ser maior que zero.');
    delta = q;
  } else {
    if (q === p.stock) return fail('A nova quantidade é igual à atual.');
    if (!m.note.trim()) return fail('Informe o motivo do ajuste.');
    delta = q - p.stock;
  }
  if (p.stock + delta < 0) return fail('O estoque não pode ficar negativo.');

  const mv = appendMovements(data, [{ productId: p.id, type: m.type, qty: delta, note: m.note.trim() || 'Entrada de mercadoria', origin: 'Painel' }], now);
  const product = { ...p, stock: p.stock + delta, updatedAt: now };
  return ok({ product, data: { ...data, ...mv, products: data.products.map((x) => (x.id === p.id ? product : x)) } });
}

/* ------------------------------------------------------------------ vendas */

const totalsByProduct = (items: SaleItem[]) => {
  const t: Record<string, number> = {};
  for (const i of items) t[i.productId] = (t[i.productId] ?? 0) + i.qty;
  return t;
};

/** Validação ao adicionar uma linha no formulário de venda (antes de confirmar). */
export function addSaleLine(data: StoreData, lines: SaleItem[], productId: string, qtyText: string): Result<SaleItem[]> {
  const p = findProduct(data, productId);
  if (!p || p.archived) return fail('Selecione um produto.');
  if (!isNonNegativeIntString(qtyText) || parseInt(qtyText, 10) <= 0) return fail('Informe uma quantidade válida.');
  const q = parseInt(qtyText, 10);
  const existing = lines.find((l) => l.productId === p.id);
  const available = p.stock - (existing?.qty ?? 0);
  if (q > available) return fail(`Estoque insuficiente: ${available} un. disponíveis de “${p.name}”.`);
  return ok(existing ? lines.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + q } : l)) : [...lines, { productId: p.id, qty: q }]);
}

export function registerSale(data: StoreData, items: SaleItem[], now: number): Result<{ data: StoreData; sale: Sale }> {
  if (!items.length) return fail('Adicione pelo menos um produto.');
  if (items.some((i) => !Number.isInteger(i.qty) || i.qty <= 0)) return fail('Quantidades devem ser inteiras e positivas.');
  const totals = totalsByProduct(items);
  for (const [pid, qty] of Object.entries(totals)) {
    const p = findProduct(data, pid);
    if (!p || p.archived || qty > p.stock) return fail('O estoque mudou. Revise os itens.');
  }

  const id = `V-${String(data.seq.sale).padStart(4, '0')}`;
  const sale: Sale = { id, date: now, status: 'concluida', items: items.map((i) => ({ ...i })) };
  const mv = appendMovements(
    data,
    items.map((i) => ({ productId: i.productId, type: 'venda' as const, qty: -i.qty, note: 'Venda registrada', origin: `Venda ${id}` })),
    now,
  );
  return ok({
    sale,
    data: {
      ...data,
      products: data.products.map((p) => (totals[p.id] ? { ...p, stock: p.stock - totals[p.id], updatedAt: now } : p)),
      sales: [sale, ...data.sales],
      movements: mv.movements,
      seq: { ...mv.seq, sale: data.seq.sale + 1 },
    },
  });
}

/** Cancela uma venda concluída e devolve os itens ao estoque — exatamente uma vez. */
export function cancelSale(data: StoreData, saleId: string, now: number): Result<StoreData> {
  const sale = data.sales.find((s) => s.id === saleId);
  if (!sale) return fail('Venda não encontrada.');
  if (sale.status !== 'concluida') return fail(`A venda ${saleId} já foi cancelada; o estoque já foi estornado.`);

  const totals = totalsByProduct(sale.items);
  const mv = appendMovements(
    data,
    sale.items.map((i) => ({ productId: i.productId, type: 'estorno' as const, qty: i.qty, note: 'Cancelamento de venda', origin: `Venda ${saleId}` })),
    now,
  );
  return ok({
    ...data,
    products: data.products.map((p) => (totals[p.id] ? { ...p, stock: p.stock + totals[p.id], updatedAt: now } : p)),
    sales: data.sales.map((s) => (s.id === saleId ? { ...s, status: 'cancelada', cancelledAt: now } : s)),
    ...mv,
  });
}

/* ------------------------------------------------------------------ categorias */

export function saveCategory(data: StoreData, input: { id: string | null; name: string }): Result<{ data: StoreData; created: boolean }> {
  const name = input.name.trim();
  if (name.length < 2) return fail('Informe o nome da categoria.');
  if (data.categories.some((c) => c.id !== input.id && normalizeText(c.name) === normalizeText(name))) {
    return fail('Já existe uma categoria com esse nome.');
  }
  if (input.id) {
    if (!data.categories.some((c) => c.id === input.id)) return fail('Categoria não encontrada.');
    return ok({ created: false, data: { ...data, categories: data.categories.map((c) => (c.id === input.id ? { ...c, name } : c)) } });
  }
  const category: Category = { id: `c${data.seq.category}`, name, icon: 'label', active: true };
  return ok({
    created: true,
    data: { ...data, categories: [...data.categories, category], seq: { ...data.seq, category: data.seq.category + 1 } },
  });
}

export function toggleCategory(data: StoreData, id: string): Result<{ data: StoreData; active: boolean }> {
  const c = data.categories.find((x) => x.id === id);
  if (!c) return fail('Categoria não encontrada.');
  return ok({ active: !c.active, data: { ...data, categories: data.categories.map((x) => (x.id === id ? { ...x, active: !x.active } : x)) } });
}

/* ------------------------------------------------------------------ configurações */

export function validateSettings(draft: Settings): Result<Settings> {
  if (!draft.storeName.trim()) return fail('Informe o nome da loja.', { storeName: 'Informe o nome da loja.' });
  const phone = normalizePhone(draft.whatsapp);
  if (!phone.ok) return fail('Revise o número de WhatsApp.', { whatsapp: phone.error });
  return ok({ ...draft, storeName: draft.storeName.trim(), whatsapp: draft.whatsapp.trim() });
}
