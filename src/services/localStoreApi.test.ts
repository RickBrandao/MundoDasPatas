import { describe, expect, it } from 'vitest';
import { createCartStorage } from './cartStorage';
import { createLocalStoreApi, STORE_KEY } from './localStoreApi';
import { createMemoryStorage, type KeyValueStorage } from './storage';

const NOW = Date.UTC(2026, 9, 17, 12);
const make = (storage: KeyValueStorage) => createLocalStoreApi({ storage, now: () => NOW });

/** Armazenamento que aceita leituras mas falha ao gravar (cota excedida). */
function fullStorage(base = createMemoryStorage()): KeyValueStorage & { full: boolean } {
  const s = {
    full: false,
    getItem: (k: string) => base.getItem(k),
    removeItem: (k: string) => base.removeItem(k),
    setItem: (k: string, v: string) => {
      if (s.full) throw new DOMException('quota', 'QuotaExceededError');
      base.setItem(k, v);
    },
  };
  return s;
}

describe('persistência local', () => {
  it('primeira carga usa os dados fictícios e já salva', async () => {
    const storage = createMemoryStorage();
    const r = await make(storage).load();
    expect(r.source).toBe('seed');
    expect(r.data.products).toHaveLength(19);
    expect(storage.getItem(STORE_KEY)).toContain('"version":1');
  });

  it('alterações sobrevivem a um "reload" (nova instância, mesmo armazenamento)', async () => {
    const storage = createMemoryStorage();
    const api = make(storage);
    await api.load();
    const sale = await api.registerSale([{ productId: 'p6', qty: 2 }]);
    expect(sale.ok && sale.persisted).toBe(true);
    await api.saveSettings({ ...(await api.load()).data.settings, storeName: 'Loja Persistida' });

    const reloaded = await make(storage).load();
    expect(reloaded.source).toBe('stored');
    expect(reloaded.data.products.find((p) => p.id === 'p6')!.stock).toBe(18);
    expect(reloaded.data.sales[0].id).toBe('V-0007');
    expect(reloaded.data.settings.storeName).toBe('Loja Persistida');
  });

  it('dados corrompidos ou de outra versão voltam para a demonstração', async () => {
    for (const bad of ['{nao json', JSON.stringify({ version: 99, data: {} }), JSON.stringify({ version: 1, data: { products: [{ id: 'p1', stock: -3 }] } })]) {
      const storage = createMemoryStorage();
      storage.setItem(STORE_KEY, bad);
      const r = await make(storage).load();
      expect(r.source).toBe('seed');
      expect(r.data.products).toHaveLength(19);
    }
  });

  it('estoque negativo salvo é rejeitado na validação', async () => {
    const storage = createMemoryStorage();
    const api = make(storage);
    await api.load();
    const raw = JSON.parse(storage.getItem(STORE_KEY)!);
    raw.data.products[0].stock = -1;
    storage.setItem(STORE_KEY, JSON.stringify(raw));
    expect((await make(storage).load()).source).toBe('seed');
  });

  it('falha ao gravar: aplica na sessão e avisa (persisted=false)', async () => {
    const storage = fullStorage();
    const api = make(storage);
    await api.load();
    storage.full = true;
    const r = await api.moveStock({ productId: 'p3', type: 'entrada', qty: '4', note: '' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persisted).toBe(false);
      expect(r.data.products.find((p) => p.id === 'p3')!.stock).toBe(4);
    }
  });

  it('sem espaço para nova foto: produto não é salvo', async () => {
    const storage = fullStorage();
    const api = make(storage);
    const { data } = await api.load();
    storage.full = true;
    const p = data.products[0];
    const r = await api.saveProduct({
      id: p.id,
      name: p.name,
      categoryId: p.categoryId,
      brand: p.brand,
      description: p.description,
      imageUrl: 'data:image/jpeg;base64,AAAA',
      price: '189,90',
      showPrice: true,
      stock: String(p.stock),
      minStock: String(p.minStock),
      published: true,
      featured: true,
    });
    expect(r).toMatchObject({ ok: false, storageFull: true });
  });

  it('restaurar demonstração', async () => {
    const storage = createMemoryStorage();
    const api = make(storage);
    await api.load();
    await api.toggleCategory('higiene');
    const r = await api.resetDemo();
    expect(r.ok && r.data.categories.every((c) => c.active)).toBe(true);
    expect((await make(storage).load()).data.categories.every((c) => c.active)).toBe(true);
  });

  it('cancelamento duplicado via serviço é recusado e não altera o estoque', async () => {
    const api = make(createMemoryStorage());
    await api.load();
    await api.cancelSale('V-0006');
    const second = await api.cancelSale('V-0006');
    expect(second.ok).toBe(false);
    const { data } = await api.load();
    expect(data.products.find((p) => p.id === 'p4')!.stock).toBe(42 + 12);
  });

  it('armazenamento da encomenda descarta entradas inválidas', () => {
    const storage = createMemoryStorage();
    const cart = createCartStorage(storage);
    expect(cart.save({ p1: 2 })).toBe(true);
    expect(cart.load()).toEqual({ p1: 2 });
    storage.setItem('mdp-react-cart-v1', JSON.stringify({ p1: 2, p2: -1, p3: 1.5, p4: 'x' }));
    expect(cart.load()).toEqual({ p1: 2 });
    storage.setItem('mdp-react-cart-v1', 'lixo');
    expect(cart.load()).toEqual({});
  });
});
