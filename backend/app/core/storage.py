"""Cliente do Cloud Storage for Firebase (fotos dos produtos), criado sob demanda.

Mesma estratégia de `core/firestore.py`:
- nada é importado nem conectado na importação do módulo nem na criação da aplicação; o bucket
  nasce no primeiro envio, e falhas viram 503 `storage_unavailable` (nunca fallback local);
- bucket real: credenciais do Firebase Admin SDK (`FIREBASE_SERVICE_ACCOUNT_JSON` ou ADC);
- emulador: `FIREBASE_STORAGE_EMULATOR_HOST` (host:porta) com credenciais anônimas, configurado
  explicitamente no cliente (não depende de variáveis lidas pela biblioteca). Proibido em staging/produção.

Combinações que misturariam ambientes são recusadas (fail-closed), em qualquer `APP_ENV`:
- Storage Emulator só com dados efêmeros ou no Firestore Emulator (URLs do emulador nunca vão para o banco real);
- Storage real só com o Firestore real (objetos reais nunca ficam apontados por dados descartáveis);
- `STORAGE_EMULATOR_HOST` no ambiente com o Storage real (a biblioteca desviaria as chamadas).

Isolamento entre projetos (TASK 07B.1), conferido antes de criar o cliente e antes de cada operação:
- o bucket precisa ser o padrão do próprio projeto, `<FIREBASE_PROJECT_ID>.firebasestorage.app`
  (também no emulador, com o projeto `demo-*`); `.appspot.com` legado não é aceito;
- Storage real: a credencial que identifica um projeto precisa ser do mesmo projeto —
  `FIREBASE_SERVICE_ACCOUNT_JSON` ou um arquivo de conta de serviço em `GOOGLE_APPLICATION_CREDENTIALS`.
  ADC de usuário (`authorized_user`) não identifica projeto: é aceito, e `quota_project_id` (projeto de
  cota, não de propriedade) é ignorado. A posse real do bucket é conferida na ativação (docs/storage.md §7).
"""

import json
import logging
import os
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from app.core.config import DataBackend, ImageStorage, Settings, expected_storage_bucket, service_account_project
from app.core.errors import ServiceUnavailable

if TYPE_CHECKING:
    from google.cloud.storage import Bucket

# Lida pela biblioteca google-cloud-storage: desviaria o cliente real para outro endereço.
LIBRARY_EMULATOR_ENV = "STORAGE_EMULATOR_HOST"
REAL_DOWNLOAD_BASE = "https://firebasestorage.googleapis.com"
logger = logging.getLogger("app.storage")


class StorageUnavailable(ServiceUnavailable):
    code = "storage_unavailable"
    message = "Envio de imagens indisponível no momento. O produto continua salvo; tente enviar a foto mais tarde."


class StorageNotConfigured(StorageUnavailable):
    """Envio de fotos desligado, configuração ausente ou combinação de ambientes recusada (503)."""


def storage_mode(settings: Settings) -> str:
    """`disabled`, `emulator` ou `real` (sem conferir a combinação; ver `check_storage_config`)."""
    if settings.image_storage is ImageStorage.DISABLED:
        return "disabled"
    return "emulator" if settings.firebase_storage_emulator_host else "real"


def check_storage_config(settings: Settings, *, log: bool = True) -> str:
    """Confere a configuração e devolve o modo em uso; qualquer inconsistência levanta 503."""
    mode = storage_mode(settings)
    problem: str | None = None
    if mode == "disabled":
        problem = "IMAGE_STORAGE=disabled"
    elif not settings.firebase_storage_bucket or not settings.firebase_project_id:
        problem = "IMAGE_STORAGE=firebase exige FIREBASE_STORAGE_BUCKET e FIREBASE_PROJECT_ID"
    elif settings.firebase_storage_bucket != expected_storage_bucket(settings.firebase_project_id):
        problem = "FIREBASE_STORAGE_BUCKET não é o bucket padrão de FIREBASE_PROJECT_ID (<projeto>.firebasestorage.app)"
    elif mode == "emulator":
        if settings.is_deployed:
            problem = "Storage Emulator em ambiente publicado"
        elif settings.data_backend is DataBackend.FIRESTORE and not settings.firestore_emulator_host:
            problem = "Storage Emulator com o Firestore real"
    else:
        if settings.data_backend is not DataBackend.FIRESTORE or settings.firestore_emulator_host:
            problem = "Storage real exige o Firestore real"
        elif os.environ.get(LIBRARY_EMULATOR_ENV):
            problem = f"{LIBRARY_EMULATOR_ENV} definido com o Storage real"
        else:
            problem = credential_project_problem(settings)
    if problem:
        if log and mode != "disabled":
            logger.error("Envio de imagens recusado pela configuração: %s.", problem)
        raise StorageNotConfigured()
    return mode


def credential_project_problem(settings: Settings) -> str | None:
    """Credencial de outro projeto? Só lê o JSON localmente (sem rede) e nunca registra o conteúdo."""
    expected = settings.firebase_project_id
    if settings.firebase_service_account_json is not None:
        if service_account_project(settings.firebase_service_account_json.get_secret_value()) != expected:
            return "FIREBASE_SERVICE_ACCOUNT_JSON sem project_id ou de outro projeto"
        return None
    path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not path:
        return None  # ADC do gcloud (authorized_user): não identifica projeto
    try:
        info = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "GOOGLE_APPLICATION_CREDENTIALS ilegível"
    if not isinstance(info, dict):
        return "GOOGLE_APPLICATION_CREDENTIALS ilegível"
    if info.get("type") == "service_account" and info.get("project_id") != expected:
        return "GOOGLE_APPLICATION_CREDENTIALS aponta para conta de serviço de outro projeto"
    return None


def download_base(settings: Settings) -> str:
    """Origem das URLs públicas de download (`/v0/b/{bucket}/o/...`)."""
    if storage_mode(settings) == "emulator":
        return f"http://{settings.firebase_storage_emulator_host}"
    return REAL_DOWNLOAD_BASE


def create_bucket(settings: Settings) -> "Bucket":
    mode = check_storage_config(settings)
    from google.auth.exceptions import GoogleAuthError

    if mode == "emulator":
        from google.auth.credentials import AnonymousCredentials
        from google.cloud import storage

        client = storage.Client(
            project=settings.firebase_project_id,
            credentials=AnonymousCredentials(),
            client_options={"api_endpoint": f"http://{settings.firebase_storage_emulator_host}"},
        )
        return client.bucket(settings.firebase_storage_bucket)

    from firebase_admin import storage as admin_storage

    from app.core.firebase import get_firebase_app

    try:
        return admin_storage.bucket(settings.firebase_storage_bucket, app=get_firebase_app(settings))
    except ServiceUnavailable:
        raise StorageNotConfigured() from None
    except (ValueError, GoogleAuthError) as exc:
        # Não registra a mensagem: pode conter trechos de credenciais.
        logger.error("Falha ao criar o cliente do Cloud Storage (credenciais ou configuração): %s", type(exc).__name__)
        raise StorageNotConfigured() from None


class LazyBucket:
    """Um bucket por processo, criado no primeiro uso. Falhas não ficam em cache (nova tentativa a seguir)."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._bucket: Bucket | None = None
        self._lock = threading.Lock()

    def __call__(self) -> "Bucket":
        if self._bucket is None:
            with self._lock:
                if self._bucket is None:
                    self._bucket = create_bucket(self._settings)
        return self._bucket
