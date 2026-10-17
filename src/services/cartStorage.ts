import type { Cart } from '../domain/types';
import { parseStoredCart } from './schema';
import { readJSON, writeJSON, type KeyValueStorage } from './storage';

export const CART_KEY = 'mdp-react-cart-v1';

/** A encomenda é do visitante: continua no navegador mesmo quando houver backend. */
export interface CartStorage {
  load(): Cart;
  save(cart: Cart): boolean;
}

export function createCartStorage(storage: KeyValueStorage, key = CART_KEY): CartStorage {
  return {
    load: () => parseStoredCart(readJSON(storage, key)),
    save: (cart) => writeJSON(storage, key, cart),
  };
}
