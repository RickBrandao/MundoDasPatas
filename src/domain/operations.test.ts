import { describe, expect, it } from 'vitest';
import { createSeedData } from '../data/seed';
import * as ops from './operations';
import { catalogSummary, completedSales, unitsSold } from './reports';
import type { StoreData } from './types';

const NOW = Date.UTC(2026, 9, 17, 12);
const seed = () => createSeedData(NOW);
const prod = (d: StoreData, id: string) => d.products.find((p) => p.id === id)!;
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const blankForm = (patch: Partial<ops.ProductFormInput> = {}): ops.ProductFormInput => ({
  id: null,
  name: 'Produto Teste QA',
  categoryId: 'brinquedos',
  brand: 'Marca',
  description: '',
  imageUrl: '',
  price: '1.234,56',
  showPrice: true,
  stock: '5',
  minStock: '1',
  published: true,
  featured: false,
  ...patch,
});

describe('cadastro e edição de produto', () => {
  it('cadastra com preço em centavos, estoque inicial e movimentação', () => {
    const { data, product } = unwrap(ops.saveProduct(seed(), blankForm(), NOW));
    expect(product).toMatchObject({ id: 'p20', priceCents: 123456, stock: 5, minStock: 1, showPrice: true, archived: false });
    expect(data.products[0].id).toBe('p20');
    expect(data.seq.product).toBe(21);
    expect(data.movements[0]).toMatchObject({ productId: 'p20', type: 'cadastro', qty: 5 });
  });

  it('estoque inicial zero não gera movimentação', () => {
    const before = seed();
    const { data } = unwrap(ops.saveProduct(before, blankForm({ stock: '0' }), NOW));
    expect(data.movements).toHaveLength(before.movements.length);
  });

  it('edita mantendo centavos e sem alterar estoque', () => {
    const created = unwrap(ops.saveProduct(seed(), blankForm(), NOW));
    const edit = blankForm({ id: created.product.id, name: 'Produto Teste QA editado', price: '1.234,56', stock: '999' });
    const { product } = unwrap(ops.saveProduct(created.data, edit, NOW + 1));
    expect(product).toMatchObject({ name: 'Produto Teste QA editado', priceCents: 123456, stock: 5 });
  });

  it('validação: nome curto, preço inválido, estoque não inteiro', () => {
    const r = ops.saveProduct(seed(), blankForm({ name: 'X', price: '12,3,4', stock: '2.5', minStock: '-1' }), NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.fieldErrors!).sort()).toEqual(['minStock', 'name', 'price', 'stock']);
  });

  it('exibir preço exige preço; sem preço vira "sob consulta"', () => {
    const r = ops.saveProduct(seed(), blankForm({ price: '' }), NOW);
    expect(!r.ok && r.fieldErrors?.price).toBeTruthy();
    const { product } = unwrap(ops.saveProduct(seed(), blankForm({ price: '', showPrice: false }), NOW));
    expect(product).toMatchObject({ priceCents: null, showPrice: false });
  });

  it('rejeita preço zero e categoria inexistente', () => {
    const r = ops.saveProduct(seed(), blankForm({ price: '0,00', categoryId: 'xpto' }), NOW);
    expect(!r.ok && Object.keys(r.fieldErrors!).sort()).toEqual(['categoryId', 'price']);
  });

  it('arquivar despublica; restaurar mantém oculto', () => {
    const archived = unwrap(ops.patchProductFlags(seed(), 'p1', { archived: true }, NOW));
    expect(prod(archived, 'p1')).toMatchObject({ archived: true, published: false });
    const restored = unwrap(ops.patchProductFlags(archived, 'p1', { archived: false }, NOW));
    expect(prod(restored, 'p1')).toMatchObject({ archived: false, published: false });
  });
});

describe('estoque', () => {
  it('entrada soma e registra movimentação', () => {
    const { data } = unwrap(ops.applyStockMove(seed(), { productId: 'p3', type: 'entrada', qty: '5', note: '' }, NOW));
    expect(prod(data, 'p3').stock).toBe(5);
    expect(data.movements[0]).toMatchObject({ type: 'entrada', qty: 5, note: 'Entrada de mercadoria' });
  });

  it('ajuste por contagem registra a diferença', () => {
    const { data } = unwrap(ops.applyStockMove(seed(), { productId: 'p1', type: 'ajuste', qty: '2', note: 'Contagem' }, NOW));
    expect(prod(data, 'p1').stock).toBe(2);
    expect(data.movements[0].qty).toBe(-10);
  });

  it.each([
    [{ type: 'ajuste', qty: '-3', note: 'x' }, 'Informe um número inteiro.'],
    [{ type: 'entrada', qty: '1,5', note: '' }, 'Informe um número inteiro.'],
    [{ type: 'entrada', qty: '0', note: '' }, 'A entrada deve ser maior que zero.'],
    [{ type: 'ajuste', qty: '12', note: 'x' }, 'A nova quantidade é igual à atual.'],
    [{ type: 'ajuste', qty: '3', note: '  ' }, 'Informe o motivo do ajuste.'],
  ] as const)('rejeita %o', (m, error) => {
    const r = ops.applyStockMove(seed(), { productId: 'p1', ...m }, NOW);
    expect(r).toEqual({ ok: false, error });
  });
});

describe('vendas', () => {
  it('registrar venda reduz estoque, soma unidades e gera movimentações', () => {
    const before = seed();
    const { data, sale } = unwrap(ops.registerSale(before, [{ productId: 'p6', qty: 2 }, { productId: 'p10', qty: 1 }], NOW));
    expect(sale.id).toBe('V-0007');
    expect(prod(data, 'p6').stock).toBe(18);
    expect(prod(data, 'p10').stock).toBe(26);
    expect(data.sales[0]).toBe(sale);
    expect(data.movements.slice(0, 2).every((m) => m.type === 'venda' && m.origin === 'Venda V-0007')).toBe(true);
    expect(unitsSold(completedSales(data.sales, '30', NOW))).toBe(unitsSold(completedSales(before.sales, '30', NOW)) + 3);
  });

  it('bloqueia venda acima do estoque (inclusive somando linhas repetidas)', () => {
    expect(ops.registerSale(seed(), [{ productId: 'p7', qty: 3 }], NOW).ok).toBe(false);
    expect(ops.registerSale(seed(), [{ productId: 'p7', qty: 1 }, { productId: 'p7', qty: 2 }], NOW).ok).toBe(false);
    expect(ops.registerSale(seed(), [], NOW)).toEqual({ ok: false, error: 'Adicione pelo menos um produto.' });
    expect(ops.registerSale(seed(), [{ productId: 'p6', qty: 0 }], NOW).ok).toBe(false);
  });

  it('linha de venda: soma ao item existente e respeita o disponível', () => {
    const d = seed();
    const lines = unwrap(ops.addSaleLine(d, [], 'p7', '1'));
    expect(unwrap(ops.addSaleLine(d, lines, 'p7', '1'))).toEqual([{ productId: 'p7', qty: 2 }]);
    expect(ops.addSaleLine(d, lines, 'p7', '2')).toEqual({ ok: false, error: 'Estoque insuficiente: 1 un. disponíveis de “Petisco Dental para Cães 7 un.”.' });
    expect(ops.addSaleLine(d, [], '', '1')).toEqual({ ok: false, error: 'Selecione um produto.' });
    expect(ops.addSaleLine(d, [], 'p6', '0')).toEqual({ ok: false, error: 'Informe uma quantidade válida.' });
  });

  it('cancelamento estorna o estoque e a venda deixa de contar', () => {
    const before = seed();
    const sold = unwrap(ops.registerSale(before, [{ productId: 'p6', qty: 2 }], NOW));
    const cancelled = unwrap(ops.cancelSale(sold.data, sold.sale.id, NOW + 1));
    expect(prod(cancelled, 'p6').stock).toBe(prod(before, 'p6').stock);
    expect(cancelled.sales[0]).toMatchObject({ status: 'cancelada', cancelledAt: NOW + 1 });
    expect(cancelled.movements[0]).toMatchObject({ type: 'estorno', qty: 2, productId: 'p6' });
    expect(completedSales(cancelled.sales, 'all', NOW).length).toBe(before.sales.length);
  });

  it('estorno duplicado é impedido (estoque devolvido uma única vez)', () => {
    const sold = unwrap(ops.registerSale(seed(), [{ productId: 'p6', qty: 2 }], NOW));
    const once = unwrap(ops.cancelSale(sold.data, sold.sale.id, NOW));
    const twice = ops.cancelSale(once, sold.sale.id, NOW);
    expect(twice.ok).toBe(false);
    expect(prod(once, 'p6').stock).toBe(20);
    expect(once.movements.filter((m) => m.type === 'estorno')).toHaveLength(1);
  });

  it('venda inexistente', () => {
    expect(ops.cancelSale(seed(), 'V-9999', NOW)).toEqual({ ok: false, error: 'Venda não encontrada.' });
  });

  it('nenhuma sequência de operações deixa estoque negativo', () => {
    let d = seed();
    for (const p of d.products.filter((x) => x.stock > 0 && !x.archived)) {
      d = unwrap(ops.registerSale(d, [{ productId: p.id, qty: p.stock }], NOW)).data;
      expect(ops.registerSale(d, [{ productId: p.id, qty: 1 }], NOW).ok).toBe(false);
    }
    expect(d.products.every((p) => p.stock >= 0)).toBe(true);
    expect(catalogSummary(d).out).toBe(d.products.filter((p) => !p.archived).length);
  });
});

describe('categorias e configurações', () => {
  it('cria, renomeia, impede duplicata e alterna', () => {
    const { data } = unwrap(ops.saveCategory(seed(), { id: null, name: 'Aquarismo' }));
    expect(data.categories.at(-1)).toMatchObject({ id: 'c1', name: 'Aquarismo', active: true });
    expect(ops.saveCategory(data, { id: null, name: ' racoes ' })).toEqual({ ok: false, error: 'Já existe uma categoria com esse nome.' });
    expect(ops.saveCategory(data, { id: null, name: 'A' })).toEqual({ ok: false, error: 'Informe o nome da categoria.' });
    const toggled = unwrap(ops.toggleCategory(data, 'c1'));
    expect(toggled.active).toBe(false);
  });

  it('valida WhatsApp e nome da loja', () => {
    const s = seed().settings;
    expect(ops.validateSettings({ ...s, whatsapp: '123' }).ok).toBe(false);
    expect(ops.validateSettings({ ...s, storeName: '  ' }).ok).toBe(false);
    expect(unwrap(ops.validateSettings({ ...s, storeName: ' Loja ', whatsapp: ' +55 (21) 98888-7777 ' }))).toMatchObject({ storeName: 'Loja', whatsapp: '+55 (21) 98888-7777' });
  });
});

describe('painel', () => {
  it('"Visíveis no catálogo" coincide com o catálogo', () => {
    const d = seed();
    expect(catalogSummary(d)).toMatchObject({ active: 19, visible: 18, published: 18, notPublished: 1, low: 3, out: 2 });
  });
});
