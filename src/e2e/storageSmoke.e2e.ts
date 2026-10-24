/**
 * TASK 07A — fotos de ponta a ponta: camada de dados do React (`createAdminStoreApi`) → FastAPI real →
 * Cloud Storage **Emulator** (arquivo) + Firestore Emulator (produto) → vitrine pública sem login.
 *
 * Mesmas travas de `emulatorSmoke.e2e.ts` (projeto demo-*, hosts loopback, health "emulator"), mais o
 * Storage: `FIREBASE_STORAGE_EMULATOR_HOST` loopback e `storage.status = "emulator"` no /health.
 * Executar com `npm run test:e2e:emulator` (o runner define as variáveis e sobe tudo).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../services/auth/authClient';
import { createAdminHttp } from '../services/auth/adminHttp';
import { createAdminStoreApi } from '../services/http/adminStoreApi';
import { createPublicStoreApi } from '../services/http/publicStoreApi';
import type { StoreApi } from '../services/storeApi';

const API_URL = process.env.E2E_API_URL ?? '';
const PROJECT = process.env.E2E_PROJECT_ID ?? '';
const FIRESTORE = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '';
const STORAGE = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '';
const BUCKET = process.env.E2E_STORAGE_BUCKET ?? '';
const LOOPBACK = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const ADMIN_UID = 'e2e-admin-uid';
const OTHER_UID = 'e2e-intruso-uid';

const b64 = (s: string, type: string) => new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))], { type });
// 24×16 px gerados com o Pillow (arquivos válidos de verdade).
const JPEG = b64(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAQABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCjRRRX1h8UFFFFAH//2Q==',
  'image/jpeg',
);
const PNG = b64('iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAI0lEQVR4nGOU6znBQA3ARBVTGEYNIgaMBjZhMBpGhMHgCyMA4nwBkqp981kAAAAASUVORK5CYII=', 'image/png');
const WEBP = b64('UklGRkQAAABXRUJQVlA4IDgAAAAwAwCdASoYABAAPm0qkUWkIqGYBABABsSgC1FoB+AACN5AAP7hw3/5Z8/hs78f/z8zu3F/QNvgAA==', 'image/webp');

async function ensureUser(localId: string, email: string, password: string) {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, email, password }),
  });
  if (!r.ok && !(await r.text()).includes('DUPLICATE')) throw new Error(`Auth Emulator recusou o usuário ${localId}`);
}

async function signIn(uid: string, email: string, password: string): Promise<AuthUser> {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const { idToken } = (await r.json()) as { idToken?: string };
  if (!idToken) throw new Error('login no Auth Emulator falhou');
  return { uid, email, getIdToken: async () => idToken };
}

const adminApiFor = (user: AuthUser, signal?: AbortSignal) => {
  const http = createAdminHttp(API_URL);
  return createAdminStoreApi({ send: (path, init) => http.request(user, path, init), signal });
};

/** Objetos no Storage Emulator (API do GCS; o emulador aceita "Bearer owner" como administrador local). */
async function storageObjects(): Promise<string[]> {
  const r = await fetch(`http://${STORAGE}/storage/v1/b/${BUCKET}/o?prefix=products%2F`, { headers: { Authorization: 'Bearer owner' } });
  return (((await r.json()) as { items?: { name: string }[] }).items ?? []).map((i) => i.name);
}

let admin: AuthUser;
let api: StoreApi;
let categoryId: string;

async function newProduct(name: string) {
  const r = await api.saveProduct({
    id: null,
    name,
    categoryId,
    brand: '',
    description: '',
    imageUrl: '',
    price: '10,00',
    showPrice: true,
    stock: '2',
    minStock: '0',
    published: true,
    featured: false,
  });
  if (!r.ok) throw new Error(r.error);
  return r.product;
}

beforeAll(async () => {
  if (!PROJECT.startsWith('demo-') || !BUCKET.startsWith('demo-')) throw new Error('Projeto/bucket fora da emulação: abortado.');
  for (const host of [FIRESTORE, AUTH, STORAGE]) if (!LOOPBACK.test(host)) throw new Error('Emulador ausente ou fora da máquina local: abortado.');
  if (!LOOPBACK.test(new URL(API_URL || 'http://invalido').host)) throw new Error('E2E_API_URL fora da máquina local: abortado.');
  const health = (await (await fetch(`${API_URL}/health`)).json()) as { dependencies: Record<string, { status: string }> };
  if (health.dependencies.database.status !== 'emulator' || health.dependencies.storage?.status !== 'emulator') {
    throw new Error('A API não está ligada aos emuladores de banco e Storage: abortado.');
  }
  expect((await fetch(`http://${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })).ok).toBe(true);
  expect((await fetch(`http://${STORAGE}/internal/reset`, { method: 'POST' })).ok).toBe(true);
  await ensureUser(ADMIN_UID, 'admin@e2e.test', 'senha-e2e-123');
  await ensureUser(OTHER_UID, 'intruso@e2e.test', 'senha-e2e-456');
  admin = await signIn(ADMIN_UID, 'admin@e2e.test', 'senha-e2e-123');
  api = adminApiFor(admin);
  await api.load();
  const cat = await api.saveCategory({ id: null, name: 'Fotos E2E' });
  if (!cat.ok) throw new Error(cat.error);
  categoryId = cat.data.categories[0].id;
});

describe('fotos: React → FastAPI → Storage Emulator → vitrine', () => {
  it('envio disponível; JPEG, PNG e WebP aceitos, armazenados como WebP e visíveis sem login', async () => {
    expect(await api.imageUploadConfig!()).toEqual({ available: true, maxBytes: 2 * 1024 * 1024 });
    for (const [name, blob] of [['JPEG', JPEG], ['PNG', PNG], ['WebP', WEBP]] as const) {
      const p = await newProduct(`Foto ${name}`);
      expect(p.imageUrl).toBe(''); // produto sem foto até o envio
      const r = await api.uploadProductImage!(p.id, blob);
      if (!r.ok) throw new Error(r.error);
      expect(r.product.imageUrl).toContain(`/v0/b/${BUCKET}/o/products%2F${p.id}%2Fimages%2F`);

      // Visitante: catálogo público sem token e download direto do Storage, sem credenciais.
      const pub = await createPublicStoreApi(API_URL).load();
      const url = pub.data.products.find((x) => x.id === p.id)!.imageUrl;
      expect(url).toBe(r.product.imageUrl);
      const file = await fetch(url);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('image/webp');
      const bytes = new Uint8Array(await file.arrayBuffer());
      expect(String.fromCharCode(...bytes.slice(0, 4), ...bytes.slice(8, 12))).toBe('RIFFWEBP');
    }
    expect(await storageObjects()).toHaveLength(3);
  });

  it('substituição remove só o arquivo anterior do próprio produto; remoção limpa o Storage', async () => {
    const before = await storageObjects();
    const p = await newProduct('Foto Troca');
    const first = await api.uploadProductImage!(p.id, JPEG);
    const second = await api.uploadProductImage!(p.id, PNG);
    if (!first.ok || !second.ok) throw new Error('envio falhou');
    expect(second.product.imageUrl).not.toBe(first.product.imageUrl);
    const mine = (await storageObjects()).filter((n) => n.startsWith(`products/${p.id}/`));
    expect(mine).toHaveLength(1);
    // A URL antiga deixa de servir o arquivo (o emulador responde 403 para objeto inexistente; a produção, 404).
    expect([403, 404]).toContain((await fetch(first.product.imageUrl)).status);

    const removed = await api.removeProductImage!(p.id);
    expect(removed.ok && removed.product.imageUrl).toBe('');
    expect(await storageObjects()).toEqual(before); // fotos dos outros produtos intactas
  });

  it('recusas: conteúdo falso, tipo perigoso, produto inexistente, sem token e usuário não autorizado', async () => {
    const p = await newProduct('Foto Recusas');
    const before = await storageObjects();
    const fake = await api.uploadProductImage!(p.id, new Blob(['<script>alert(1)</script>'], { type: 'image/jpeg' }));
    expect(fake).toMatchObject({ ok: false, fieldErrors: { image: expect.stringContaining('não corresponde') } });
    const svg = await api.uploadProductImage!(p.id, new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }));
    expect(svg).toMatchObject({ ok: false, fieldErrors: { image: 'Formato não suportado. Use JPEG, PNG ou WebP.' } });
    const big = await api.uploadProductImage!(p.id, new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/webp' }));
    expect(big).toMatchObject({ ok: false, fieldErrors: { image: 'Arquivo grande demais para envio.' } });
    const missing = await api.uploadProductImage!('produto-inexistente', JPEG);
    expect(missing).toMatchObject({ ok: false });
    expect(!missing.ok && missing.error).toBe('Produto não encontrado.');

    const anon = await fetch(`${API_URL}/api/v1/admin/products/${p.id}/image`, { method: 'PUT', body: JPEG, headers: { 'Content-Type': 'image/jpeg' } });
    expect(anon.status).toBe(401);
    const intruso = await signIn(OTHER_UID, 'intruso@e2e.test', 'senha-e2e-456');
    const forbidden = await adminApiFor(intruso).uploadProductImage!(p.id, JPEG);
    expect(forbidden).toMatchObject({ ok: false, error: 'Você não tem permissão para esta operação.' });
    expect(await storageObjects()).toEqual(before);
  });

  it('acesso direto ao Storage pelo navegador é negado (regras deny-all); só a URL com token lê', async () => {
    const p = await newProduct('Foto Regras');
    const r = await api.uploadProductImage!(p.id, WEBP);
    if (!r.ok) throw new Error(r.error);
    const base = r.product.imageUrl.split('?')[0];
    expect((await fetch(`${base}?alt=media`)).status).toBe(403);
    expect((await fetch(`http://${STORAGE}/v0/b/${BUCKET}/o?prefix=products%2F`)).status).toBe(403);
    const upload = await fetch(`http://${STORAGE}/v0/b/${BUCKET}/o?name=products%2Fx%2Fimages%2Fy.webp`, { method: 'POST', body: WEBP });
    expect(upload.status).toBe(403);
    expect((await fetch(base, { method: 'DELETE' })).status).toBe(403);
    // Usuário Firebase autenticado (não basta estar logado): também negado.
    const token = await admin.getIdToken();
    const authed = await fetch(`http://${STORAGE}/v0/b/${BUCKET}/o?name=products%2Fx%2Fimages%2Fz.webp`, {
      method: 'POST',
      body: WEBP,
      headers: { Authorization: `Firebase ${token}` },
    });
    expect(authed.status).toBe(403);
  });

  it('sessão encerrada durante o envio: nada é aplicado na tela e nada novo é enviado', async () => {
    const p = await newProduct('Foto Logout');
    const controller = new AbortController();
    const scoped = adminApiFor(admin, controller.signal);
    await scoped.load();
    const pending = scoped.uploadProductImage!(p.id, JPEG);
    controller.abort(); // logout
    const r = await pending;
    expect(r).toMatchObject({ ok: false, aborted: true });
    const after = await scoped.uploadProductImage!(p.id, JPEG);
    expect(after).toMatchObject({ ok: false, aborted: true });
  });
});
