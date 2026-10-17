/** Subconjunto do Web Storage usado pela demo (permite injetar um armazenamento falso nos testes). */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Armazenamento em memória: usado quando o localStorage está bloqueado (modo privado, cookies desativados…). */
export function createMemoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

/** O próprio acesso a `window.localStorage` pode lançar exceção; nesse caso cai para memória. */
export function getBrowserStorage(): { storage: KeyValueStorage; persistent: boolean } {
  try {
    const s = window.localStorage;
    const probe = '__mdp_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return { storage: s, persistent: true };
  } catch {
    return { storage: createMemoryStorage(), persistent: false };
  }
}

export function readJSON(storage: KeyValueStorage, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Retorna `false` se não foi possível gravar (cota excedida, armazenamento bloqueado…). */
export function writeJSON(storage: KeyValueStorage, key: string, value: unknown): boolean {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
