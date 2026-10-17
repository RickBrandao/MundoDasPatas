import { describe, expect, it } from 'vitest';
import { createSeedData } from '../data/seed';
import { addToCart, cartLines, reconcileCart, setCartQty } from './cart';
import type { StoreData } from './types';

const d = createSeedData(Date.UTC(2026, 9, 17));
const patch = (data: StoreData, id: string, p: object): StoreData => ({ ...data, products: data.products.map((x) => (x.id === id ? { ...x, ...p } : x)) });

describe('adicionar à encomenda', () => {
  it('adiciona quantidades inteiras positivas', () => {
    const r = addToCart({}, d, 'p10', 2);
    expect(r.kind).toBe('added');
    if (r.kind === 'added') expect(r.cart).toEqual({ p10: 2 });
  });

  it('limita ao estoque (p7 tem 2)', () => {
    const r = addToCart({}, d, 'p7', 99);
    expect(r.kind).toBe('clamped');
    if (r.kind === 'clamped') expect(r.cart.p7).toBe(2);
    expect(addToCart({ p7: 2 }, d, 'p7', 1).kind).toBe('at-max');
  });

  it('recusa esgotado, oculto, arquivado e de categoria inativa', () => {
    expect(addToCart({}, d, 'p3', 1).kind).toBe('unavailable'); // estoque 0
    expect(addToCart({}, d, 'p13', 1).kind).toBe('unavailable'); // não publicado
    expect(addToCart({}, patch(d, 'p1', { archived: true }), 'p1', 1).kind).toBe('unavailable');
    const inactive = { ...d, categories: d.categories.map((c) => (c.id === 'racoes' ? { ...c, active: false } : c)) };
    expect(addToCart({}, inactive, 'p1', 1).kind).toBe('unavailable');
    expect(addToCart({}, d, 'nao-existe', 1).kind).toBe('unavailable');
  });

  it('recusa quantidade não inteira, zero ou negativa', () => {
    for (const q of [0, -1, 1.5, NaN]) expect(addToCart({}, d, 'p10', q).kind).toBe('invalid-qty');
  });
});

describe('alterar quantidade', () => {
  it('limita entre 0 e o estoque; zero remove', () => {
    expect(setCartQty({ p10: 2 }, d, 'p10', 3)).toEqual({ p10: 3 });
    expect(setCartQty({ p7: 1 }, d, 'p7', 50)).toEqual({ p7: 2 });
    expect(setCartQty({ p10: 2 }, d, 'p10', 0)).toEqual({});
    expect(setCartQty({ p10: 2 }, d, 'p10', -4)).toEqual({});
    expect(setCartQty({ p10: 2 }, d, 'p10', 2.7)).toEqual({ p10: 2 });
  });
});

describe('sincronização com o estoque', () => {
  it('reduz quantidade acima do estoque e informa', () => {
    const r = reconcileCart({ p1: 5 }, patch(d, 'p1', { stock: 1 }));
    expect(r.changed).toBe(true);
    expect(r.cart).toEqual({ p1: 1 });
    expect(r.messages[0]).toContain('quantidade ajustada para 1');
  });

  it('remove itens esgotados, ocultos, arquivados ou de categoria inativa', () => {
    expect(reconcileCart({ p10: 2 }, patch(d, 'p10', { stock: 0 })).cart).toEqual({});
    expect(reconcileCart({ p10: 2 }, patch(d, 'p10', { published: false })).cart).toEqual({});
    expect(reconcileCart({ p10: 2 }, patch(d, 'p10', { archived: true })).cart).toEqual({});
    const inactive = { ...d, categories: d.categories.map((c) => (c.id === 'brinquedos' ? { ...c, active: false } : c)) };
    const r = reconcileCart({ p10: 2, p1: 1 }, inactive);
    expect(r.cart).toEqual({ p1: 1 });
    expect(r.messages).toEqual(['Bola de Borracha Maciça saiu da encomenda (indisponível)']);
  });

  it('remove produto inexistente e quantidades corrompidas', () => {
    const r = reconcileCart({ x: 1, p10: 1.5, p1: -2, p6: 2 } as Record<string, number>, d);
    expect(r.cart).toEqual({ p6: 2 });
  });

  it('não altera nada quando tudo está válido (mesma referência)', () => {
    const cart = { p10: 2 };
    const r = reconcileCart(cart, d);
    expect(r.changed).toBe(false);
    expect(r.cart).toBe(cart);
  });

  it('linhas exibidas nunca passam do estoque', () => {
    const lines = cartLines({ p7: 10, p3: 1 }, d);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ qty: 2, atMax: true });
  });
});
