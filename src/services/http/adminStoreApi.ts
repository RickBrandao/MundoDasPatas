import * as ops from '../../domain/operations';
import type { StoreData } from '../../domain/types';
import type { ApiResult, StoreApi } from '../storeApi';
import {
  productFieldErrors,
  productPayload,
  settingsPayload,
  toAdminStoreData,
  toCategory,
  toDashboard,
  toMovement,
  toProduct,
  toSale,
  toSettings,
  type DashboardSummary,
} from './adapters';
import { newIdempotencyKey } from './idempotency';
import {
  ApiRequestError,
  asFailure,
  failureMessage,
  outcomeUnknown,
  requestJson,
  retryableWithSameKey,
  type ApiFailure,
  type JsonRequest,
  type Send,
} from './apiClient';

const ADMIN = '/api/v1/admin';
/** Quantidade de vendas e movimentações carregadas no painel (máximo aceito pela API). */
export const HISTORY_LIMIT = 500;
const WRITE_TIMEOUT_MS = 20_000;
/** Envio de foto: arquivo de até ~2 MB, recodificação no servidor e gravação no Storage. */
const UPLOAD_TIMEOUT_MS = 60_000;
/** Novas tentativas automáticas — somente com a mesma chave de idempotência. */
const RETRY_DELAYS_MS = [600, 1800];

export interface AdminStoreApiOptions {
  /** Envia com o token do administrador (`AdminHttp.request` já ligado ao usuário). */
  send: Send;
  /** 401/403 em qualquer chamada: a sessão deve ser reconfirmada (`GET /admin/me`). */
  onAuthFailure?: () => void;
  /**
   * Escopo da sessão administrativa. Abortado: nada novo é enviado, requisições e esperas em andamento
   * terminam e respostas tardias são descartadas (o que o servidor já gravou permanece gravado).
   */
  signal?: AbortSignal;
  newKey?: () => string;
  retryDelaysMs?: number[];
  /** Espera entre tentativas; deve terminar cedo quando `signal` for abortado. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

type Failure = Extract<ApiResult, { ok: false }>;

/**
 * Painel administrativo via FastAPI + Firestore. O servidor é a única autoridade: estoque, IDs,
 * datas e indicadores vêm dele. Depois de cada escrita confirmada o estado é relido do servidor;
 * se a releitura falhar, aplica-se a resposta da própria escrita e o resultado sai como `stale`.
 *
 * Repetições automáticas acontecem só em venda, movimentação e cancelamento — sempre com a mesma
 * `Idempotency-Key`, que o servidor usa para não aplicar a operação duas vezes. Cadastros e edições
 * nunca são repetidos automaticamente.
 */
export function createAdminStoreApi({
  send,
  onAuthFailure,
  signal,
  newKey = newIdempotencyKey,
  retryDelaysMs = RETRY_DELAYS_MS,
  sleep = abortableSleep,
}: AdminStoreApiOptions): StoreApi {
  let current: StoreData | null = null;
  let dashboard: DashboardSummary | undefined;

  const get = (path: string) => requestJson(send, `${ADMIN}${path}`, { signal });

  const ensureActive = () => {
    if (signal?.aborted) throw new ApiRequestError({ kind: 'aborted' });
  };

  /** Espera entre tentativas que termina imediatamente se a sessão acabar. */
  async function pause(ms: number) {
    ensureActive();
    await sleep(ms, signal);
    ensureActive();
  }

  /** Sessão encerrada durante a operação: a interface não reage (sem mensagens, sem atualizar a tela). */
  const abortedResult = (write: boolean): Failure => ({
    ok: false,
    aborted: true,
    error: 'Operação interrompida: a sessão foi encerrada.',
    // Uma escrita já enviada pode ter sido concluída no servidor; o próximo acesso mostra o estado real.
    ...(write && { unknownOutcome: true }),
  });

  async function fetchAll(): Promise<{ data: StoreData; dashboard: DashboardSummary }> {
    const [products, categories, sales, movements, settings, dash] = await Promise.all([
      get('/products'),
      get('/categories'),
      get(`/sales?limit=${HISTORY_LIMIT}`),
      get(`/stock/movements?limit=${HISTORY_LIMIT}`),
      get('/settings'),
      get('/dashboard'),
    ]);
    try {
      current = toAdminStoreData({ products, categories, sales, movements, settings });
      dashboard = toDashboard(dash);
    } catch {
      throw new ApiRequestError({ kind: 'invalid-response' });
    }
    return { data: current, dashboard };
  }

  const state = (): StoreData => {
    if (!current) throw new Error('Dados do painel ainda não carregados.');
    return current;
  };

  async function write(path: string, req: JsonRequest, idempotent: boolean): Promise<unknown> {
    const full = { timeoutMs: WRITE_TIMEOUT_MS, ...req, signal };
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestJson(send, `${ADMIN}${path}`, full);
      } catch (error) {
        if (signal?.aborted) throw new ApiRequestError({ kind: 'aborted' });
        if (!idempotent || attempt >= retryDelaysMs.length || !retryableWithSameKey(asFailure(error))) throw error;
        await pause(retryDelaysMs[attempt]);
      }
    }
  }

  /** Escrita confirmada: relê tudo; se a releitura falhar, aplica a resposta recebida. */
  async function settle<T extends object>(merge: (d: StoreData) => StoreData, extra: T): Promise<ApiResult<T>> {
    // Resposta de escrita que chegou depois do fim da sessão: não é aplicada nem anunciada.
    if (signal?.aborted) return abortedResult(true) as ApiResult<T>;
    try {
      const fresh = await fetchAll();
      if (signal?.aborted) return abortedResult(true) as ApiResult<T>;
      return { ok: true, data: fresh.data, persisted: true, dashboard: fresh.dashboard, ...extra } as ApiResult<T>;
    } catch {
      if (signal?.aborted) return abortedResult(true) as ApiResult<T>;
      current = merge(state());
      return { ok: true, data: current, persisted: true, dashboard, stale: true, ...extra } as ApiResult<T>;
    }
  }

  /** Falha: mensagem segura; em conflito, ausência ou resultado desconhecido, os dados são relidos. */
  async function fail(error: unknown, idempotent: boolean, mapFields?: (f: ApiFailure) => Failure['fieldErrors']): Promise<Failure> {
    const f = asFailure(error);
    if (f.kind === 'aborted' || signal?.aborted) return abortedResult(true);
    if (f.kind === 'http' && (f.status === 401 || f.status === 403)) onAuthFailure?.();
    const unknown = outcomeUnknown(f);
    let message = failureMessage(f);
    if (unknown) {
      message += idempotent
        ? ' Você pode tentar de novo com segurança: a operação não será registrada duas vezes.'
        : ' Não foi possível confirmar se a alteração foi salva; confira a lista antes de repetir.';
    }
    const result: Failure = { ok: false, error: message };
    const fieldErrors = f.kind === 'http' ? (mapFields ? mapFields(f) : f.fieldErrors) : undefined;
    if (fieldErrors) result.fieldErrors = fieldErrors;
    if (unknown) result.unknownOutcome = true;
    if (unknown || (f.kind === 'http' && (f.status === 404 || f.status === 409))) {
      const fresh = await fetchAll().catch(() => null);
      if (signal?.aborted) return abortedResult(true);
      if (fresh) result.refreshed = fresh;
    }
    return result;
  }

  const invalid = (r: { ok: false; error: string; fieldErrors?: Failure['fieldErrors'] }): Failure => ({
    ok: false,
    error: r.error,
    ...(r.fieldErrors && { fieldErrors: r.fieldErrors }),
  });

  return {
    source: 'api-admin',
    signal,

    async load() {
      try {
        const r = await fetchAll();
        ensureActive();
        return { data: r.data, source: 'server', persistent: true, dashboard: r.dashboard };
      } catch (error) {
        const f = asFailure(error);
        if (!signal?.aborted && f.kind === 'http' && (f.status === 401 || f.status === 403)) onAuthFailure?.();
        throw error;
      }
    },

    async saveProduct(input) {
      const v = ops.validateProductForm(input, state().categories);
      if (!v.ok) return invalid(v);
      const payload = productPayload(input, v.value);
      try {
        const body =
          input.id == null
            ? await write('/products', { method: 'POST', body: { ...payload, stock: v.value.stock } }, false)
            : await write(`/products/${encodeURIComponent(input.id)}`, { method: 'PATCH', body: payload }, false);
        const product = toProduct(body);
        return settle((d) => ({ ...d, products: upsert(d.products, product) }), { product });
      } catch (error) {
        return fail(error, false, (f) => productFieldErrors(f.kind === 'http' ? f.fieldErrors : undefined));
      }
    },

    async patchProduct(id, flags) {
      const body = flags.archived ? { ...flags, published: false } : flags;
      try {
        const product = toProduct(await write(`/products/${encodeURIComponent(id)}`, { method: 'PATCH', body }, false));
        return settle((d) => ({ ...d, products: upsert(d.products, product) }), {});
      } catch (error) {
        return fail(error, false);
      }
    },

    async moveStock(input, options) {
      // Validação de formato com o saldo conhecido; o saldo real é decidido no servidor.
      const check = ops.applyStockMove(state(), input, Date.now());
      if (!check.ok) return invalid(check);
      const key = options?.idempotencyKey ?? newKey();
      const body = { productId: input.productId, type: input.type, qty: parseInt(input.qty, 10), note: input.note.trim() };
      try {
        const res = (await write('/stock/movements', { method: 'POST', body, headers: { 'Idempotency-Key': key } }, true)) as {
          movement?: unknown;
          product?: unknown;
        };
        const product = toProduct(res?.product);
        const movement = toMovement(res?.movement);
        return settle(
          (d) => ({ ...d, products: upsert(d.products, product), movements: [movement, ...d.movements.filter((m) => m.id !== movement.id)] }),
          { product },
        );
      } catch (error) {
        return fail(error, true);
      }
    },

    async registerSale(items, options) {
      if (!items.length) return { ok: false, error: 'Adicione pelo menos um produto.' };
      if (items.some((i) => !Number.isInteger(i.qty) || i.qty <= 0)) return { ok: false, error: 'Quantidades devem ser inteiras e positivas.' };
      const key = options?.idempotencyKey ?? newKey();
      const body = { items: items.map((i) => ({ productId: i.productId, qty: i.qty })) };
      try {
        const sale = toSale(await write('/sales', { method: 'POST', body, headers: { 'Idempotency-Key': key } }, true));
        return settle((d) => ({ ...d, sales: upsert(d.sales, sale) }), { sale });
      } catch (error) {
        return fail(error, true);
      }
    },

    async cancelSale(saleId, options) {
      const key = options?.idempotencyKey ?? newKey();
      try {
        const sale = toSale(
          await write(`/sales/${encodeURIComponent(saleId)}/cancel`, { method: 'POST', headers: { 'Idempotency-Key': key } }, true),
        );
        return settle((d) => ({ ...d, sales: upsert(d.sales, sale) }), {});
      } catch (error) {
        return fail(error, true);
      }
    },

    async saveCategory(input) {
      const name = input.name.trim();
      if (name.length < 2) return { ok: false, error: 'Informe o nome da categoria.', fieldErrors: { name: 'Informe o nome da categoria.' } };
      try {
        const body =
          input.id == null
            ? await write('/categories', { method: 'POST', body: { name } }, false)
            : await write(`/categories/${encodeURIComponent(input.id)}`, { method: 'PATCH', body: { name } }, false);
        const category = toCategory(body);
        return settle((d) => ({ ...d, categories: upsert(d.categories, category) }), { created: input.id == null });
      } catch (error) {
        return fail(error, false);
      }
    },

    async toggleCategory(id) {
      const c = state().categories.find((x) => x.id === id);
      if (!c) return { ok: false, error: 'Categoria não encontrada.' };
      try {
        const category = toCategory(await write(`/categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: { active: !c.active } }, false));
        return settle((d) => ({ ...d, categories: upsert(d.categories, category) }), { active: category.active });
      } catch (error) {
        return fail(error, false);
      }
    },

    async saveSettings(settings) {
      const v = ops.validateSettings(settings);
      if (!v.ok) return invalid(v);
      try {
        const saved = toSettings(await write('/settings', { method: 'PUT', body: settingsPayload(v.value) }, false));
        return settle((d) => ({ ...d, settings: saved }), {});
      } catch (error) {
        return fail(error, false);
      }
    },

    async resetDemo() {
      return { ok: false, error: 'Indisponível no ambiente real: os dados de demonstração nunca são importados para o servidor.' };
    },

    async imageUploadConfig() {
      try {
        const o = (await get('/images/config')) as { available?: unknown; maxBytes?: unknown };
        const available = o?.available === true && Number.isInteger(o.maxBytes) && (o.maxBytes as number) > 0;
        return { available, maxBytes: available ? (o.maxBytes as number) : 0 };
      } catch {
        // Sem confirmação do servidor, o envio não é oferecido (o cadastro continua funcionando).
        return { available: false, maxBytes: 0 };
      }
    },

    async uploadProductImage(productId, image) {
      try {
        const body = await write(
          `/products/${encodeURIComponent(productId)}/image`,
          { method: 'PUT', rawBody: image, timeoutMs: UPLOAD_TIMEOUT_MS },
          false,
        );
        const product = toProduct(body);
        return settle((d) => ({ ...d, products: upsert(d.products, product) }), { product });
      } catch (error) {
        return fail(error, false, imageFieldErrors);
      }
    },

    async removeProductImage(productId) {
      try {
        const product = toProduct(await write(`/products/${encodeURIComponent(productId)}/image`, { method: 'DELETE' }, false));
        return settle((d) => ({ ...d, products: upsert(d.products, product) }), { product });
      } catch (error) {
        return fail(error, false, imageFieldErrors);
      }
    },
  };
}

/** `setTimeout` cancelável: o timer e o listener são liberados no fim da espera ou no abort. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Erros do arquivo enviado: o formulário mostra a mensagem junto da foto. */
function imageFieldErrors(f: ApiFailure): Failure['fieldErrors'] {
  if (f.kind !== 'http' || ![413, 415, 422].includes(f.status)) return undefined;
  return { image: f.fieldErrors?.image ?? failureMessage(f) };
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [item, ...list];
}
