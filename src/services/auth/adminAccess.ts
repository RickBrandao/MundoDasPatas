import type { AuthClient } from './authClient';

/**
 * Modo de acesso ao painel, definido no build por `VITE_ADMIN_AUTH_MODE`:
 *
 * - `demo` (padrão, GitHub Pages): painel aberto com dados fictícios, sem Firebase.
 * - `firebase`: login no Firebase Authentication + autorização confirmada pelo FastAPI.
 *
 * Qualquer outro valor, ou o modo `firebase` com configuração incompleta, resulta em
 * `misconfigured`: o painel fica bloqueado (nunca cai para o modo demonstração).
 */
export type AdminAccess =
  | { mode: 'demo' }
  | { mode: 'firebase'; apiBaseUrl: string; loadAuthClient: () => Promise<AuthClient> }
  | { mode: 'misconfigured'; problems: string[] };

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId: string;
}

export interface AdminAuthEnv {
  VITE_ADMIN_AUTH_MODE?: string;
  VITE_API_BASE_URL?: string;
  VITE_FIREBASE_API_KEY?: string;
  VITE_FIREBASE_AUTH_DOMAIN?: string;
  VITE_FIREBASE_PROJECT_ID?: string;
  VITE_FIREBASE_APP_ID?: string;
  VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
}

export type AuthClientFactory = (config: FirebaseWebConfig) => Promise<AuthClient>;

const FIREBASE_VARS = {
  apiKey: 'VITE_FIREBASE_API_KEY',
  authDomain: 'VITE_FIREBASE_AUTH_DOMAIN',
  projectId: 'VITE_FIREBASE_PROJECT_ID',
  appId: 'VITE_FIREBASE_APP_ID',
  messagingSenderId: 'VITE_FIREBASE_MESSAGING_SENDER_ID',
} as const satisfies Record<keyof FirebaseWebConfig, keyof AdminAuthEnv>;

/** Os problemas citam apenas nomes de variáveis, nunca valores. */
export function resolveAdminAccess(env: AdminAuthEnv, createClient?: AuthClientFactory): AdminAccess {
  const mode = env.VITE_ADMIN_AUTH_MODE?.trim() || 'demo';
  if (mode === 'demo') return { mode: 'demo' };
  if (mode !== 'firebase') {
    return { mode: 'misconfigured', problems: ['VITE_ADMIN_AUTH_MODE deve ser "demo" ou "firebase".'] };
  }

  const problems: string[] = [];
  const config = {} as FirebaseWebConfig;
  for (const [key, name] of Object.entries(FIREBASE_VARS) as [keyof FirebaseWebConfig, keyof AdminAuthEnv][]) {
    const value = env[name]?.trim();
    if (value) config[key] = value;
    else problems.push(`${name} não definida.`);
  }

  const apiBaseUrl = env.VITE_API_BASE_URL?.trim() ?? '';
  if (!apiBaseUrl) problems.push('VITE_API_BASE_URL não definida.');
  else if (!/^https?:\/\/[^/]+(\/.*[^/])?$/.test(apiBaseUrl)) {
    problems.push('VITE_API_BASE_URL deve começar com http(s):// e não terminar com "/".');
  }

  if (!createClient) problems.push('Cliente do Firebase indisponível neste build.');
  if (problems.length > 0 || !createClient) return { mode: 'misconfigured', problems };

  // Uma única inicialização do Firebase por página, e somente quando o painel precisar dele.
  let client: Promise<AuthClient> | null = null;
  const loadAuthClient = () => {
    client ??= createClient(config).catch((error: unknown) => {
      client = null; // permite tentar de novo (ex.: falha de rede ao baixar o SDK)
      throw error;
    });
    return client;
  };
  return { mode: 'firebase', apiBaseUrl, loadAuthClient };
}
