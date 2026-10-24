"""Cloud Storage for Firebase via google-cloud-storage (o mesmo cliente do Firebase Admin SDK).

URLs públicas: formato de download do Firebase (`/v0/b/{bucket}/o/{caminho}?alt=media&token=...`).
O token fica nos metadados (`firebaseStorageDownloadTokens`) e libera **somente** a leitura daquele
objeto, sem login e independentemente das regras do Storage (que negam todo acesso direto do SDK cliente).
Quem possui a URL consegue ver a foto — adequado para fotos de catálogo, que são públicas por natureza.

Tempo limite e repetições são curtos: o envio acontece dentro de uma requisição HTTP do painel.
Falhas de rede, credenciais e permissão viram 503 `storage_unavailable`; o log registra só o tipo do erro.

Limitação do Storage Emulator (verificada na TASK 07A): a pré-condição `if_generation_match=0` no
envio não é respeitada (o emulador sobrescreve). Por isso a unicidade do caminho vem de um ID aleatório
de 128 bits gerado no servidor, e não da pré-condição.
"""

import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from urllib.parse import quote

from app.core.config import Settings
from app.core.errors import ServiceUnavailable
from app.core.storage import LazyBucket, StorageUnavailable, check_storage_config, download_base
from app.storage.base import StoredObject

if TYPE_CHECKING:
    from google.cloud.storage import Bucket

logger = logging.getLogger("app.storage")

TOKEN_METADATA = "firebaseStorageDownloadTokens"  # noqa: S105 - nome do campo, não um segredo
# Segundos por chamada (conexão + resposta) e prazo total das repetições automáticas. Sem prazo
# explícito, a biblioteca (3.x, que repete também os envios) insistiria por até 120 s com a rede fora.
REQUEST_TIMEOUT = 20
RETRY_DEADLINE = 8


@contextmanager
def _translate_errors() -> Iterator[None]:
    import requests
    from google.api_core import exceptions as gexc
    from google.auth.exceptions import GoogleAuthError
    from google.resumable_media import common as media_common

    try:
        yield
    except ServiceUnavailable:
        raise
    except (
        gexc.GoogleAPICallError,
        gexc.RetryError,
        GoogleAuthError,
        requests.RequestException,
        media_common.InvalidResponse,
    ) as exc:
        code = getattr(exc, "code", None)
        logger.error("Falha ao acessar o Cloud Storage: %s código=%s", type(exc).__name__, getattr(code, "name", code) or "-")
        raise StorageUnavailable() from None


def _retry():  # type: ignore[no-untyped-def]
    from google.cloud.storage.retry import DEFAULT_RETRY

    return DEFAULT_RETRY.with_timeout(RETRY_DEADLINE)


class FirebaseObjectStore:
    def __init__(self, settings: Settings, bucket: Callable[[], "Bucket"] | None = None) -> None:
        self._settings = settings
        self._bucket = bucket or LazyBucket(settings)

    def put(self, path: str, data: bytes, *, content_type: str, cache_control: str, metadata: dict[str, str]) -> None:
        with _translate_errors():
            blob = self._bucket().blob(path)
            blob.cache_control = cache_control
            blob.metadata = metadata
            # Repetir é seguro: o caminho é inédito, então uma repetição só regrava o mesmo conteúdo.
            blob.upload_from_string(data, content_type=content_type, timeout=REQUEST_TIMEOUT, retry=_retry())

    def delete(self, path: str) -> bool:
        from google.api_core import exceptions as gexc

        with _translate_errors():
            try:
                self._bucket().blob(path).delete(timeout=REQUEST_TIMEOUT, retry=_retry())
            except gexc.NotFound:
                return False
            return True

    def list(self, prefix: str) -> list[StoredObject]:
        with _translate_errors():
            bucket = self._bucket()
            return [
                StoredObject(
                    path=b.name,
                    created_at=(b.time_created or datetime.now(UTC)).astimezone(UTC),
                    size=b.size or 0,
                    metadata=dict(b.metadata or {}),
                )
                for b in bucket.client.list_blobs(bucket, prefix=prefix, timeout=REQUEST_TIMEOUT, retry=_retry())
            ]

    def ready(self) -> bool:
        try:
            check_storage_config(self._settings, log=False)
        except StorageUnavailable:
            return False
        return True

    def public_url(self, path: str, token: str) -> str:
        bucket = quote(self._settings.firebase_storage_bucket or "", safe="")
        return f"{download_base(self._settings)}/v0/b/{bucket}/o/{quote(path, safe='')}?alt=media&token={quote(token, safe='')}"
