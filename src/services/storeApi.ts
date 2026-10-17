import type { ProductFlags, ProductFormInput, StockMoveInput } from '../domain/operations';
import type { FieldErrors, Product, Sale, SaleItem, Settings, StoreData } from '../domain/types';

/**
 * Contrato da camada de dados usado pela interface.
 *
 * Hoje a implementação é local (`createLocalStoreApi`, com localStorage).
 * Para o backend real, basta criar outra implementação deste contrato
 * (ex.: chamadas HTTP a uma API FastAPI) e trocá-la em `src/app/services.ts`.
 *
 * Cada mutação devolve o estado atualizado; uma implementação remota pode
 * devolver o estado relido do servidor após a operação.
 */
export type ApiResult<T = object> =
  | ({ ok: true; data: StoreData; /** false = aplicado só nesta sessão (falha ao salvar). */ persisted: boolean } & T)
  | { ok: false; error: string; fieldErrors?: FieldErrors; storageFull?: boolean };

export interface LoadResult {
  data: StoreData;
  /** Origem dos dados: salvos anteriormente, ou recém-criados a partir da demonstração. */
  source: 'stored' | 'seed';
  /** O armazenamento disponível é persistente? (false em navegação privada/bloqueada) */
  persistent: boolean;
}

export interface StoreApi {
  load(): Promise<LoadResult>;
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
