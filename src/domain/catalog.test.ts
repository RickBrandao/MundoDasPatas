import { describe, expect, it } from 'vitest';
import { createSeedData } from '../data/seed';
import { DEFAULT_FILTERS, featuredProducts, filterCatalog, isProductVisible, stockStatus } from './catalog';
import type { StoreData } from './types';

const NOW = Date.UTC(2026, 9, 17, 12);
const seed = () => createSeedData(NOW);
const ids = (d: StoreData, f = DEFAULT_FILTERS) => filterCatalog(d.products, d, f).map((p) => p.id);
const withProduct = (d: StoreData, id: string, patch: object): StoreData => ({
  ...d,
  products: d.products.map((p) => (p.id === id ? { ...p, ...patch } : p)),
});

describe('status de estoque', () => {
  it('esgotado, baixo (no mínimo ou abaixo) e disponível', () => {
    expect(stockStatus({ stock: 0, minStock: 3 })).toBe('out');
    expect(stockStatus({ stock: 3, minStock: 3 })).toBe('low');
    expect(stockStatus({ stock: 4, minStock: 3 })).toBe('ok');
  });
});

describe('visibilidade no catálogo', () => {
  it('produto não publicado (Arranhador) fica fora', () => {
    expect(ids(seed())).not.toContain('p13');
    expect(ids(seed())).toHaveLength(18);
  });

  it('produto arquivado fica fora, mesmo marcado como publicado', () => {
    const d = withProduct(seed(), 'p10', { archived: true, published: true });
    expect(isProductVisible(d.products.find((p) => p.id === 'p10')!, d)).toBe(false);
    expect(ids(d)).not.toContain('p10');
  });

  it('categoria inativa oculta seus produtos e some dos destaques', () => {
    const d = { ...seed(), categories: seed().categories.map((c) => (c.id === 'higiene' ? { ...c, active: false } : c)) };
    expect(ids(d).some((id) => ['p17', 'p18', 'p19'].includes(id))).toBe(false);
    expect(featuredProducts(d.products, d).some((p) => p.id === 'p17')).toBe(false);
  });

  it('categoria inexistente oculta o produto', () => {
    const d = withProduct(seed(), 'p1', { categoryId: 'nao-existe' });
    expect(ids(d)).not.toContain('p1');
  });

  it('esgotados aparecem ou somem conforme a configuração', () => {
    expect(ids(seed())).toContain('p3');
    const d = { ...seed(), settings: { ...seed().settings, showOutOfStock: false } };
    expect(ids(d)).not.toContain('p3');
    expect(ids(d)).not.toContain('p11');
  });

  it('destaques respeitam a configuração', () => {
    expect(featuredProducts(seed().products, seed())).toHaveLength(6);
    const d = { ...seed(), settings: { ...seed().settings, showFeatured: false } };
    expect(featuredProducts(d.products, d)).toEqual([]);
  });
});

describe('busca, filtros e ordenação', () => {
  it('busca sem acento por nome, marca e categoria', () => {
    expect(ids(seed(), { ...DEFAULT_FILTERS, q: 'bola' })).toEqual(['p10']);
    expect(ids(seed(), { ...DEFAULT_FILTERS, q: 'RACAO' }).length).toBeGreaterThan(0);
    expect(ids(seed(), { ...DEFAULT_FILTERS, q: 'patafirme' }).sort()).toEqual(['p14', 'p15', 'p16']);
    expect(ids(seed(), { ...DEFAULT_FILTERS, q: 'higiene' }).sort()).toEqual(['p17', 'p18', 'p19']);
  });

  it('filtro por categoria e somente disponíveis', () => {
    const d = seed();
    expect(filterCatalog(d.products, d, { ...DEFAULT_FILTERS, categoryId: 'higiene' }).every((p) => p.categoryId === 'higiene')).toBe(true);
    expect(filterCatalog(d.products, d, { ...DEFAULT_FILTERS, availability: 'in' }).every((p) => p.stock > 0)).toBe(true);
  });

  it('ordena por preço com itens sem preço no fim', () => {
    const d = seed();
    const asc = filterCatalog(d.products, d, { ...DEFAULT_FILTERS, sort: 'asc' });
    const priced = asc.filter((p) => p.showPrice).map((p) => p.priceCents!);
    expect(priced).toEqual([...priced].sort((a, b) => a - b));
    expect(asc.slice(-3).every((p) => !p.showPrice)).toBe(true);
    const desc = filterCatalog(d.products, d, { ...DEFAULT_FILTERS, sort: 'desc' });
    expect(desc[0].id).toBe('p1');
  });

  it('destaques primeiro, depois nome', () => {
    const d = seed();
    const list = filterCatalog(d.products, d, DEFAULT_FILTERS);
    const firstNonFeatured = list.findIndex((p) => !p.featured);
    expect(list.slice(firstNonFeatured).some((p) => p.featured)).toBe(false);
  });
});
