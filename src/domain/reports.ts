import { categoryIsActive, isProductVisible, stockStatus } from './catalog';
import { DAY_MS } from './format';
import type { Product, Sale, StoreData } from './types';

export type SalesPeriod = '7' | '30' | 'all';

export const inPeriod = (date: number, period: SalesPeriod, now: number) =>
  period === 'all' || now - date <= parseInt(period, 10) * DAY_MS;

export const completedSales = (sales: Sale[], period: SalesPeriod, now: number) =>
  sales.filter((s) => s.status === 'concluida' && inPeriod(s.date, period, now));

export const unitsSold = (sales: Sale[]) => sales.reduce((a, s) => a + s.items.reduce((b, i) => b + i.qty, 0), 0);

export interface TopSeller {
  productId: string;
  units: number;
  /** Largura da barra (6–100%). */
  pct: number;
}

export function topSellers(sales: Sale[], period: SalesPeriod, now: number, limit = 5): TopSeller[] {
  const totals: Record<string, number> = {};
  for (const s of completedSales(sales, period, now)) for (const i of s.items) totals[i.productId] = (totals[i.productId] ?? 0) + i.qty;
  const sorted = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  const max = sorted.length ? sorted[0][1] : 1;
  return sorted.map(([productId, units]) => ({ productId, units, pct: Math.max(6, Math.round((units / max) * 100)) }));
}

export const activeProducts = (products: Product[]) => products.filter((p) => !p.archived);

export interface CatalogSummary {
  active: number;
  visible: number;
  published: number;
  notPublished: number;
  hiddenByCategory: number;
  hiddenOutOfStock: number;
  inactiveCategories: number;
  low: number;
  out: number;
  ok: number;
}

export function catalogSummary(data: StoreData): CatalogSummary {
  const act = activeProducts(data.products);
  const catOn = (p: Product) => categoryIsActive(data.categories, p.categoryId);
  const counts = { ok: 0, low: 0, out: 0 };
  act.forEach((p) => counts[stockStatus(p)]++);
  const published = act.filter((p) => p.published).length;
  return {
    active: act.length,
    visible: act.filter((p) => isProductVisible(p, data)).length,
    published,
    notPublished: act.length - published,
    hiddenByCategory: act.filter((p) => p.published && !catOn(p)).length,
    hiddenOutOfStock: act.filter((p) => p.published && catOn(p) && !data.settings.showOutOfStock && p.stock <= 0).length,
    inactiveCategories: data.categories.filter((c) => !c.active).length,
    ...counts,
  };
}

/** Situação de um produto em relação ao catálogo público (rótulo do painel). */
export type PublicState = 'archived' | 'hidden' | 'inactive-category' | 'out-hidden' | 'visible';

export function publicState(p: Product, data: StoreData): PublicState {
  if (p.archived) return 'archived';
  if (!p.published) return 'hidden';
  if (!categoryIsActive(data.categories, p.categoryId)) return 'inactive-category';
  if (!data.settings.showOutOfStock && p.stock <= 0) return 'out-hidden';
  return 'visible';
}
