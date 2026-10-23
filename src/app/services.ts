import { resolveAdminAccess, type AdminAccess } from '../services/auth/adminAccess';
import { createCartStorage } from '../services/cartStorage';
import { createPublicStoreApi } from '../services/http/publicStoreApi';
import { resolveDataSource, type DataSource } from '../services/dataSource';
import { createLocalStoreApi } from '../services/localStoreApi';
import { getBrowserStorage } from '../services/storage';
import type { StoreApi } from '../services/storeApi';

/**
 * Ponto único de escolha das implementações de serviço.
 *
 * As comparações diretas com `import.meta.env` são resolvidas no build: na demonstração
 * (`VITE_STORE_DATA_SOURCE` ausente/`local` e `VITE_ADMIN_AUTH_MODE=demo`) os clientes HTTP
 * e o SDK do Firebase são eliminados do pacote publicado.
 */
const { storage, persistent } = getBrowserStorage();

export const dataSource: DataSource = resolveDataSource({
  VITE_STORE_DATA_SOURCE: import.meta.env.VITE_STORE_DATA_SOURCE,
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
});

/**
 * Catálogo (e, na demonstração, também o painel). Com a API, somente leitura pública.
 * O primeiro teste é resolvido no build: o pacote da API não leva os dados fictícios, e o da demonstração não leva o cliente HTTP.
 */
export const storeApi: StoreApi =
  import.meta.env.VITE_STORE_DATA_SOURCE === 'api'
    ? dataSource.kind === 'api'
      ? createPublicStoreApi(dataSource.apiBaseUrl)
      : unavailableStoreApi()
    : dataSource.kind === 'local'
      ? createLocalStoreApi({ storage, persistent })
      : unavailableStoreApi();

export const cartStorage = createCartStorage(storage);

/** Acesso ao painel. No modo demonstração o ramo do Firebase (SDK e configuração) é eliminado do pacote. */
export const adminAccess: AdminAccess =
  import.meta.env.VITE_ADMIN_AUTH_MODE === 'firebase'
    ? resolveAdminAccess(
        {
          VITE_ADMIN_AUTH_MODE: 'firebase',
          VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
          VITE_FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY,
          VITE_FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
          VITE_FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID,
          VITE_FIREBASE_APP_ID: import.meta.env.VITE_FIREBASE_APP_ID,
          VITE_FIREBASE_MESSAGING_SENDER_ID: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
        },
        (config) => import('../services/auth/firebaseAuthClient').then((m) => m.createFirebaseAuthClient(config)),
      )
    : resolveAdminAccess({ VITE_ADMIN_AUTH_MODE: import.meta.env.VITE_ADMIN_AUTH_MODE });

/** Configuração de dados inválida: o catálogo mostra erro em vez de cair para os dados locais. */
function unavailableStoreApi(): StoreApi {
  const fail = async () => ({ ok: false as const, error: 'Origem dos dados não configurada.' });
  return {
    source: 'api-public',
    load: () => Promise.reject(new Error('VITE_STORE_DATA_SOURCE inválida')),
    saveProduct: fail,
    patchProduct: fail,
    moveStock: fail,
    registerSale: fail,
    cancelSale: fail,
    saveCategory: fail,
    toggleCategory: fail,
    saveSettings: fail,
    resetDemo: fail,
  };
}
