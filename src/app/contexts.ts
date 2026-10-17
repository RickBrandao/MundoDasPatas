import { createContext, useContext } from 'react';
import type { CartLine } from '../domain/cart';
import type { ProductFlags, ProductFormInput, StockMoveInput } from '../domain/operations';
import type { Cart, Product, Sale, SaleItem, Settings, StoreData } from '../domain/types';
import type { ApiResult } from '../services/storeApi';

function useRequired<T>(ctx: React.Context<T | null>, name: string): T {
  const v = useContext(ctx);
  if (!v) throw new Error(`${name} deve ser usado dentro do provedor correspondente.`);
  return v;
}

/* ---------------------------------------------------------------- Toast */
export type ToastFn = (message: string) => void;
export const ToastContext = createContext<ToastFn | null>(null);
export const useToast = () => useRequired(ToastContext, 'useToast');

/* ---------------------------------------------------------------- Confirmação */
export interface ConfirmOptions {
  title: string;
  text: string;
  ok: string;
  danger?: boolean;
}
export type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
export const ConfirmContext = createContext<ConfirmFn | null>(null);
export const useConfirm = () => useRequired(ConfirmContext, 'useConfirm');

/* ---------------------------------------------------------------- Dados da loja */
export interface StoreActions {
  saveProduct(input: ProductFormInput): Promise<ApiResult<{ product: Product }>>;
  patchProduct(id: string, flags: ProductFlags): Promise<ApiResult>;
  moveStock(input: StockMoveInput): Promise<ApiResult<{ product: Product }>>;
  registerSale(items: SaleItem[]): Promise<ApiResult<{ sale: Sale }>>;
  cancelSale(saleId: string): Promise<ApiResult>;
  saveCategory(input: { id: string | null; name: string }): Promise<ApiResult<{ created: boolean }>>;
  toggleCategory(id: string): Promise<ApiResult<{ active: boolean }>>;
  saveSettings(settings: Settings): Promise<ApiResult>;
  resetDemo(): Promise<ApiResult>;
}
export interface StoreContextValue {
  data: StoreData;
  /** true quando a última gravação no navegador falhou (alterações só valem até recarregar). */
  storageFail: boolean;
  /** false quando o navegador não oferece armazenamento persistente (ex.: modo privado restrito). */
  persistent: boolean;
  actions: StoreActions;
}
export const StoreContext = createContext<StoreContextValue | null>(null);
export const useStore = () => useRequired(StoreContext, 'useStore');

/* ---------------------------------------------------------------- Encomenda */
export interface CartContextValue {
  cart: Cart;
  lines: CartLine[];
  count: number;
  notice: string | null;
  dismissNotice(): void;
  add(productId: string, qty: number): void;
  setQty(productId: string, qty: number): void;
  clear(): void;
}
export const CartContext = createContext<CartContextValue | null>(null);
export const useCart = () => useRequired(CartContext, 'useCart');

/* ---------------------------------------------------------------- Sobreposições da loja */
export interface WhatsAppDraft {
  text: string;
  step: 1 | 2;
  fromCart: boolean;
}
export interface UiContextValue {
  cartOpen: boolean;
  setCartOpen(open: boolean): void;
  detailId: string | null;
  openDetail(id: string): void;
  closeDetail(): void;
  wa: WhatsAppDraft | null;
  setWa(wa: WhatsAppDraft | null): void;
  /** Navega para uma seção da loja (sai do painel se necessário). */
  goToSection(id: string): void;
}
export const UiContext = createContext<UiContextValue | null>(null);
export const useUi = () => useRequired(UiContext, 'useUi');
