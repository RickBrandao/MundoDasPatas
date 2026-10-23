/// <reference types="vite/client" />

/** Variáveis públicas do build (Vite). Valores reais ficam em `.env.local`, nunca versionado. */
interface ImportMetaEnv {
  /** `demo` (padrão) ou `firebase`. Ver `src/services/auth/adminAccess.ts`. */
  readonly VITE_ADMIN_AUTH_MODE?: string;
  /** `local` (padrão: demonstração no navegador) ou `api` (FastAPI + Firestore). Ver `src/services/dataSource.ts`. */
  readonly VITE_STORE_DATA_SOURCE?: string;
  /** URL do FastAPI, sem barra final (ex.: http://127.0.0.1:8000). Obrigatória com `firebase` ou `api`. */
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  /** Somente `vite` (dev): host:porta do Firebase Auth Emulator para testes de ponta a ponta. Ignorada em builds. */
  readonly VITE_FIREBASE_AUTH_EMULATOR_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
