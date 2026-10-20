import { getApps, initializeApp } from 'firebase/app';
import {
  browserSessionPersistence,
  getAuth,
  initializeAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
} from 'firebase/auth';
import type { FirebaseWebConfig } from './adminAccess';
import type { AuthClient } from './authClient';

const APP_NAME = 'mundo-das-patas-admin';

/**
 * Firebase Authentication (Web SDK modular). Carregado sob demanda: a demonstração nunca baixa este módulo.
 *
 * Persistência `browserSessionPersistence`: a sessão sobrevive a recarregamentos, mas termina ao
 * fechar a aba/janela — adequado a um computador de balcão compartilhado. O SDK guarda e renova
 * os tokens; a aplicação nunca os grava por conta própria.
 */
export function createFirebaseAuthClient(config: FirebaseWebConfig): AuthClient {
  const auth = getOrInitAuth(config);
  return {
    onAuthStateChanged: (listener) => onAuthStateChanged(auth, listener),
    signIn: async (email, password) => {
      await signInWithEmailAndPassword(auth, email, password);
    },
    signOut: () => signOut(auth),
  };
}

function getOrInitAuth(config: FirebaseWebConfig): Auth {
  // Recarregamento a quente (Vite) reavalia o módulo: reaproveita a instância já criada.
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) return getAuth(existing);
  const app = initializeApp(config, APP_NAME);
  return initializeAuth(app, { persistence: browserSessionPersistence });
}
