import { createContext, useContext } from 'react';
import type { Category, Product } from '../../domain/types';

export interface AdminUi {
  openProductForm(product: Product | null): void;
  openStockMove(productId: string, type: 'entrada' | 'ajuste'): void;
  openSale(): void;
  openCategoryForm(category: Category | null): void;
}

export const AdminUiContext = createContext<AdminUi | null>(null);

export function useAdminUi(): AdminUi {
  const v = useContext(AdminUiContext);
  if (!v) throw new Error('useAdminUi deve ser usado dentro do painel.');
  return v;
}

export const ADMIN_TABS = [
  { path: 'visao-geral', label: 'Visão geral', icon: 'space_dashboard' },
  { path: 'produtos', label: 'Produtos', icon: 'inventory_2' },
  { path: 'categorias', label: 'Categorias', icon: 'category' },
  { path: 'estoque', label: 'Estoque', icon: 'warehouse' },
  { path: 'vendas', label: 'Vendas', icon: 'point_of_sale' },
  { path: 'configuracoes', label: 'Configurações', icon: 'settings' },
] as const;
