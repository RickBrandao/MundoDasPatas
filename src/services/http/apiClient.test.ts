import { describe, expect, it, vi } from 'vitest';
import { json } from '../../test/fakeAuth';
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
