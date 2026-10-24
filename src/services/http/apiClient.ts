import { authErrorCode } from '../auth/authClient';
import type { FieldErrors } from '../../domain/types';

/**
 * Requisições JSON ao FastAPI (rotas públicas e administrativas), com tempo limite e
 * erros normalizados. Quem envia é um `Send`: `fetch` direto (público) ou `AdminHttp.request`
 * (administrativo, que já cuida do token). Nada aqui registra tokens, corpos ou respostas.
 *
 * Formato de erro do servidor: `{"error": {"code", "message", "fieldErrors"?}}`.
 */
export type Send = (path: string, init: RequestInit) => Promise<Response>;

export type ApiFailure =
  | { kind: 'http'; status: number; code: string; serverMessage: string | null; fieldErrors?: FieldErrors }
  /** Sem resposta (servidor fora do ar, sem internet, CORS). O resultado de uma escrita é desconhecido. */
  | { kind: 'network' }
  /** Sem resposta dentro do prazo. O resultado de uma escrita é desconhecido. */
  | { kind: 'timeout' }
  /** Cancelada por quem chamou (ex.: tela fechada, logout). */
  | { kind: 'aborted' }
  /** Resposta 2xx em formato inesperado. */
  | { kind: 'invalid-response' };

export class ApiRequestError extends Error {
  readonly failure: ApiFailure;
  constructor(failure: ApiFailure) {
    super(`API: ${failure.kind}${failure.kind === 'http' ? ` ${failure.status} ${failure.code}` : ''}`);
    this.name = 'ApiRequestError';
    this.failure = failure;
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface JsonRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Envia e devolve o corpo JSON de uma resposta 2xx; qualquer outra situação vira `ApiRequestError`.
 *
 * O tempo limite e o cancelamento valem para a operação inteira (token, envio, cabeçalhos e leitura
 * do corpo): timer e listener só são liberados no `finally`, depois de consumido o corpo.
 */
export async function requestJson(send: Send, path: string, req: JsonRequest = {}): Promise<unknown> {
  // Sessão já encerrada (ou chamada cancelada): nada é enviado.
  if (req.signal?.aborted) throw new ApiRequestError({ kind: 'aborted' });
  // Controlador local para o tempo limite; ele segue o sinal de quem chamou (não o substitui).
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  req.signal?.addEventListener('abort', onAbort);
  // Rejeita assim que o controlador aborta, mesmo que o transporte (ou o corpo) ignore o sinal.
  let onCancel = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onCancel = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    controller.signal.addEventListener('abort', onCancel, { once: true });
  });
  cancelled.catch(() => {}); // só é observada pelas corridas abaixo
  const cancellation = (): ApiFailure | null => (timedOut ? { kind: 'timeout' } : req.signal?.aborted ? { kind: 'aborted' } : null);
  const throwIfCancelled = () => {
    const failure = cancellation();
    if (failure) throw new ApiRequestError(failure);
  };

  const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    let response: Response;
    try {
      response = await Promise.race([
        send(path, {
          method: req.method ?? 'GET',
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: controller.signal,
        }),
        cancelled,
      ]);
    } catch (error) {
      throw new ApiRequestError(cancellation() ?? sendFailure(error));
    }
    // Resposta que chegou depois do cancelamento (ex.: logout): descartada sem ser interpretada.
    throwIfCancelled();

    let body: unknown;
    try {
      body = await Promise.race([response.json(), cancelled]);
    } catch (error) {
      throwIfCancelled();
      // Conexão interrompida no meio do corpo de um 2xx: a escrita pode ter sido aplicada.
      if (response.ok && !(error instanceof SyntaxError)) throw new ApiRequestError({ kind: 'network' });
      body = undefined;
    }
    throwIfCancelled();
    if (!response.ok) throw new ApiRequestError(httpFailure(response.status, body));
    if (body === undefined) throw new ApiRequestError({ kind: 'invalid-response' });
    return body;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', onCancel);
  }
}

function sendFailure(error: unknown): ApiFailure {
  // Falha ao obter o token do Firebase: sessão encerrada (401) ou rede.
  const code = authErrorCode(error);
  if (code === 'auth/network-request-failed') return { kind: 'network' };
  if (code?.startsWith('auth/')) return { kind: 'http', status: 401, code: 'unauthorized', serverMessage: null };
  return { kind: 'network' };
}

function httpFailure(status: number, body: unknown): ApiFailure {
  const error = (body as { error?: unknown } | undefined)?.error as { code?: unknown; message?: unknown; fieldErrors?: unknown } | undefined;
  const code = typeof error?.code === 'string' ? error.code : 'http_error';
  const serverMessage = typeof error?.message === 'string' && error.message.length <= 300 ? error.message : null;
  const fieldErrors = parseFieldErrors(error?.fieldErrors);
  return { kind: 'http', status, code, serverMessage, ...(fieldErrors && { fieldErrors }) };
}

function parseFieldErrors(raw: unknown): FieldErrors | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: FieldErrors = {};
  for (const [field, message] of Object.entries(raw)) {
    if (typeof message === 'string') out[field] = fieldMessage(message);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Mensagens de campo: as regras de negócio do servidor já vêm em português; as do Pydantic
 * (validação de formato, em inglês) viram mensagens genéricas.
 */
export function fieldMessage(message: string): string {
  const custom = /^Value error, (.+)$/.exec(message);
  if (custom) return custom[1];
  if (/^String should have at least/.test(message)) return 'Texto muito curto.';
  if (/^String should have at most/.test(message)) return 'Texto muito longo.';
  if (/^(Input should|Field required|String should|Extra inputs)/.test(message)) return 'Valor inválido.';
  return message;
}

/* ------------------------------------------------------------------ mensagens */

export const MESSAGES = {
  network: 'Sem conexão com o servidor. Verifique a internet e tente novamente.',
  timeout: 'O servidor demorou para responder. Tente novamente.',
  aborted: 'Operação cancelada.',
  invalid: 'Resposta inesperada do servidor. Tente novamente em instantes.',
  unauthorized: 'Sua sessão expirou. Entre novamente.',
  forbidden: 'Você não tem permissão para esta operação.',
  notFound: 'Registro não encontrado. A lista foi atualizada.',
  conflict: 'A operação conflita com o estado atual. A lista foi atualizada.',
  validation: 'Revise os campos destacados.',
  busy: 'Muitas operações simultâneas sobre os mesmos dados. Tente novamente.',
  unavailable: 'Serviço temporariamente indisponível. Tente novamente em instantes.',
  server: 'Erro interno no servidor. Tente novamente em instantes.',
};

/** Mensagem para a interface. Nunca repassa detalhes de erros 5xx do servidor. */
export function failureMessage(f: ApiFailure): string {
  switch (f.kind) {
    case 'network':
      return MESSAGES.network;
    case 'timeout':
      return MESSAGES.timeout;
    case 'aborted':
      return MESSAGES.aborted;
    case 'invalid-response':
      return MESSAGES.invalid;
    case 'http':
      switch (f.status) {
        case 401:
          return MESSAGES.unauthorized;
        case 403:
          return MESSAGES.forbidden;
        case 404:
          return f.serverMessage ?? MESSAGES.notFound;
        case 409:
          return f.serverMessage ?? MESSAGES.conflict;
        case 400:
        case 422:
          return f.serverMessage ?? MESSAGES.validation;
        case 503:
          return f.code === 'database_busy' ? MESSAGES.busy : MESSAGES.unavailable;
        default:
          return f.status >= 500 ? MESSAGES.server : (f.serverMessage ?? MESSAGES.server);
      }
  }
}

/** A requisição pode ter sido aplicada no servidor sem que a resposta chegasse. */
export const outcomeUnknown = (f: ApiFailure) => f.kind === 'network' || f.kind === 'timeout' || (f.kind === 'http' && f.status >= 500 && f.status !== 503);

/** Pode ser repetida com a mesma chave de idempotência sem risco de duplicar a operação. */
export const retryableWithSameKey = (f: ApiFailure) => f.kind === 'network' || f.kind === 'timeout' || (f.kind === 'http' && f.status === 503);

export const asFailure = (error: unknown): ApiFailure =>
  error instanceof ApiRequestError ? error.failure : { kind: 'invalid-response' };
