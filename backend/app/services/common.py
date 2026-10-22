import hashlib
import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

Clock = Callable[[], datetime]
IdFactory = Callable[[], str]


def utc_now() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    # IDs aleatórios: não dependem de sequência local (várias instâncias serverless em paralelo).
    return uuid.uuid4().hex


def derived_ids(seed: str) -> IdFactory:
    """IDs derivados de uma semente fixada fora da transação.

    Criada dentro da função da transação, recomeça a cada reexecução: a tentativa confirmada usa
    sempre os mesmos IDs (`seed`, posição), independentemente de quantas vezes o Firestore repetiu.
    """
    counter = 0

    def next_id() -> str:
        nonlocal counter
        counter += 1
        return hashlib.sha256(f"{seed}:{counter}".encode()).hexdigest()[:32]

    return next_id


def request_hash(payload: Any) -> str:
    """Impressão digital do corpo da requisição, para detectar reuso da chave de idempotência."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()
