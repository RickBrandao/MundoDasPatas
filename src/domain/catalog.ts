import { hasPublicPrice } from './money';
import { normalizeText } from './format';
import type { Category, Product, Settings, StockStatus } from './types';

export function stockStatus(p: Pick<Product, 'stock' | 'minStock'>): StockStatus {
  if (p.stock <= 0) return 'out';
  return p.stock <= p.minStock ? 'low' : 'ok';
}

type VisibilityCtx = { categories: Category[]; settings: Pick<Settings, 'showOutOfStock'> };

export function categoryIsActive(categories: Category[], categoryId: string): boolean {
  return categories.some((c) => c.id === categoryId && c.active);
}

/**
 * Regra única de visibilidade no catálogo público: publicado, não arquivado,
 * categoria existente e ativa, e — se a loja oculta esgotados — com estoque.
 */
export function isProductVisible(p: Product, ctx: VisibilityCtx): boolean {
  return (
    p.published &&
    !p.archived &&
    categoryIsActive(ctx.categories, p.categoryId) &&
    (ctx.settings.showOutOfStock || p.stock > 0)
  );
}

/** Pode entrar na encomenda: visível e com estoque. */
export function isProductOrderable(p: Product, ctx: VisibilityCtx): boolean {
  return isProductVisible(p, ctx) && p.stock > 0;
}

export type CatalogSort = 'featured' | 'name' | 'asc' | 'desc';
export type CatalogAvailability = 'all' | 'in';

export interface CatalogFilters {
  q: string;
  categoryId: string; // 'all' ou id
  availability: CatalogAvailability;
  sort: CatalogSort;
}

export const DEFAULT_FILTERS: CatalogFilters = { q: '', categoryId: 'all', availability: 'all', sort: 'featured' };

const byName = (a: Product, b: Product) => a.name.localeCompare(b.name, 'pt-BR');
const priceOr = (p: Product, fallback: number) => (hasPublicPrice(p) ? (p.priceCents as number) : fallback);

const SORTERS: Record<CatalogSort, (a: Product, b: Product) => number> = {
  featured: (a, b) => Number(b.featured) - Number(a.featured) || byName(a, b),
  name: byName,
  // Produtos sem preço público vão para o fim nas duas ordens.
  asc: (a, b) => priceOr(a, Number.MAX_SAFE_INTEGER) - priceOr(b, Number.MAX_SAFE_INTEGER),
  desc: (a, b) => priceOr(b, -1) - priceOr(a, -1),
};

export function visibleProducts(products: Product[], ctx: VisibilityCtx): Product[] {
  return products.filter((p) => isProductVisible(p, ctx));
}

export function filterCatalog(products: Product[], ctx: VisibilityCtx, f: CatalogFilters): Product[] {
  const q = normalizeText(f.q.trim());
  const catName = (id: string) => ctx.categories.find((c) => c.id === id)?.name ?? '';
  return visibleProducts(products, ctx)
    .filter(
      (p) =>
        (f.categoryId === 'all' || p.categoryId === f.categoryId) &&
        (f.availability === 'all' || p.stock > 0) &&
        (!q || normalizeText(`${p.name} ${p.brand} ${catName(p.categoryId)}`).includes(q)),
    )
    .sort(SORTERS[f.sort]);
}

export function featuredProducts(products: Product[], ctx: VisibilityCtx & { settings: Settings }, limit = 8): Product[] {
  if (!ctx.settings.showFeatured) return [];
  return visibleProducts(products, ctx)
    .filter((p) => p.featured)
    .slice(0, limit);
}
