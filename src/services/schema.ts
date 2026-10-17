import type { Cart, StoreData } from '../domain/types';

/** Versão do formato salvo. Ao mudar a estrutura, incremente e trate a migração em `parseStoredData`. */
export const SCHEMA_VERSION = 1;

export interface StoredEnvelope {
  version: number;
  savedAt: number;
  data: StoreData;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown) => typeof x === 'string';
const isNum = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
const isBool = (x: unknown) => typeof x === 'boolean';
const isNonNegInt = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;

function isProduct(p: unknown): boolean {
  return (
    isObj(p) &&
    isStr(p.id) &&
    isStr(p.name) &&
    isStr(p.categoryId) &&
    isStr(p.brand) &&
    isStr(p.description) &&
    isStr(p.imageUrl) &&
    (p.priceCents === null || isNonNegInt(p.priceCents)) &&
    isBool(p.showPrice) &&
    isNonNegInt(p.stock) &&
    isNonNegInt(p.minStock) &&
    isBool(p.published) &&
    isBool(p.featured) &&
    isBool(p.archived)
  );
}

const isCategory = (c: unknown) => isObj(c) && isStr(c.id) && isStr(c.name) && isStr(c.icon) && isBool(c.active);
const isSale = (s: unknown) =>
  isObj(s) &&
  isStr(s.id) &&
  isNum(s.date) &&
  (s.status === 'concluida' || s.status === 'cancelada') &&
  Array.isArray(s.items) &&
  s.items.every((i) => isObj(i) && isStr(i.productId) && Number.isInteger(i.qty) && (i.qty as number) > 0);
const isMovement = (m: unknown) => isObj(m) && isStr(m.id) && isStr(m.productId) && isStr(m.type) && Number.isInteger(m.qty) && isNum(m.date);
const isSettings = (s: unknown) =>
  isObj(s) &&
  ['storeName', 'whatsapp', 'address', 'hours', 'about'].every((k) => isStr(s[k])) &&
  isBool(s.showOutOfStock) &&
  isBool(s.showFeatured);
const isSeq = (s: unknown) => isObj(s) && ['product', 'sale', 'movement', 'category'].every((k) => isNonNegInt(s[k]));

/**
 * Valida o que veio do armazenamento. Qualquer dado corrompido ou de versão
 * desconhecida é descartado (retorna `null`) e a demo recomeça com os dados fictícios.
 * A validação inclui as invariantes de integridade (ex.: estoque inteiro e não negativo).
 */
export function parseStoredData(raw: unknown): StoreData | null {
  if (!isObj(raw) || raw.version !== SCHEMA_VERSION || !isObj(raw.data)) return null;
  const d = raw.data;
  if (
    !Array.isArray(d.products) ||
    !d.products.every(isProduct) ||
    !Array.isArray(d.categories) ||
    !d.categories.every(isCategory) ||
    !Array.isArray(d.sales) ||
    !d.sales.every(isSale) ||
    !Array.isArray(d.movements) ||
    !d.movements.every(isMovement) ||
    !isSettings(d.settings) ||
    !isSeq(d.seq)
  ) {
    return null;
  }
  return d as unknown as StoreData;
}

export function parseStoredCart(raw: unknown): Cart {
  if (!isObj(raw)) return {};
  const cart: Cart = {};
  for (const [id, q] of Object.entries(raw)) if (Number.isInteger(q) && (q as number) > 0) cart[id] = q as number;
  return cart;
}
