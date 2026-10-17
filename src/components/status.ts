import type { MovementType, SaleStatus, StockStatus } from '../domain/types';
import type { PublicState } from '../domain/reports';

/** Rótulos e tons (classes CSS) usados em selos. */
export const STOCK_ADMIN: Record<StockStatus, { label: string; tone: string }> = {
  ok: { label: 'Disponível', tone: 'tone-ok' },
  low: { label: 'Estoque baixo', tone: 'tone-low' },
  out: { label: 'Esgotado', tone: 'tone-out' },
};

/** Como o cliente vê o estoque. */
export const STOCK_PUBLIC: Record<StockStatus, string> = {
  ok: 'Disponível',
  low: 'Últimas unidades',
  out: 'Indisponível',
};

export const MOVEMENT: Record<MovementType, { label: string; tone: string }> = {
  entrada: { label: 'Entrada', tone: 'tone-ok' },
  ajuste: { label: 'Ajuste', tone: 'tone-neutral' },
  venda: { label: 'Baixa · venda', tone: 'tone-low' },
  estorno: { label: 'Estorno', tone: 'tone-refund' },
  cadastro: { label: 'Cadastro', tone: 'tone-neutral' },
};

export const SALE_STATUS: Record<SaleStatus, { label: string; tone: string }> = {
  concluida: { label: 'Concluída', tone: 'tone-ok' },
  cancelada: { label: 'Cancelada', tone: 'tone-muted' },
};

export const PUBLIC_STATE: Record<PublicState, { label: string; tone: string }> = {
  archived: { label: 'Arquivado', tone: 'tone-neutral' },
  hidden: { label: 'Oculto', tone: 'tone-muted' },
  'inactive-category': { label: 'Publicado · categoria inativa', tone: 'tone-low' },
  'out-hidden': { label: 'Publicado · esgotado oculto', tone: 'tone-low' },
  visible: { label: 'Visível no catálogo', tone: 'tone-ok' },
};

/** Fundo dos cards de categoria na loja. */
export const CATEGORY_TINT: Record<string, string> = {
  racoes: '#FBE6CF',
  petiscos: '#FBF0CF',
  brinquedos: '#DCF0EC',
  acessorios: '#F3E3D8',
  higiene: '#DDEBF2',
};
export const DEFAULT_TINT = '#F1E9DE';
