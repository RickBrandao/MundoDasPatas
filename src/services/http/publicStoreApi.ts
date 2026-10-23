import type { StoreApi } from '../storeApi';
import { toPublicStoreData } from './adapters';
import { ApiRequestError, requestJson, type Send } from './apiClient';

const READ_ONLY = { ok: false, error: 'Operação indisponível na área pública.' } as const;

/**
 * Catálogo público via FastAPI (`GET /api/v1/public/catalog`): sem login, sem token e somente leitura.
 * Nunca recebe vendas, movimentações, produtos ocultos nem configurações internas — o servidor
 * já filtra; as mutações recusam sempre (o painel usa `createAdminStoreApi`).
 */
export function createPublicStoreApi(apiBaseUrl: string, fetchFn: typeof fetch = (...a) => fetch(...a)): StoreApi {
  const send: Send = (path, init) => fetchFn(`${apiBaseUrl}${path}`, { ...init, credentials: 'omit', cache: 'no-cache' });

  return {
    source: 'api-public',

    async load() {
      const body = await requestJson(send, '/api/v1/public/catalog');
      try {
        return { data: toPublicStoreData(body), source: 'server', persistent: true };
      } catch {
        throw new ApiRequestError({ kind: 'invalid-response' });
      }
    },

    saveProduct: async () => READ_ONLY,
    patchProduct: async () => READ_ONLY,
    moveStock: async () => READ_ONLY,
    registerSale: async () => READ_ONLY,
    cancelSale: async () => READ_ONLY,
    saveCategory: async () => READ_ONLY,
    toggleCategory: async () => READ_ONLY,
    saveSettings: async () => READ_ONLY,
    resetDemo: async () => READ_ONLY,
  };
}
