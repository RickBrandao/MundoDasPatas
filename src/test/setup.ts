import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

// jsdom não implementa rolagem.
window.scrollTo = (() => {}) as typeof window.scrollTo;
