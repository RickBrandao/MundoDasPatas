import type { StoreData } from '../../domain/types';

export const productName = (data: StoreData, id: string) => data.products.find((p) => p.id === id)?.name ?? 'Produto removido';
