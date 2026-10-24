"""Armazenamento de objetos em memória — somente para testes (não há configuração que o ative).

`fail_next` simula indisponibilidade do serviço na próxima chamada de uma operação.
"""

import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.core.storage import StorageUnavailable
from app.storage.base import StoredObject

PUBLIC_BASE = "https://storage.test"


@dataclass
class MemoryObject:
    data: bytes
    content_type: str
    cache_control: str
    metadata: dict[str, str]
    created_at: datetime


@dataclass
class MemoryObjectStore:
    objects: dict[str, MemoryObject] = field(default_factory=dict)
    failures: dict[str, int] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def fail_next(self, operation: str, times: int = 1) -> None:
        self.failures[operation] = self.failures.get(operation, 0) + times

    def _check(self, operation: str) -> None:
        if self.failures.get(operation, 0) > 0:
            self.failures[operation] -= 1
            raise StorageUnavailable()

    def put(self, path: str, data: bytes, *, content_type: str, cache_control: str, metadata: dict[str, str]) -> None:
        with self.lock:
            self._check("put")
            self.objects[path] = MemoryObject(data, content_type, cache_control, dict(metadata), datetime.now(UTC))

    def delete(self, path: str) -> bool:
        with self.lock:
            self._check("delete")
            return self.objects.pop(path, None) is not None

    def list(self, prefix: str) -> list[StoredObject]:
        with self.lock:
            self._check("list")
            return [
                StoredObject(path=p, created_at=o.created_at, size=len(o.data), metadata=dict(o.metadata))
                for p, o in self.objects.items()
                if p.startswith(prefix)
            ]

    def ready(self) -> bool:
        return True

    def public_url(self, path: str, token: str) -> str:
        return f"{PUBLIC_BASE}/v0/b/bucket/o/{path.replace('/', '%2F')}?alt=media&token={token}"
