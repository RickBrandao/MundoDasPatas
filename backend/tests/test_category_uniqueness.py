"""Unicidade de nomes de categoria sob concorrência (CON-01).

Nomes equivalentes = mesma forma de `normalize_text` (sem acentos, sem caixa): "Ração" == "RACAO".
"""

import dataclasses
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.errors import Conflict
from app.domain.models import Category
from app.repositories.base import CategoryNameTaken, Repositories
from app.repositories.memory import MemoryState
from app.schemas.catalog import CategoryCreate, CategoryUpdate
from app.services.catalog import CategoryService
from tests.conftest import ADMIN, category

URL = "/api/v1/admin/categories"


class _SlowListCategories:
    """Atrasa a resposta de `list()`: alarga a janela entre uma consulta e a gravação seguinte.

    Uma verificação do tipo "consulta e depois insere" deixa passar duplicatas com este atraso;
    a reserva atômica no repositório não depende de `list()` e continua correta.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def list(self) -> list[Category]:
        snapshot = self._inner.list()
        time.sleep(0.05)
        return snapshot

    def get(self, category_id: str) -> Category | None:
        return self._inner.get(category_id)

    def save(self, category: Category) -> None:
        self._inner.save(category)


def _slow_service(repos: Repositories) -> CategoryService:
    return CategoryService(dataclasses.replace(repos, categories=_SlowListCategories(repos.categories)))


def _race(n: int, task: Any) -> list[Any]:
    start = threading.Barrier(n)

    def attempt(i: int) -> Any:
        start.wait()
        try:
            return task(i)
        except Conflict as exc:
            return exc

    with ThreadPoolExecutor(max_workers=n) as pool:
        return list(pool.map(attempt, range(n)))


def test_concurrent_creation_of_equivalent_names_creates_one(repos: Repositories, state: MemoryState) -> None:
    service = _slow_service(repos)
    names = ["Ração", "racao", "RAÇÃO", "Racão", "RACAO", "ração", "Raçao", "rAçÃo"]

    results = _race(len(names), lambda i: service.create(CategoryCreate(name=names[i])))
    assert sum(isinstance(r, Category) for r in results) == 1
    assert sum(isinstance(r, Conflict) for r in results) == len(names) - 1
    assert len(state.categories) == 1


def test_concurrent_renames_to_the_same_name(repos: Repositories, state: MemoryState) -> None:
    for c in (category("a", "Aves"), category("b", "Peixes"), category("c", "Répteis")):
        repos.categories.save(c)
    service = _slow_service(repos)
    targets = [("a", "Roedores"), ("b", "roedores"), ("c", "RÔEDORES")]

    results = _race(3, lambda i: service.update(targets[i][0], CategoryUpdate(name=targets[i][1])))
    assert sum(isinstance(r, Category) for r in results) == 1
    names = [c.name for c in state.categories.values()]
    assert sum(n.lower().replace("ô", "o") == "roedores" for n in names) == 1
    assert len(state.categories) == 3


def test_equivalent_names_conflict_over_http(client: TestClient) -> None:
    assert client.post(URL, json={"name": "Ração Úmida"}, headers=ADMIN).status_code == 201
    for variant in ["racao umida", "RAÇÃO ÚMIDA", "Racao Úmida"]:
        r = client.post(URL, json={"name": variant}, headers=ADMIN)
        assert r.status_code == 409, variant
        assert r.json()["error"]["fieldErrors"] == {"name": "Já existe uma categoria com esse nome."}
    assert len(client.get(URL, headers=ADMIN).json()) == 1


def test_rename_to_used_name_is_rejected_and_changes_nothing(client: TestClient) -> None:
    aves = client.post(URL, json={"name": "Aves"}, headers=ADMIN).json()
    peixes = client.post(URL, json={"name": "Peixes"}, headers=ADMIN).json()

    r = client.patch(f"{URL}/{peixes['id']}", json={"name": "AVES", "active": False}, headers=ADMIN)
    assert r.status_code == 409
    # Operação rejeitada não aplica nenhuma das alterações enviadas.
    current = {c["id"]: c for c in client.get(URL, headers=ADMIN).json()}
    assert current[peixes["id"]]["name"] == "Peixes" and current[peixes["id"]]["active"] is True
    assert current[aves["id"]]["name"] == "Aves"


def test_keeping_own_name_is_allowed(client: TestClient) -> None:
    aves = client.post(URL, json={"name": "Aves"}, headers=ADMIN).json()
    same = client.patch(f"{URL}/{aves['id']}", json={"name": "Aves", "active": False}, headers=ADMIN)
    assert same.status_code == 200 and same.json()["active"] is False
    recased = client.patch(f"{URL}/{aves['id']}", json={"name": "AVES"}, headers=ADMIN)
    assert recased.status_code == 200 and recased.json()["name"] == "AVES"


def test_released_name_can_be_reused(client: TestClient) -> None:
    aves = client.post(URL, json={"name": "Aves"}, headers=ADMIN).json()
    assert client.patch(f"{URL}/{aves['id']}", json={"name": "Pássaros"}, headers=ADMIN).status_code == 200
    reused = client.post(URL, json={"name": "aves"}, headers=ADMIN)
    assert reused.status_code == 201
    assert client.post(URL, json={"name": "PASSAROS"}, headers=ADMIN).status_code == 409


def test_repository_enforces_uniqueness_directly(repos: Repositories, state: MemoryState) -> None:
    repos.categories.save(category("a", "Brinquedos"))
    with pytest.raises(CategoryNameTaken):
        repos.categories.save(category("b", "BRINQUÉDOS"))
    assert set(state.categories) == {"a"}
    repos.categories.save(category("a", "brinquedos"))  # o próprio ID pode regravar o nome
    assert state.categories["a"].name == "brinquedos"
