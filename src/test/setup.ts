import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// O painel é carregado sob demanda (lazy); na primeira carga, com testes em paralelo, pode passar de 1 s.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

// jsdom não implementa rolagem.
window.scrollTo = (() => {}) as typeof window.scrollTo;
