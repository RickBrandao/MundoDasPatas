/** Identificação curta da venda: IDs do servidor são longos (32 caracteres); os da demonstração (V-0001) ficam como estão. */
export const saleLabel = (id: string) => (id.length > 12 ? `#${id.slice(0, 8).toUpperCase()}` : id);
