import { createContext, useContext } from 'react';
import type { CartLine } from '../domain/cart';
import type { ProductFlags, ProductFormInput, StockMoveInput } from '../domain/operations';
import type { Cart, Product, Sale, SaleItem, Settings, StoreData } from '../domain/types';
import type { AdminAccess } from '../services/auth/adminAccess';
import type { DataSource } from '../services/dataSource';
import type { DashboardSummary } from '../services/http/adapters';
import type { ApiResult, ImageUploadConfig, MutationOptions, StoreSource } from '../services/storeApi';

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
  /** Abortado (ex.: fim da sessão do painel), o diálogo fecha sozinho e responde "não". */
  signal?: AbortSignal;
}
export type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
export const ConfirmContext = createContext<ConfirmFn | null>(null);
export const useConfirm = () => useRequired(ConfirmContext, 'useConfirm');

/* ---------------------------------------------------------------- Dados da loja */
export interface StoreActions {
  saveProduct(input: ProductFormInput): Promise<ApiResult<{ product: Product }>>;
  patchProduct(id: string, flags: ProductFlags): Promise<ApiResult>;
  moveStock(input: StockMoveInput, options?: MutationOptions): Promise<ApiResult<{ product: Product }>>;
  registerSale(items: SaleItem[], options?: MutationOptions): Promise<ApiResult<{ sale: Sale }>>;
  cancelSale(saleId: string, options?: MutationOptions): Promise<ApiResult>;
  saveCategory(input: { id: string | null; name: string }): Promise<ApiResult<{ created: boolean }>>;
  toggleCategory(id: string): Promise<ApiResult<{ active: boolean }>>;
  saveSettings(settings: Settings): Promise<ApiResult>;
  resetDemo(): Promise<ApiResult>;
  /** Envio de fotos para o servidor (a demonstração responde indisponível: usa a foto local do formulário). */
  imageUploadConfig(): Promise<ImageUploadConfig>;
  uploadProductImage(productId: string, image: Blob): Promise<ApiResult<{ product: Product }>>;
  removeProductImage(productId: string): Promise<ApiResult<{ product: Product }>>;
  /** Relê os dados da origem, se mais antigos que `maxAgeMs` (falha mantém o estado atual). */
  refresh(maxAgeMs?: number): Promise<void>;
}
export interface StoreContextValue {
  data: StoreData;
  /** `local` = demonstração no navegador; `api-*` = FastAPI + Firestore. */
  source: StoreSource;
  /** Indicadores calculados pelo servidor (somente no painel com a API). */
  dashboard?: DashboardSummary;
  /** true quando uma operação foi confirmada mas a releitura falhou (lista possivelmente desatualizada). */
  stale: boolean;
  /** true quando a última gravação no navegador falhou (alterações só valem até recarregar). */
  storageFail: boolean;
  /** false quando o navegador não oferece armazenamento persistente (ex.: modo privado restrito). */
  persistent: boolean;
  /** Gravações enviadas e ainda sem resposta. */
  pendingWrites: number;
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

/* ---------------------------------------------------------------- Acesso ao painel */
/** Modo de acesso ao painel (demonstração ou Firebase), escolhido em `services.ts`. */
export const AdminAccessContext = createContext<AdminAccess | null>(null);
export const useAdminAccess = () => useRequired(AdminAccessContext, 'useAdminAccess');

/** Origem dos dados (`local` ou API), escolhida em `services.ts`. */
export const DataSourceContext = createContext<DataSource | null>(null);
export const useDataSource = () => useRequired(DataSourceContext, 'useDataSource');
