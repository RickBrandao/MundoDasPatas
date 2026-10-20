"""Inicialização preguiçosa do Firebase Admin SDK.

- Nada é importado nem conectado na importação do módulo: o SDK só é carregado na primeira
  verificação de token (importante para cold start serverless e para testes sem credenciais).
- Inicialização única por processo, protegida por lock (instâncias serverless reaproveitam o processo).
- Credenciais: `FIREBASE_SERVICE_ACCOUNT_JSON` (segredo do ambiente) ou, na ausência dele,
  Application Default Credentials. Nenhum arquivo de credencial fica no repositório.
"""

import json
import threading
from typing import TYPE_CHECKING

from app.core.config import Settings
from app.core.errors import ServiceUnavailable

if TYPE_CHECKING:
    from firebase_admin import App

APP_NAME = "mundo-das-patas"
_lock = threading.Lock()


class FirebaseNotConfigured(ServiceUnavailable):
    code = "auth_unavailable"
    message = "Autenticação indisponível no momento."


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

        if settings.firebase_service_account_json is not None:
            try:
                info = json.loads(settings.firebase_service_account_json.get_secret_value())
            except json.JSONDecodeError:
                # Não encadeia a exceção original: ela pode conter trechos do segredo.
                raise RuntimeError("FIREBASE_SERVICE_ACCOUNT_JSON não contém um JSON válido.") from None
            credential = credentials.Certificate(info)
        else:
            credential = credentials.ApplicationDefault()

        return firebase_admin.initialize_app(
            credential,
            options={"projectId": settings.firebase_project_id},
            name=APP_NAME,
        )
