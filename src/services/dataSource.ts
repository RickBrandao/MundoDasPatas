/**
 * Origem dos dados comerciais, definida no build por `VITE_STORE_DATA_SOURCE`:
 *
 * - `local` (padrão, GitHub Pages): dados fictícios no navegador (`localStoreApi`).
 * - `api`: FastAPI + Firestore. O catálogo usa a API pública; o painel, a API administrativa
 *   (somente depois de `GET /api/v1/admin/me` confirmar o acesso).
 *
 * Valor inválido, ou `api` sem `VITE_API_BASE_URL` válida, resulta em `misconfigured`:
 * nada é carregado do navegador (nunca cai para os dados de demonstração).
 */
export type DataSource =
  | { kind: 'local' }
  | { kind: 'api'; apiBaseUrl: string }
  | { kind: 'misconfigured'; problems: string[] };

export interface DataSourceEnv {
  VITE_STORE_DATA_SOURCE?: string;
  VITE_API_BASE_URL?: string;
}

/** Mesmo formato exigido por `resolveAdminAccess` (http(s)://host[/caminho], sem barra final). */
export const API_BASE_URL_PATTERN = /^https?:\/\/[^/]+(\/.*[^/])?$/;

/** Os problemas citam apenas nomes de variáveis, nunca valores. */
export function resolveDataSource(env: DataSourceEnv): DataSource {
  const kind = env.VITE_STORE_DATA_SOURCE?.trim() || 'local';
  if (kind === 'local') return { kind: 'local' };
  if (kind !== 'api') return { kind: 'misconfigured', problems: ['VITE_STORE_DATA_SOURCE deve ser "local" ou "api".'] };

  const apiBaseUrl = env.VITE_API_BASE_URL?.trim() ?? '';
  if (!apiBaseUrl) return { kind: 'misconfigured', problems: ['VITE_API_BASE_URL não definida.'] };
  if (!API_BASE_URL_PATTERN.test(apiBaseUrl)) {
    return { kind: 'misconfigured', problems: ['VITE_API_BASE_URL deve começar com http(s):// e não terminar com "/".'] };
  }
  return { kind: 'api', apiBaseUrl };
}

/**
 * Combinações aceitas para o painel: demonstração com dados locais, ou Firebase com a API.
 * Qualquer outra (ex.: Firebase com dados no navegador, ou API sem login) bloqueia o painel.
 */
export function panelProblems(authMode: 'demo' | 'firebase' | 'misconfigured', source: DataSource): string[] {
  if (source.kind === 'misconfigured') return source.problems;
  if (authMode === 'demo' && source.kind === 'api') {
    return ['VITE_STORE_DATA_SOURCE=api exige VITE_ADMIN_AUTH_MODE=firebase (dados reais nunca ficam sem login).'];
  }
  if (authMode === 'firebase' && source.kind === 'local') {
    return ['VITE_ADMIN_AUTH_MODE=firebase exige VITE_STORE_DATA_SOURCE=api (dados reais não ficam no navegador).'];
  }
  return [];
}
