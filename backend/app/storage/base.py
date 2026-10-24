"""Contrato do armazenamento de objetos (fotos). Serviços dependem deste Protocol, nunca do SDK.

Implementações: `firebase.py` (Cloud Storage for Firebase, real ou emulador) e `memory.py` (testes).
Falhas de acesso (rede, credenciais, permissão) levantam `StorageUnavailable` (503).
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol


@dataclass(frozen=True, slots=True)
class StoredObject:
    path: str
    created_at: datetime
    size: int
    metadata: dict[str, str] = field(default_factory=dict)


class ObjectStore(Protocol):
    def put(self, path: str, data: bytes, *, content_type: str, cache_control: str, metadata: dict[str, str]) -> None:
        """Grava um objeto novo (o chamador garante um caminho inédito)."""
        ...

    def delete(self, path: str) -> bool:
        """Exclui o objeto. False se ele já não existia."""
        ...

    def list(self, prefix: str) -> list[StoredObject]:
        """Objetos cujo caminho começa com `prefix` (uso administrativo: limpeza de órfãos)."""
        ...

    def ready(self) -> bool:
        """Configuração válida para enviar? Não acessa a rede (a disponibilidade real aparece no envio)."""
        ...

    def public_url(self, path: str, token: str) -> str:
        """URL de download que funciona sem login, válida enquanto o token constar nos metadados do objeto."""
        ...
