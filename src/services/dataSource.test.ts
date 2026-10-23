import { describe, expect, it } from 'vitest';
import { panelProblems, resolveDataSource } from './dataSource';

describe('origem dos dados (VITE_STORE_DATA_SOURCE)', () => {
  it('padrão é a demonstração local (GitHub Pages)', () => {
    expect(resolveDataSource({})).toEqual({ kind: 'local' });
    expect(resolveDataSource({ VITE_STORE_DATA_SOURCE: ' local ' })).toEqual({ kind: 'local' });
  });

  it('api exige URL válida do FastAPI', () => {
    expect(resolveDataSource({ VITE_STORE_DATA_SOURCE: 'api', VITE_API_BASE_URL: 'http://127.0.0.1:8000' })).toEqual({
      kind: 'api',
      apiBaseUrl: 'http://127.0.0.1:8000',
    });
    expect(resolveDataSource({ VITE_STORE_DATA_SOURCE: 'api' })).toEqual({ kind: 'misconfigured', problems: ['VITE_API_BASE_URL não definida.'] });
    expect(resolveDataSource({ VITE_STORE_DATA_SOURCE: 'api', VITE_API_BASE_URL: 'http://x/' }).kind).toBe('misconfigured');
  });

  it('valor inválido não ativa a demonstração', () => {
    expect(resolveDataSource({ VITE_STORE_DATA_SOURCE: 'firestore' }).kind).toBe('misconfigured');
  });

  it('combinações aceitas para o painel: demo+local e firebase+api', () => {
    const api = { kind: 'api' as const, apiBaseUrl: 'http://x' };
    expect(panelProblems('demo', { kind: 'local' })).toEqual([]);
    expect(panelProblems('firebase', api)).toEqual([]);
    expect(panelProblems('demo', api)[0]).toMatch(/exige VITE_ADMIN_AUTH_MODE=firebase/);
    expect(panelProblems('firebase', { kind: 'local' })[0]).toMatch(/exige VITE_STORE_DATA_SOURCE=api/);
  });
});
