import { createSeedData } from '../data/seed';
import * as ops from '../domain/operations';
import type { Result, StoreData } from '../domain/types';
import { SCHEMA_VERSION, parseStoredData, type StoredEnvelope } from './schema';
import type { ApiResult, StoreApi } from './storeApi';
import { readJSON, writeJSON, type KeyValueStorage } from './storage';

export const STORE_KEY = 'mdp-react-demo-v1';

export interface LocalStoreApiOptions {
  storage: KeyValueStorage;
  persistent?: boolean;
  key?: string;
  now?: () => number;
}

/**
 * Implementação demonstrativa do `StoreApi`: estado em memória + cópia no localStorage.
 * Não é solução de produção — serve para a validação do proprietário antes do backend.
 */
export function createLocalStoreApi({ storage, persistent = true, key = STORE_KEY, now = Date.now }: LocalStoreApiOptions): StoreApi {
  let state: StoreData | null = null;

  const current = (): StoreData => {
    if (!state) {
      state = parseStoredData(readJSON(storage, key)) ?? createSeedData(now());
    }
    return state;
  };

  const persist = (data: StoreData) =>
    writeJSON(storage, key, { version: SCHEMA_VERSION, savedAt: now(), data } satisfies StoredEnvelope);

  /** Aplica um resultado de operação de domínio: grava, atualiza a memória e devolve o novo estado. */
  function commit<T extends { data: StoreData }>(r: Result<T>): ApiResult<Omit<T, 'data'>> {
    if (!r.ok) return { ok: false, error: r.error, fieldErrors: r.fieldErrors };
    const { data, ...rest } = r.value;
    const persisted = persist(data);
    state = data;
    return { ok: true, data, persisted, ...rest } as ApiResult<Omit<T, 'data'>>;
  }

  const wrap = (r: Result<StoreData>) => (r.ok ? { ok: true as const, value: { data: r.value } } : r);

  return {
    async load() {
      const stored = parseStoredData(readJSON(storage, key));
      state = stored ?? createSeedData(now());
      if (!stored) persist(state);
      return { data: state, source: stored ? 'stored' : 'seed', persistent };
    },

    async saveProduct(input) {
      const data = current();
      const r = ops.saveProduct(data, input, now());
      if (!r.ok) return { ok: false, error: r.error, fieldErrors: r.fieldErrors };
      const previousImage = input.id ? data.products.find((p) => p.id === input.id)?.imageUrl : '';
      const newImage = !!input.imageUrl && input.imageUrl !== previousImage;
      if (!persist(r.value.data) && newImage) {
        // Sem espaço para a nova foto: não aplica, para não perder a imagem no próximo reload.
        return {
          ok: false,
          storageFull: true,
          error: 'O armazenamento do navegador está cheio. Remova a imagem ou use um arquivo menor para salvar.',
        };
      }
      return commit(r);
    },

    async patchProduct(id, flags) {
      return commit(wrap(ops.patchProductFlags(current(), id, flags, now())));
    },

    async moveStock(input) {
      return commit(ops.applyStockMove(current(), input, now()));
    },

    async registerSale(items) {
      return commit(ops.registerSale(current(), items, now()));
    },

    async cancelSale(saleId) {
      return commit(wrap(ops.cancelSale(current(), saleId, now())));
    },

    async saveCategory(input) {
      return commit(ops.saveCategory(current(), input));
    },

    async toggleCategory(id) {
      return commit(ops.toggleCategory(current(), id));
    },

    async saveSettings(settings) {
      const v = ops.validateSettings(settings);
      if (!v.ok) return { ok: false, error: v.error, fieldErrors: v.fieldErrors };
      return commit({ ok: true, value: { data: { ...current(), settings: v.value } } });
    },

    async resetDemo() {
      return commit({ ok: true, value: { data: createSeedData(now()) } });
    },
  };
}
