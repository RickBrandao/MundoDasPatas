import { isProductOrderable } from './catalog';
import type { Cart, Product, StoreData } from './types';

type Ctx = Pick<StoreData, 'products' | 'categories' | 'settings'>;

export type AddOutcome =
  | { kind: 'added'; cart: Cart; product: Product }
  | { kind: 'clamped'; cart: Cart; product: Product } // adicionado só até o limite do estoque
  | { kind: 'at-max'; product: Product }
  | { kind: 'unavailable' }
  | { kind: 'invalid-qty' };

const isPositiveInt = (n: number) => Number.isInteger(n) && n > 0;

export function addToCart(cart: Cart, ctx: Ctx, productId: string, qty: number): AddOutcome {
  if (!isPositiveInt(qty)) return { kind: 'invalid-qty' };
  const product = ctx.products.find((p) => p.id === productId);
  if (!product || !isProductOrderable(product, ctx)) return { kind: 'unavailable' };
  const current = cart[productId] ?? 0;
  const next = Math.min(product.stock, current + qty);
  if (next === current) return { kind: 'at-max', product };
  const nextCart = { ...cart, [productId]: next };
  return next < current + qty
    ? { kind: 'clamped', cart: nextCart, product }
    : { kind: 'added', cart: nextCart, product };
}

/** Define a quantidade (limitada a 0…estoque). Zero remove o item. */
export function setCartQty(cart: Cart, ctx: Ctx, productId: string, qty: number): Cart {
  const product = ctx.products.find((p) => p.id === productId);
  const max = product && isProductOrderable(product, ctx) ? product.stock : 0;
  const q = Math.max(0, Math.min(max, Math.trunc(Number.isFinite(qty) ? qty : 0)));
  const next = { ...cart };
  if (q === 0) delete next[productId];
  else next[productId] = q;
  return next;
}

export interface ReconcileResult {
  cart: Cart;
  changed: boolean;
  messages: string[];
}

/**
 * Sincroniza a encomenda com o estoque e a visibilidade atuais:
 * remove itens indisponíveis/ocultos e reduz quantidades acima do estoque.
 * Também descarta entradas corrompidas (quantidade não inteira ou ≤ 0).
 */
export function reconcileCart(cart: Cart, ctx: Ctx): ReconcileResult {
  const next: Cart = {};
  const messages: string[] = [];
  let changed = false;
  for (const [id, rawQty] of Object.entries(cart)) {
    const p = ctx.products.find((x) => x.id === id);
    if (!p || !isProductOrderable(p, ctx)) {
      changed = true;
      messages.push(`${p ? p.name : 'Um produto'} saiu da encomenda (indisponível)`);
      continue;
    }
    if (!isPositiveInt(rawQty)) {
      changed = true;
      continue;
    }
    if (rawQty > p.stock) {
      next[id] = p.stock;
      changed = true;
      messages.push(`${p.name}: quantidade ajustada para ${p.stock}`);
    } else {
      next[id] = rawQty;
    }
  }
  return { cart: changed ? next : cart, changed, messages };
}

export interface CartLine {
  product: Product;
  qty: number;
  atMax: boolean;
}

/** Linhas exibíveis (já filtradas pelas regras), na ordem em que foram adicionadas. */
export function cartLines(cart: Cart, ctx: Ctx): CartLine[] {
  const lines: CartLine[] = [];
  for (const [id, qty] of Object.entries(cart)) {
    const p = ctx.products.find((x) => x.id === id);
    if (!p || !isProductOrderable(p, ctx) || !isPositiveInt(qty)) continue;
    const q = Math.min(qty, p.stock);
    lines.push({ product: p, qty: q, atMax: q >= p.stock });
  }
  return lines;
}

export const cartCount = (lines: CartLine[]) => lines.reduce((a, l) => a + l.qty, 0);
