"""Inicialização preguiçosa do Firebase Admin SDK.

- Nada é importado nem conectado na importação do módulo: o SDK só é carregado na primeira
  verificação de token (importante para cold start serverless e para testes sem credenciais).
- Inicialização única por processo, protegida por lock (instâncias serverless reaproveitam o processo).
- Credenciais: `FIREBASE_SERVICE_ACCOUNT_JSON` (segredo do ambiente) ou, na ausência dele,
  Application Default Credentials. Nenhum arquivo de credencial fica no repositório.
"""

import json
import logging
import threading
from typing import TYPE_CHECKING

from app.core.config import Settings
from app.core.errors import ServiceUnavailable

if TYPE_CHECKING:
    from firebase_admin import App

APP_NAME = "mundo-das-patas"
_lock = threading.Lock()
logger = logging.getLogger("app.firebase")


class FirebaseNotConfigured(ServiceUnavailable):
    code = "auth_unavailable"
    message = "Autenticação indisponível no momento."


class FirebaseInitFailed(FirebaseNotConfigured):
    """Credenciais ausentes, inválidas ou configuração recusada pelo SDK (503, nunca 500)."""


def get_firebase_app(settings: Settings) -> "App":
    if not settings.firebase_configured:
        raise FirebaseNotConfigured()

    import firebase_admin
    from firebase_admin import credentials

    with _lock:
        try:
            return firebase_admin.get_app(APP_NAME)
        except ValueError:
            pass  # ainda não inicializado

        from google.auth.exceptions import GoogleAuthError

        try:
            if settings.firebase_service_account_json is not None:
                info = json.loads(settings.firebase_service_account_json.get_secret_value())
                if not isinstance(info, dict):
                    # Certificate() trataria uma string como caminho de arquivo.
                    raise ValueError("a conta de serviço deve ser um objeto JSON")
                credential = credentials.Certificate(info)
            else:
                # Preguiçosa: se o ADC não existir, o erro surge na verificação (tratado em security.py).
                credential = credentials.ApplicationDefault()
            return firebase_admin.initialize_app(
                credential,
                options={"projectId": settings.firebase_project_id},
                name=APP_NAME,
            )
        except (ValueError, TypeError, GoogleAuthError) as exc:
            # JSONDecodeError é ValueError. Não encadeia nem registra a mensagem: pode conter trechos do segredo.
            # Nada fica inicializado: a próxima requisição tenta de novo.
            logger.error("Falha ao inicializar o Firebase Admin SDK (credenciais ou configuração): %s", type(exc).__name__)
            raise FirebaseInitFailed() from None
