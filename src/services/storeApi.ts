import type { ProductFlags, ProductFormInput, StockMoveInput } from '../domain/operations';
import type { FieldErrors, Product, Sale, SaleItem, Settings, StoreData } from '../domain/types';
import type { DashboardSummary } from './http/adapters';

/**
 * Contrato da camada de dados usado pela interface.
 *
 * Implementações (escolhidas em `src/app/services.ts` conforme `VITE_STORE_DATA_SOURCE`):
 * - `local`: `createLocalStoreApi` (demonstração, localStorage);
 * - `api-public`: `createPublicStoreApi` (catálogo via `GET /api/v1/public/catalog`, somente leitura);
 * - `api-admin`: `createAdminStoreApi` (painel autenticado, FastAPI + Firestore).
 *
 * Cada mutação devolve o estado atualizado; as implementações remotas devolvem o estado
 * relido do servidor após a operação.
 */
export type StoreSource = 'local' | 'api-public' | 'api-admin';

export type ApiResult<T = object> =
  | ({
      ok: true;
      data: StoreData;
      /** false = aplicado só nesta sessão (falha ao salvar no navegador). Sempre true na API. */
      persisted: boolean;
      /** Indicadores do servidor (somente `api-admin`). */
      dashboard?: DashboardSummary;
      /** A operação foi confirmada, mas a releitura falhou: a lista pode estar desatualizada. */
      stale?: boolean;
    } & T)
  | {
      ok: false;
      error: string;
      fieldErrors?: FieldErrors;
      storageFull?: boolean;
      /** Sem resposta do servidor: a operação pode ter sido aplicada. */
      unknownOutcome?: boolean;
      /** Estado relido do servidor após a falha (conflito, registro ausente ou resultado desconhecido). */
      refreshed?: { data: StoreData; dashboard?: DashboardSummary };
    };

export interface LoadResult {
  data: StoreData;
  /** Origem dos dados: salvos anteriormente, recém-criados a partir da demonstração, ou o servidor. */
  source: 'stored' | 'seed' | 'server';
  /** O armazenamento disponível é persistente? (false em navegação privada/bloqueada) */
  persistent: boolean;
  dashboard?: DashboardSummary;
}

/**
 * Operações sensíveis (venda, movimentação, cancelamento): a mesma chave identifica a mesma
 * intenção do usuário em todas as tentativas. Ignorada pela implementação local.
 */
export interface MutationOptions {
  idempotencyKey?: string;
}

export interface StoreApi {
  readonly source: StoreSource;
  load(): Promise<LoadResult>;
  saveProduct(input: ProductFormInput): Promise<ApiResult<{ product: Product }>>;
  patchProduct(id: string, flags: ProductFlags): Promise<ApiResult>;
  moveStock(input: StockMoveInput, options?: MutationOptions): Promise<ApiResult<{ product: Product }>>;
  registerSale(items: SaleItem[], options?: MutationOptions): Promise<ApiResult<{ sale: Sale }>>;
  cancelSale(saleId: string, options?: MutationOptions): Promise<ApiResult>;
  saveCategory(input: { id: string | null; name: string }): Promise<ApiResult<{ created: boolean }>>;
  toggleCategory(id: string): Promise<ApiResult<{ active: boolean }>>;
  saveSettings(settings: Settings): Promise<ApiResult>;
  resetDemo(): Promise<ApiResult>;
}
