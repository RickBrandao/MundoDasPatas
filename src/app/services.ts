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
