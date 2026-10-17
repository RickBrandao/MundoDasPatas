/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Publicação no GitHub Pages: https://rickbrandao.github.io/MundoDasPatas/
// O caminho base precisa coincidir com o nome do repositório (sensível a maiúsculas).
// Usado também em dev/preview para o ambiente local reproduzir o caminho publicado.
export default defineConfig({
  base: '/MundoDasPatas/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
