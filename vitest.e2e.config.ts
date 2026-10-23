import { defineConfig } from 'vitest/config';

// Testes de ponta a ponta com o Firebase Emulator Suite (não fazem parte de `npm test`).
// Pré-requisitos e execução: docs/integracao-api.md §5.
export default defineConfig({
  test: {
    include: ['src/e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
