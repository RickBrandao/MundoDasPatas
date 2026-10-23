/**
 * Chaves de idempotência (`Idempotency-Key`): uma por intenção do usuário.
 *
 * - A mesma chave é reenviada em todas as tentativas daquela intenção (retry automático,
 *   nova tentativa manual depois de falha de rede ou de resposta desconhecida).
 * - Uma nova chave só nasce para uma nova operação deliberada (ex.: outros itens na venda).
 * O servidor guarda a resposta original por 24 h e a devolve nas repetições, sem reaplicar.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Associa cada conteúdo de operação (ex.: itens da venda serializados) a uma chave estável.
 * Repetir o mesmo conteúdo reutiliza a chave; conteúdo diferente gera outra.
 */
export function createIdempotencyKeys(generate: () => string = newIdempotencyKey) {
  const keys = new Map<string, string>();
  return {
    keyFor(intent: string): string {
      let key = keys.get(intent);
      if (!key) {
        key = generate();
        keys.set(intent, key);
      }
      return key;
    },
    /** Operação confirmada: a próxima, mesmo com o mesmo conteúdo, é uma nova intenção. */
    done(intent: string) {
      keys.delete(intent);
    },
  };
}
