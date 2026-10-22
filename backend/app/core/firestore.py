"""Cliente do Cloud Firestore, criado sob demanda (mesma estratégia de `core/firebase.py`).

- Nada é importado nem conectado na importação do módulo nem na criação da aplicação: o cliente
  nasce na primeira operação de dados. Falhas viram 503 (nunca fallback para memória).
- Banco real: reutiliza o app do Firebase Admin SDK (mesmas credenciais da autenticação:
  `FIREBASE_SERVICE_ACCOUNT_JSON` ou Application Default Credentials) e `FIRESTORE_DATABASE_ID`.
- Emulador: o SDK decide pelo `FIRESTORE_EMULATOR_HOST` do **ambiente do processo** (não lê o
  `.env`). Por isso a variável precisa estar no ambiente; definida só no `.env` ela é recusada, em
  vez de o cliente se conectar silenciosamente ao projeto real. Proibido em staging/produção.
"""

import logging
import os
import threading
from typing import TYPE_CHECKING

from app.core.config import Settings
from app.core.errors import ServiceUnavailable

if TYPE_CHECKING:
    from google.cloud.firestore import Client

EMULATOR_ENV = "FIRESTORE_EMULATOR_HOST"
logger = logging.getLogger("app.firestore")


class DatabaseUnavailable(ServiceUnavailable):
    code = "database_unavailable"
    message = "Banco de dados indisponível no momento. Tente novamente em instantes."


class DatabaseNotConfigured(DatabaseUnavailable):
    """Configuração ausente ou inconsistente (503, registrado no log sem valores)."""


class DatabaseBusy(ServiceUnavailable):
    """Disputa persistente entre transações sobre os mesmos documentos; repetir é seguro (idempotência)."""

    code = "database_busy"
    message = "Muitas operações simultâneas sobre os mesmos dados. Tente novamente."


def emulator_host(settings: Settings) -> str | None:
    """Host do emulador em uso, conferindo que configuração e ambiente do processo concordam."""
    env_host = os.environ.get(EMULATOR_ENV) or None
    if settings.firestore_emulator_host != env_host:
        logger.error("%s definido de forma inconsistente (só no .env ou diferente do ambiente do processo).", EMULATOR_ENV)
        raise DatabaseNotConfigured()
    if env_host and settings.is_deployed:
        logger.error("%s definido em ambiente publicado: uso do emulador recusado.", EMULATOR_ENV)
        raise DatabaseNotConfigured()
    return env_host


def create_firestore_client(settings: Settings) -> "Client":
    if not settings.firebase_project_id:
        logger.error("DATA_BACKEND=firestore sem FIREBASE_PROJECT_ID.")
        raise DatabaseNotConfigured()

    from google.auth.exceptions import GoogleAuthError

    if emulator_host(settings):
        from google.auth.credentials import AnonymousCredentials
        from google.cloud import firestore

        return firestore.Client(
            project=settings.firebase_project_id,
            database=settings.firestore_database_id,
            credentials=AnonymousCredentials(),
        )

    from firebase_admin import firestore as admin_firestore

    from app.core.firebase import get_firebase_app

    try:
        app = get_firebase_app(settings)
        return admin_firestore.client(app, database_id=settings.firestore_database_id)
    except ServiceUnavailable:
        raise DatabaseNotConfigured() from None
    except (ValueError, GoogleAuthError) as exc:
        # Não registra a mensagem: pode conter trechos de credenciais.
        logger.error("Falha ao criar o cliente do Firestore (credenciais ou configuração): %s", type(exc).__name__)
        raise DatabaseNotConfigured() from None


class LazyFirestoreClient:
    """Um cliente por processo, criado na primeira chamada. Falhas não ficam em cache (nova tentativa a seguir)."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: Client | None = None
        self._lock = threading.Lock()

    def __call__(self) -> "Client":
        if self._client is None:
            with self._lock:
                if self._client is None:
                    self._client = create_firestore_client(self._settings)
        return self._client
