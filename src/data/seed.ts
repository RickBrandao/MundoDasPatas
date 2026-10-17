import { DAY_MS } from '../domain/format';
import type { Category, Product, Sale, StockMovement, StoreData } from '../domain/types';

/** Dados fictícios da demonstração. Datas relativas a `now` para o painel sempre ter atividade recente. */
export function createSeedData(now: number = Date.now()): StoreData {
  const categories: Category[] = [
    { id: 'racoes', name: 'Rações', icon: 'set_meal', active: true },
    { id: 'petiscos', name: 'Petiscos', icon: 'cookie', active: true },
    { id: 'brinquedos', name: 'Brinquedos', icon: 'sports_baseball', active: true },
    { id: 'acessorios', name: 'Acessórios', icon: 'pets', active: true },
    { id: 'higiene', name: 'Higiene e Cuidados', icon: 'soap', active: true },
  ];

  const P = (
    id: string,
    name: string,
    categoryId: string,
    brand: string,
    priceCents: number | null,
    stock: number,
    minStock: number,
    description: string,
    extra: Partial<Product> = {},
  ): Product => ({
    id,
    name,
    categoryId,
    brand,
    priceCents,
    showPrice: priceCents != null,
    stock,
    minStock,
    description,
    published: true,
    featured: false,
    archived: false,
    imageUrl: '',
    createdAt: now - 45 * DAY_MS,
    updatedAt: now - 3 * DAY_MS,
    ...extra,
  });
  const F = { featured: true };

  const products: Product[] = [
    P('p1', 'Ração NutriPata Adulto Raças Médias 15 kg', 'racoes', 'NutriPata', 18990, 12, 4, 'Alimento completo para cães adultos de porte médio, com proteínas selecionadas.', F),
    P('p2', 'Ração Felino Plus Castrados 10 kg', 'racoes', 'Felino Plus', 15990, 3, 4, 'Fórmula para gatos castrados que auxilia no controle de peso.', F),
    P('p3', 'Ração NutriPata Filhotes 3 kg', 'racoes', 'NutriPata', 5490, 0, 3, 'Para filhotes de cães em fase de crescimento.'),
    P('p4', 'Sachê Felino Plus Carne ao Molho 85 g', 'racoes', 'Felino Plus', 349, 42, 20, 'Alimento úmido para gatos adultos.'),
    P('p5', 'Ração Premium Sênior 7,5 kg', 'racoes', 'NutriPata', null, 6, 3, 'Para cães a partir de 7 anos.'),
    P('p6', 'Bifinho de Carne BomBicho 500 g', 'petiscos', 'BomBicho', 2490, 20, 6, 'Petisco macio para recompensar e treinar.', F),
    P('p7', 'Petisco Dental para Cães 7 un.', 'petiscos', 'BomBicho', 1990, 2, 5, 'Ajuda na limpeza dos dentes no dia a dia.'),
    P('p8', 'Snack Cremoso para Gatos 4 un.', 'petiscos', 'Felino Plus', 1490, 16, 5, 'Petisco cremoso em sachês individuais.'),
    P('p9', 'Osso Natural Defumado', 'petiscos', 'BomBicho', null, 9, 3, 'Osso bovino defumado para cães de médio e grande porte.'),
    P('p10', 'Bola de Borracha Maciça', 'brinquedos', 'Brinca Pet', 1890, 27, 6, 'Resistente e quica bastante. Ideal para brincar de buscar.', F),
    P('p11', 'Corda Dental com Nós', 'brinquedos', 'Brinca Pet', 2290, 0, 4, 'Brinquedo de corda para morder e puxar.'),
    P('p12', 'Varinha com Penas para Gatos', 'brinquedos', 'Brinca Pet', 1690, 14, 4, 'Estimula o instinto de caça dos gatos.'),
    P('p13', 'Arranhador Compacto', 'brinquedos', 'Brinca Pet', null, 4, 2, 'Arranhador vertical com base estável.', { published: false }),
    P('p14', 'Coleira Ajustável Nylon — Tam. M', 'acessorios', 'PataFirme', 2990, 15, 4, 'Fecho de engate rápido e argola para identificação.'),
    P('p15', 'Guia Retrátil 5 m', 'acessorios', 'PataFirme', 7990, 5, 3, 'Trava de segurança e empunhadura confortável.', F),
    P('p16', 'Comedouro Duplo Inox', 'acessorios', 'PataFirme', 3990, 8, 3, 'Dois potes removíveis em aço inox com base antiderrapante.'),
    P('p17', 'Shampoo Neutro BanhoBom 500 ml', 'higiene', 'BanhoBom', 2790, 21, 6, 'Para cães e gatos, com pH balanceado.', F),
    P('p18', 'Tapete Higiênico 30 un.', 'higiene', 'BanhoBom', 6490, 3, 6, 'Alta absorção, com faixa adesiva.'),
    P('p19', 'Escova Removedora de Pelos', 'higiene', 'BanhoBom', null, 11, 3, 'Remove pelos soltos e reduz a queda.'),
  ];

  const salesSpec: [string, number, [string, number][]][] = [
    ['V-0001', 18.2, [['p1', 1], ['p10', 2]]],
    ['V-0002', 12.4, [['p6', 3], ['p17', 1]]],
    ['V-0003', 9.1, [['p2', 1], ['p4', 6]]],
    ['V-0004', 5.3, [['p7', 3], ['p10', 1], ['p14', 1]]],
    ['V-0005', 2.2, [['p6', 2], ['p18', 2]]],
    ['V-0006', 0.9, [['p4', 12], ['p8', 2]]],
  ];
  const sales: Sale[] = salesSpec.map(([id, daysAgo, items]) => ({
    id,
    date: now - daysAgo * DAY_MS,
    status: 'concluida',
    items: items.map(([productId, qty]) => ({ productId, qty })),
  }));

  const movements: StockMovement[] = [];
  let mi = 1;
  const M = (productId: string, type: StockMovement['type'], qty: number, date: number, note: string, origin: string) =>
    movements.push({ id: `m${mi++}`, productId, type, qty, date, note, origin });
  M('p1', 'entrada', 10, now - 20 * DAY_MS, 'Reposição do fornecedor', 'Painel');
  M('p4', 'entrada', 48, now - 15 * DAY_MS, 'Reposição do fornecedor', 'Painel');
  M('p3', 'ajuste', -2, now - 7 * DAY_MS, 'Embalagens avariadas', 'Painel');
  M('p17', 'entrada', 12, now - 4 * DAY_MS, 'Reposição do fornecedor', 'Painel');
  sales.forEach((s) => s.items.forEach((i) => M(i.productId, 'venda', -i.qty, s.date, 'Venda registrada', `Venda ${s.id}`)));
  movements.sort((a, b) => b.date - a.date);

  return {
    categories,
    products,
    sales: sales.reverse(),
    movements,
    seq: { product: 20, sale: 7, movement: mi, category: 1 },
    settings: {
      storeName: 'Mundo das Patas',
      whatsapp: '(11) 90000-0000',
      address: 'Rua Exemplo, 123 — Centro · Cidade/UF',
      hours: 'Seg. a sex., 8h às 19h · Sáb., 8h às 14h',
      about:
        'Texto demonstrativo. Aqui entra a apresentação oficial do Mundo das Patas: quem somos, como atendemos e o cuidado que temos com cada cliente e seu pet.\n\nEste conteúdo é editado pelo proprietário no painel, em Configurações.',
      showOutOfStock: true,
      showFeatured: true,
    },
  };
}
