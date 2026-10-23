import { useState } from 'react';
import { createIdempotencyKeys } from '../services/http/idempotency';

/** Chaves de idempotência estáveis durante a vida do componente (ver `createIdempotencyKeys`). */
export function useIdempotencyKeys() {
  const [keys] = useState(() => createIdempotencyKeys());
  return keys;
}
