/** Envio de fotos pela camada HTTP do painel (TASK 07A), contra o FastAPI simulado. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API, json } from '../../test/fakeAuth';
import { createFakeBackend } from '../../test/fakeBackend';
import { createAdminStoreApi } from './adminStoreApi';
import { failureMessage, requestJson } from './apiClient';

afterEach(() => vi.unstubAllGlobals());

function setup(enabled = true) {
  const backend = createFakeBackend().install();
  backend.enableImages(enabled);
  const cat = backend.seedCategory('Rações');
  const p = backend.seedProduct({ categoryId: cat.id, name: 'Ração' });
  const controller = new AbortController();
  const send = (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer token-admin-uid');
    return fetch(`${API}${path}`, { ...init, headers });
  };
  const api = createAdminStoreApi({ send, signal: controller.signal });
  return { backend, p, api, controller };
}

const webp = (size = 1000) => new Blob([new Uint8Array(size)], { type: 'image/webp' });

describe('fotos via createAdminStoreApi', () => {
  it('envia o arquivo como corpo binário com o tipo do Blob e relê o estado', async () => {
    const { backend, p, api } = setup();
    await api.load();
    const r = await api.uploadProductImage!(p.id, webp());
    expect(r.ok && r.product.imageUrl).toMatch(/^https:\/\/storage\.test\//);
    expect(r.ok && r.data.products[0].imageUrl).toBe(backend.db.products[0].imageUrl);
    const put = backend.calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe(`/api/v1/admin/products/${p.id}/image`);
    expect(put.body).toBeUndefined(); // nada de JSON/Base64
    expect(backend.db.images.size).toBe(1);
  });

  it('IDs com caracteres especiais são codificados no caminho', async () => {
    const { backend, api } = setup();
    await api.load();
    await api.uploadProductImage!('../outro', webp());
    expect(backend.calls.find((c) => c.method === 'PUT')?.path).toBe('/api/v1/admin/products/..%2Foutro/image');
  });

  it('configuração: disponível só quando o servidor confirma', async () => {
    expect(await setup(true).api.imageUploadConfig!()).toEqual({ available: true, maxBytes: 2 * 1024 * 1024 });
    vi.unstubAllGlobals();
    expect(await setup(false).api.imageUploadConfig!()).toEqual({ available: false, maxBytes: 0 });
    vi.unstubAllGlobals();
    const { backend, api } = setup(true);
    backend.failNext('GET', '/api/v1/admin/images/config', 'network');
    expect(await api.imageUploadConfig!()).toEqual({ available: false, maxBytes: 0 });
  });

  it('Storage indisponível (503): mensagem própria, sem repetição automática', async () => {
    const { backend, p, api } = setup(false);
    await api.load();
    const r = await api.uploadProductImage!(p.id, webp());
    expect(r).toMatchObject({ ok: false, error: 'O envio de fotos está indisponível no momento. Tente novamente mais tarde.' });
    expect(backend.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('arquivo grande (413) e tipo recusado (415) viram erro do campo da foto', async () => {
    const { p, api } = setup();
    await api.load();
    const big = await api.uploadProductImage!(p.id, webp(2 * 1024 * 1024 + 1));
    expect(big).toMatchObject({ ok: false, fieldErrors: { image: 'Arquivo grande demais para envio.' } });
    const svg = await api.uploadProductImage!(p.id, new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    expect(svg).toMatchObject({ ok: false, fieldErrors: { image: 'Formato não suportado. Use JPEG, PNG ou WebP.' } });
  });

  it('remoção usa DELETE e devolve o produto sem foto', async () => {
    const { backend, p, api } = setup();
    await api.load();
    await api.uploadProductImage!(p.id, webp());
    const r = await api.removeProductImage!(p.id);
    expect(r.ok && r.product.imageUrl).toBe('');
    expect(backend.db.images.size).toBe(0);
    expect(backend.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/api/v1/admin/products/${p.id}/image`]);
  });

  it('sessão encerrada: nada é enviado', async () => {
    const { backend, p, api, controller } = setup();
    await api.load();
    controller.abort();
    const r = await api.uploadProductImage!(p.id, webp());
    expect(r).toMatchObject({ ok: false, aborted: true });
    expect(backend.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('falha de rede no envio: resultado incerto, estado relido', async () => {
    const { backend, p, api } = setup();
    await api.load();
    backend.failNext('PUT', `/api/v1/admin/products/${p.id}/image`, 'network');
    const r = await api.uploadProductImage!(p.id, webp());
    expect(r).toMatchObject({ ok: false, unknownOutcome: true });
    expect(!r.ok && r.refreshed?.data.products).toHaveLength(1);
  });
});

describe('requestJson com corpo binário', () => {
  it('não serializa o Blob e usa o Content-Type dele', async () => {
    const send = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(async () => json(200, { ok: true }));
    const blob = new Blob(['x'], { type: 'image/png' });
    await requestJson(send, '/x', { method: 'PUT', rawBody: blob });
    const init = send.mock.calls[0][1];
    expect(init.body).toBe(blob);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
  });

  it('mensagens de 413 e 503 storage_unavailable', () => {
    expect(failureMessage({ kind: 'http', status: 413, code: 'payload_too_large', serverMessage: null })).toBe('Arquivo grande demais para envio.');
    expect(failureMessage({ kind: 'http', status: 503, code: 'storage_unavailable', serverMessage: 'detalhe' })).toMatch(/^O envio de fotos está indisponível/);
  });
});
