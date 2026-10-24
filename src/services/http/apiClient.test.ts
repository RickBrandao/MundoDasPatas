import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, json } from '../../test/fakeAuth';
import { ApiRequestError, asFailure, failureMessage, fieldMessage, outcomeUnknown, requestJson, retryableWithSameKey, type Send } from './apiClient';

const sendOnce = (r: Response | Error): Send => vi.fn(async () => {
  if (r instanceof Error) throw r;
  return r;
});

async function failureOf(send: Send, req = {}) {
  try {
    await requestJson(send, '/x', req);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRequestError);
    return asFailure(error);
  }
  throw new Error('deveria falhar');
}

describe('requestJson', () => {
  it('envia JSON com Accept/Content-Type e devolve o corpo', async () => {
    const send = vi.fn<Send>(async () => json(201, { id: 'a' }));
    await expect(requestJson(send, '/p', { method: 'POST', body: { n: 1 }, headers: { 'Idempotency-Key': 'k-12345678' } })).resolves.toEqual({ id: 'a' });
    const [, init] = send.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"n":1}');
    expect(init.headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': 'k-12345678' });
  });

  it.each([
    [400, 'bad_request', 'Corpo inválido.', 'Corpo inválido.'],
    [401, 'unauthorized', 'qualquer', 'Sua sessão expirou. Entre novamente.'],
    [403, 'forbidden', 'qualquer', 'Você não tem permissão para esta operação.'],
    [404, 'not_found', 'Produto não encontrado.', 'Produto não encontrado.'],
    [409, 'insufficient_stock', 'Estoque insuficiente.', 'Estoque insuficiente.'],
    [422, 'validation_error', 'Revise os campos destacados.', 'Revise os campos destacados.'],
    [500, 'internal_error', 'Traceback: segredo do banco', 'Erro interno no servidor. Tente novamente em instantes.'],
    [503, 'database_busy', 'x', 'Muitas operações simultâneas sobre os mesmos dados. Tente novamente.'],
    [503, 'database_unavailable', 'detalhe interno', 'Serviço temporariamente indisponível. Tente novamente em instantes.'],
  ])('HTTP %i (%s) vira mensagem segura', async (status, code, message, expected) => {
    const f = await failureOf(sendOnce(json(status, { error: { code, message } })));
    expect(f).toMatchObject({ kind: 'http', status, code });
    expect(failureMessage(f)).toBe(expected);
  });

  it('mapeia fieldErrors e traduz mensagens do Pydantic', async () => {
    const f = await failureOf(
      sendOnce(
        json(422, {
          error: {
            code: 'validation_error',
            message: 'Revise os campos destacados.',
            fieldErrors: { name: 'String should have at least 3 characters', imageUrl: 'Value error, Use uma URL https:// ou deixe vazio.', categoryId: 'Categoria inexistente.' },
          },
        }),
      ),
    );
    expect(f.kind === 'http' && f.fieldErrors).toEqual({
      name: 'Texto muito curto.',
      imageUrl: 'Use uma URL https:// ou deixe vazio.',
      categoryId: 'Categoria inexistente.',
    });
    expect(fieldMessage('Input should be a valid integer')).toBe('Valor inválido.');
  });

  it('falha de rede: resultado desconhecido, pode repetir com a mesma chave', async () => {
    const f = await failureOf(sendOnce(new TypeError('Failed to fetch')));
    expect(f).toEqual({ kind: 'network' });
    expect(outcomeUnknown(f)).toBe(true);
    expect(retryableWithSameKey(f)).toBe(true);
    expect(failureMessage(f)).toMatch(/Sem conexão com o servidor/);
  });

  it('tempo limite cancela a requisição e é tratado como resultado desconhecido', async () => {
    vi.useFakeTimers();
    const send: Send = (_p, init) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const pending = failureOf(send, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const f = await pending;
    vi.useRealTimers();
    expect(f).toEqual({ kind: 'timeout' });
    expect(outcomeUnknown(f)).toBe(true);
  });

  it('cancelamento pelo chamador não é confundido com falha de rede', async () => {
    const controller = new AbortController();
    const send: Send = (_p, init) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const pending = failureOf(send, { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
  });

  it('erro de sessão do Firebase ao obter o token vira 401', async () => {
    const f = await failureOf(sendOnce(Object.assign(new Error('x'), { code: 'auth/user-token-expired' })));
    expect(f).toMatchObject({ kind: 'http', status: 401 });
  });

  it('resposta 2xx sem JSON é resposta inválida', async () => {
    const f = await failureOf(sendOnce(new Response('ok', { status: 200 })));
    expect(f).toEqual({ kind: 'invalid-response' });
  });

  it('409 e 422 não são repetidos automaticamente; 503 pode ser repetido com a mesma chave', () => {
    expect(retryableWithSameKey({ kind: 'http', status: 409, code: 'conflict', serverMessage: null })).toBe(false);
    expect(retryableWithSameKey({ kind: 'http', status: 422, code: 'validation_error', serverMessage: null })).toBe(false);
    expect(retryableWithSameKey({ kind: 'http', status: 503, code: 'database_busy', serverMessage: null })).toBe(true);
  });
});

/**
 * TASK 06F.1 (P1): tempo limite e cancelamento valem também depois dos cabeçalhos, durante a leitura
 * do corpo. Os corpos retidos ignoram o sinal (pior caso: transporte que não cancela a leitura).
 */
describe('requestJson — cancelamento durante a leitura do corpo', () => {
  afterEach(() => vi.useRealTimers());

  /** Cabeçalhos imediatos; `json()` só termina quando `release()` é chamado. */
  function slowBody(response: Response) {
    const body = deferred<void>();
    const read = response.json.bind(response);
    const reading = vi.fn(async () => {
      await body.promise;
      return read();
    });
    Object.defineProperty(response, 'json', { value: reading });
    const send = vi.fn<Send>(async () => response);
    return { send, reading, release: () => body.resolve() };
  }

  /** Espiona os listeners do sinal externo para provar que ficam ativos até o fim e depois saem. */
  function trackedSignal() {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    return { controller, add, remove };
  }

  const settle = (p: Promise<unknown>) => {
    const state = { resolved: vi.fn(), rejected: vi.fn() };
    p.then(state.resolved, state.rejected);
    return state;
  };

  it('A — logout com o corpo pendente: transporte abortado, rejeição imediata e sem sucesso tardio', async () => {
    const { send, reading, release } = slowBody(json(201, { id: 'venda' }));
    const { controller, remove } = trackedSignal();
    const pending = requestJson(send, '/x', { method: 'POST', body: {}, signal: controller.signal });
    const state = settle(pending);
    await vi.waitFor(() => expect(reading).toHaveBeenCalled());
    // Cabeçalhos recebidos e corpo em leitura: o listener da sessão ainda está ativo.
    expect(remove).not.toHaveBeenCalled();

    controller.abort();
    await expect(pending).rejects.toMatchObject({ failure: { kind: 'aborted' } });
    expect(send.mock.calls[0][1].signal!.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));

    release(); // o corpo chega depois do logout
    await new Promise((r) => setTimeout(r, 0));
    expect(state.resolved).not.toHaveBeenCalled();
    expect(state.rejected).toHaveBeenCalledTimes(1);
  });

  it('B — tempo limite durante a leitura do corpo: timeout, e o corpo tardio não vira sucesso', async () => {
    vi.useFakeTimers();
    const response = json(200, { id: 'a' });
    const read = response.json.bind(response);
    Object.defineProperty(response, 'json', { value: () => new Promise((r) => setTimeout(() => r(read()), 50)) });
    const send = vi.fn<Send>(async () => response);
    const pending = requestJson(send, '/x', { timeoutMs: 20 });
    const state = settle(pending);

    await vi.advanceTimersByTimeAsync(19);
    expect(state.rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.rejected).toHaveBeenCalledWith(expect.objectContaining({ failure: { kind: 'timeout' } }));
    expect(send.mock.calls[0][1].signal!.aborted).toBe(true);
    expect(outcomeUnknown({ kind: 'timeout' })).toBe(true);

    await vi.advanceTimersByTimeAsync(30); // corpo entregue aos 50 ms
    expect(state.resolved).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('C — cabeçalhos e corpo dentro do prazo: sucesso, sem timer nem listener pendentes', async () => {
    vi.useFakeTimers();
    const { send, release } = slowBody(json(200, { id: 'a' }));
    const { controller, add, remove } = trackedSignal();
    const pending = requestJson(send, '/x', { timeoutMs: 20, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(1); // o tempo limite segue ativo durante a leitura do corpo
    expect(remove).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toEqual({ id: 'a' });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove.mock.calls).toEqual(add.mock.calls.map(([type, listener]) => [type, listener]));
    expect(send.mock.calls[0][1].signal!.aborted).toBe(false);
  });

  it.each([
    [409, { error: { code: 'insufficient_stock', message: 'Estoque insuficiente.' } }, undefined],
    [
      422,
      { error: { code: 'validation_error', message: 'Revise os campos destacados.', fieldErrors: { qty: 'Input should be greater than 0' } } },
      { qty: 'Valor inválido.' },
    ],
  ])('D — HTTP %i com corpo lento dentro do prazo preserva o erro e os fieldErrors', async (status, body, fieldErrors) => {
    vi.useFakeTimers();
    const { send, release } = slowBody(json(status, body));
    const pending = failureOf(send, { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(10);
    release();
    const f = await pending;
    expect(f).toMatchObject({ kind: 'http', status, code: body.error.code, serverMessage: body.error.message });
    expect(f.kind === 'http' ? f.fieldErrors : null).toEqual(fieldErrors);
    expect(retryableWithSameKey(f)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('E — corpo inválido dentro do prazo é invalid-response, não timeout', async () => {
    vi.useFakeTimers();
    const { send, release } = slowBody(new Response('{"id":', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const pending = failureOf(send, { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(10);
    release();
    expect(await pending).toEqual({ kind: 'invalid-response' });
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('conexão interrompida no meio do corpo de um 2xx é falha de rede (resultado desconhecido)', async () => {
    const response = json(201, { id: 'a' });
    Object.defineProperty(response, 'json', { value: () => Promise.reject(new TypeError('terminated')) });
    const f = await failureOf(vi.fn<Send>(async () => response));
    expect(f).toEqual({ kind: 'network' });
    expect(outcomeUnknown(f)).toBe(true);
  });

  it('F — sinal já abortado: nenhuma requisição é enviada e nenhum timer é criado', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn<Send>();
    expect(await failureOf(send, { signal: controller.signal })).toEqual({ kind: 'aborted' });
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('transporte que ignora o sinal: o logout rejeita mesmo com o fetch ainda pendente', async () => {
    const controller = new AbortController();
    const never = deferred<Response>();
    const pending = failureOf(vi.fn<Send>(() => never.promise), { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
    never.resolve(json(200, { id: 'tarde' }));
  });
});
