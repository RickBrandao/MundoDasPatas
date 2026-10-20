import { resolveAdminAccess, type AdminAccess } from '../services/auth/adminAccess';
import { createCartStorage } from '../services/cartStorage';
import { createLocalStoreApi } from '../services/localStoreApi';
import { getBrowserStorage } from '../services/storage';
import type { StoreApi } from '../services/storeApi';

/**
 * Ponto único de escolha das implementações de serviço.
 * Para o backend real: `export const storeApi = createHttpStoreApi({ baseUrl })`.
 */
const { storage, persistent } = getBrowserStorage();

export const storeApi: StoreApi = createLocalStoreApi({ storage, persistent });
export const cartStorage = createCartStorage(storage);

/**
 * Acesso ao painel. A comparação direta com `import.meta.env` é resolvida no build: no modo
 * demonstração o ramo do Firebase (SDK e configuração) é eliminado do pacote publicado.
 */
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
