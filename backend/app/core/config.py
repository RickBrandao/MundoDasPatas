"""Configuração centralizada, lida de variáveis de ambiente (e de `backend/.env` em dev).

Regra geral: em `staging` e `production` a configuração é validada de forma estrita
e a aplicação **não inicia** se algo inseguro ou incompleto for detectado (fail-closed).
"""

import json
import re
from enum import StrEnum
from functools import lru_cache
from typing import Annotated, Self

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class AppEnv(StrEnum):
    LOCAL = "local"
    TEST = "test"
    STAGING = "staging"
    PRODUCTION = "production"


class ImageStorage(StrEnum):
    # Envio de fotos desligado: produtos são salvos sem imagem e o upload responde 503.
    DISABLED = "disabled"
    # Cloud Storage for Firebase (real ou, em desenvolvimento, o Storage Emulator).
    FIREBASE = "firebase"


class DataBackend(StrEnum):
    # Em memória, por processo: só para testes e desenvolvimento isolado.
    MEMORY = "memory"
    # Cloud Firestore (real ou, em desenvolvimento, o emulador local).
    FIRESTORE = "firestore"


def _split_csv(value: object) -> object:
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


# Único bucket aceito para as fotos: o padrão do próprio projeto (projeto novo, sem bucket legado
# `.appspot.com`). Impede gravar, listar ou apagar em bucket de outro projeto por engano de configuração.
DEFAULT_BUCKET_SUFFIX = ".firebasestorage.app"


def expected_storage_bucket(project_id: str | None) -> str | None:
    return f"{project_id}{DEFAULT_BUCKET_SUFFIX}" if project_id else None


def service_account_project(raw: str) -> str | None:
    """`project_id` de uma conta de serviço em JSON (None se não for uma). Nunca registra o conteúdo."""
    try:
        info = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(info, dict) or info.get("type") != "service_account":
        return None
    project = info.get("project_id")
    return project if isinstance(project, str) and project else None


def _is_service_account(raw: str) -> bool:
    try:
        info = json.loads(raw)
    except ValueError:
        return False
    required = ("project_id", "client_email", "private_key")
    return (
        isinstance(info, dict)
        and info.get("type") == "service_account"
        and all(isinstance(info.get(k), str) and info[k] for k in required)
    )


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: AppEnv = AppEnv.LOCAL
    log_level: str = "INFO"

    # Origens autorizadas pelo navegador (lista separada por vírgulas). CORS não é autenticação.
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)

    firebase_project_id: str | None = None
    # Conteúdo JSON da conta de serviço (ex.: variável secreta na Vercel). Nunca um arquivo no repositório.
    # Sem ele, o SDK usa Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS, gcloud, GCP).
    firebase_service_account_json: SecretStr | None = None
    firestore_database_id: str = "(default)"
    # Definida pelo Firebase Emulator Suite. Com ela, o SDK aceita tokens NÃO assinados.
    firebase_auth_emulator_host: str | None = None
    # Definida pelo Firebase Emulator Suite (host:porta, sem http://). O SDK do Firestore a lê do
    # ambiente do processo; este campo serve para validar a configuração (ver core/firestore.py).
    firestore_emulator_host: str | None = None

    # UIDs do Firebase Authentication com acesso ao painel. Vazio = ninguém é administrador.
    admin_allowed_uids: Annotated[frozenset[str], NoDecode] = Field(default_factory=frozenset)

    data_backend: DataBackend = DataBackend.MEMORY

    # Fotos dos produtos (ver docs/storage.md). Sem configuração válida, o upload responde 503.
    image_storage: ImageStorage = ImageStorage.DISABLED
    # Bucket do Cloud Storage for Firebase (ex.: "<projeto>.firebasestorage.app").
    firebase_storage_bucket: str | None = None
    # Storage Emulator (host:porta, sem http://; convenção do Firebase). Proibido em staging/produção.
    firebase_storage_emulator_host: str | None = None

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _parse_origins(cls, value: object) -> object:
        return _split_csv(value)

    @field_validator("admin_allowed_uids", mode="before")
    @classmethod
    def _parse_uids(cls, value: object) -> object:
        return _split_csv(value)

    @field_validator("firebase_storage_bucket", "firebase_storage_emulator_host", mode="before")
    @classmethod
    def _blank_is_none(cls, value: object) -> object:
        return value.strip() or None if isinstance(value, str) else value

    @field_validator("firebase_storage_bucket")
    @classmethod
    def _check_bucket(cls, value: str | None) -> str | None:
        # Nome de bucket do Google Cloud Storage: só o nome, sem gs:// nem caminho.
        if value is not None and not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", value):
            raise ValueError("FIREBASE_STORAGE_BUCKET inválido (use só o nome do bucket, sem gs:// ou barras).")
        return value

    @field_validator("cors_origins")
    @classmethod
    def _check_origins(cls, origins: list[str]) -> list[str]:
        for origin in origins:
            if origin != "*" and not origin.startswith(("http://", "https://")):
                raise ValueError(f"Origem CORS inválida: {origin!r} (use http(s)://host[:porta]).")
            if origin.endswith("/"):
                raise ValueError(f"Origem CORS não deve terminar com '/': {origin!r}.")
        return origins

    @model_validator(mode="after")
    def _check_deployed_environment(self) -> Self:
        if not self.is_deployed:
            return self
        problems: list[str] = []
        if self.data_backend is DataBackend.MEMORY:
            problems.append("DATA_BACKEND=memory não é permitido (dados seriam perdidos e divergiriam entre instâncias).")
        if not self.firebase_project_id:
            problems.append("FIREBASE_PROJECT_ID é obrigatório.")
        if self.firebase_auth_emulator_host:
            problems.append(
                "FIREBASE_AUTH_EMULATOR_HOST não pode estar definido (desativa a verificação de assinatura dos tokens)."
            )
        if self.firestore_emulator_host:
            problems.append("FIRESTORE_EMULATOR_HOST não pode estar definido (os dados iriam para o emulador local).")
        if self.firebase_service_account_json is not None and not _is_service_account(
            self.firebase_service_account_json.get_secret_value()
        ):
            # Só a estrutura é conferida (sem rede); a validade da chave aparece na primeira verificação (503).
            problems.append(
                "FIREBASE_SERVICE_ACCOUNT_JSON não é uma conta de serviço válida "
                "(objeto JSON com type=service_account, project_id, client_email e private_key)."
            )
        elif (
            self.firebase_service_account_json is not None
            and service_account_project(self.firebase_service_account_json.get_secret_value()) != self.firebase_project_id
        ):
            problems.append("FIREBASE_SERVICE_ACCOUNT_JSON pertence a outro projeto (project_id ≠ FIREBASE_PROJECT_ID).")
        if self.firebase_storage_emulator_host:
            problems.append("FIREBASE_STORAGE_EMULATOR_HOST não pode estar definido (as fotos iriam para o emulador local).")
        if self.image_storage is ImageStorage.FIREBASE and not self.firebase_storage_bucket:
            problems.append("IMAGE_STORAGE=firebase exige FIREBASE_STORAGE_BUCKET.")
        elif self.image_storage is ImageStorage.FIREBASE and self.firebase_storage_bucket != expected_storage_bucket(
            self.firebase_project_id
        ):
            problems.append(
                "FIREBASE_STORAGE_BUCKET precisa ser o bucket padrão do projeto (<FIREBASE_PROJECT_ID>.firebasestorage.app)."
            )
        if "*" in self.cors_origins:
            problems.append("CORS_ORIGINS não pode conter '*'.")
        if self.app_env is AppEnv.PRODUCTION and any(o.startswith("http://") for o in self.cors_origins):
            problems.append("CORS_ORIGINS em produção deve usar apenas https://.")
        if problems:
            raise ValueError(f"Configuração inválida para APP_ENV={self.app_env}: " + " ".join(problems))
        return self

    @property
    def is_deployed(self) -> bool:
        return self.app_env in (AppEnv.STAGING, AppEnv.PRODUCTION)

    @property
    def firebase_configured(self) -> bool:
        return bool(self.firebase_project_id)

    @property
    def docs_enabled(self) -> bool:
        return self.app_env is not AppEnv.PRODUCTION


@lru_cache
def get_settings() -> Settings:
    return Settings()
