/// <reference types="vite/client" />

/** Variáveis públicas do build (Vite). Valores reais ficam em `.env.local`, nunca versionado. */
interface ImportMetaEnv {
  /** `demo` (padrão) ou `firebase`. Ver `src/services/auth/adminAccess.ts`. */
  readonly VITE_ADMIN_AUTH_MODE?: string;
  /** URL do FastAPI, sem barra final (ex.: http://localhost:8000). Só no modo `firebase`. */
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
