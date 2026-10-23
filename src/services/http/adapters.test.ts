import { describe, expect, it } from 'vitest';
import { stockStatus } from '../../domain/catalog';
import { InvalidResponse, productPayload, toMovement, toProduct, toPublicStoreData, toSale } from './adapters';

const adminProduct = {
  id: 'abc',
  name: 'Ração',
  description: '',
  categoryId: 'c1',
  brand: 'X',
  imageUrl: '',
  priceCents: 4990,
  showPrice: true,
  stock: 3,
  minStock: 2,
  stockStatus: 'ok',
  published: true,
  featured: false,
  archived: false,
  createdAt: '2026-10-23T12:00:00Z',
  updatedAt: '2026-10-23T12:30:00.123Z',
};

describe('adaptadores DTO → domínio', () => {
  it('converte datas ISO 8601 em milissegundos e mantém centavos inteiros', () => {
    const p = toProduct(adminProduct);
    expect(p.createdAt).toBe(Date.UTC(2026, 9, 23, 12, 0, 0));
    expect(p.updatedAt).toBe(Date.UTC(2026, 9, 23, 12, 30, 0, 123));
    expect(p.priceCents).toBe(4990);
  });

  it('venda e movimentação: createdAt → date, cancelamento opcional', () => {
    const sale = toSale({ id: 's', items: [{ productId: 'abc', qty: 2 }], status: 'cancelada', createdAt: '2026-10-23T12:00:00Z', createdBy: 'u', cancelledAt: '2026-10-23T13:00:00Z', cancelledBy: 'u' });
    expect(sale).toEqual({ id: 's', date: Date.UTC(2026, 9, 23, 12), status: 'cancelada', items: [{ productId: 'abc', qty: 2 }], cancelledAt: Date.UTC(2026, 9, 23, 13) });
    const m = toMovement({ id: 'm', productId: 'abc', type: 'venda', qty: -2, createdAt: '2026-10-23T12:00:00Z', note: 'Venda', origin: 'Venda s', actorUid: 'u' });
    expect(m.date).toBe(Date.UTC(2026, 9, 23, 12));
  });

  it('resposta incompleta ou com tipos errados é recusada', () => {
    expect(() => toProduct({ ...adminProduct, stock: '3' })).toThrow(InvalidResponse);
    expect(() => toProduct({ ...adminProduct, createdAt: 'ontem' })).toThrow(InvalidResponse);
    expect(() => toSale({ id: 's', items: [], status: 'pendente', createdAt: '2026-10-23T12:00:00Z' })).toThrow(InvalidResponse);
  });

  it('catálogo público: o status de estoque do servidor é preservado', () => {
    const data = toPublicStoreData({
      store: { storeName: 'Loja', whatsapp: '', address: '', hours: '', about: '', showFeatured: true },
      categories: [{ id: 'c1', name: 'Rações', icon: 'label' }],
      products: [
        { id: 'a', name: 'A', description: '', categoryId: 'c1', brand: '', imageUrl: '', priceCents: null, featured: false, stock: 1, stockStatus: 'low' },
        { id: 'b', name: 'B', description: '', categoryId: 'c1', brand: '', imageUrl: '', priceCents: 990, featured: true, stock: 9, stockStatus: 'ok' },
        { id: 'c', name: 'C', description: '', categoryId: 'c1', brand: '', imageUrl: '', priceCents: 990, featured: false, stock: 0, stockStatus: 'out' },
      ],
    });
    expect(data.products.map(stockStatus)).toEqual(['low', 'ok', 'out']);
    expect(data.products[0].showPrice).toBe(false);
    expect(data.products[1].showPrice).toBe(true);
    expect(data.categories[0].active).toBe(true);
    expect(data.sales).toEqual([]);
    expect(data.movements).toEqual([]);
    expect(data.settings.showOutOfStock).toBe(true);
  });

  it('data URLs da demonstração nunca vão ao servidor', () => {
    const form = {
      id: null,
      name: ' Bola ',
      categoryId: 'c1',
      brand: '',
      description: '',
      imageUrl: 'data:image/jpeg;base64,AAAA',
      price: '9,90',
      showPrice: true,
      stock: '1',
      minStock: '0',
      published: true,
      featured: false,
    };
    expect(productPayload(form, { priceCents: 990, minStock: 0 })).toMatchObject({ name: 'Bola', imageUrl: '', priceCents: 990, showPrice: true });
    expect(productPayload({ ...form, imageUrl: 'https://cdn/x.jpg' }, { priceCents: 990, minStock: 0 }).imageUrl).toBe('https://cdn/x.jpg');
    expect(productPayload({ ...form, price: '' }, { priceCents: null, minStock: 0 }).showPrice).toBe(false);
  });
});
