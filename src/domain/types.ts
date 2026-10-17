/** Valores monetários são sempre centavos inteiros (ex.: R$ 49,90 → 4990). */
export type Cents = number;

export type StockStatus = 'ok' | 'low' | 'out';

export interface Category {
  id: string;
  name: string;
  /** Nome do ícone Material Symbols. */
  icon: string;
  active: boolean;
}

export interface Product {
  id: string;
  name: string;
  categoryId: string;
  brand: string;
  description: string;
  /** Imagem enviada pelo painel (data URL na demo). Vazio = usa a ilustração demonstrativa. */
  imageUrl: string;
  priceCents: Cents | null;
  showPrice: boolean;
  stock: number;
  minStock: number;
  published: boolean;
  featured: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export type MovementType = 'entrada' | 'ajuste' | 'venda' | 'estorno' | 'cadastro';

export interface StockMovement {
  id: string;
  productId: string;
  type: MovementType;
  /** Variação de estoque: positiva (entrada) ou negativa (saída). */
  qty: number;
  date: number;
  note: string;
  origin: string;
}

export type SaleStatus = 'concluida' | 'cancelada';

export interface SaleItem {
  productId: string;
  qty: number;
}

export interface Sale {
  id: string;
  date: number;
  status: SaleStatus;
  items: SaleItem[];
  cancelledAt?: number;
}

export interface Settings {
  storeName: string;
  whatsapp: string;
  address: string;
  hours: string;
  about: string;
  showOutOfStock: boolean;
  showFeatured: boolean;
}

export interface Sequences {
  product: number;
  sale: number;
  movement: number;
  category: number;
}

/** Estado completo da loja (o que um backend real guardaria). */
export interface StoreData {
  categories: Category[];
  products: Product[];
  sales: Sale[];
  movements: StockMovement[];
  settings: Settings;
  seq: Sequences;
}

/** Encomenda do cliente: id do produto → quantidade. Fica só no navegador. */
export type Cart = Record<string, number>;

export type FieldErrors = Partial<Record<string, string>>;

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(error: string, fieldErrors?: FieldErrors): Result<T> =>
  fieldErrors ? { ok: false, error, fieldErrors } : { ok: false, error };
