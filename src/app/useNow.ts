import { useState } from 'react';

/** Instante fixo da montagem do componente (relatórios por período sem recalcular a cada renderização). */
export function useNow(): number {
  const [now] = useState(() => Date.now());
  return now;
}
