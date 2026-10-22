"""Unicidade transacional de nomes de categoria (reservas `category_name_claims`) no Firestore Emulator."""

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.domain.catalog import normalize_text
from app.domain.models import Category
from app.repositories import firestore_codec as codec
from app.repositories.base import CategoryNameTaken, Repositories
from app.schemas.catalog import CategoryCreate, CategoryUpdate
from app.services.catalog import CategoryService
from tests.conftest import ADMIN, category
from tests_emulator.conftest import count
from tests_emulator.test_inventory import THREADS, race

URL = "/api/v1/admin/categories"


def claims(db: Any) -> dict[str, str]:
    """Nome normalizado → ID da categoria dona da reserva."""
    return {d.get("normalized_name"): d.get("category_id") for d in db.collection("category_name_claims").stream()}


def test_accents_and_case_conflict(client: TestClient, db: Any) -> None:
    created = client.post(URL, json={"name": "Ração Úmida"}, headers=ADMIN)
    assert created.status_code == 201
    for variant in ["racao umida", "RAÇÃO ÚMIDA", "Racao Úmida"]:
        r = client.post(URL, json={"name": variant}, headers=ADMIN)
        assert r.status_code == 409, variant
        assert r.json()["error"]["fieldErrors"] == {"name": "Já existe uma categoria com esse nome."}
    assert count(db, "categories") == 1
    assert claims(db) == {"racao umida": created.json()["id"]}


def test_rename_releases_old_name_and_reuse(client: TestClient, db: Any) -> None:
    aves = client.post(URL, json={"name": "Aves"}, headers=ADMIN).json()
    assert client.patch(f"{URL}/{aves['id']}", json={"name": "Pássaros"}, headers=ADMIN).status_code == 200
    assert claims(db) == {"passaros": aves["id"]}
    reused = client.post(URL, json={"name": "aves"}, headers=ADMIN)
    assert reused.status_code == 201
    assert client.post(URL, json={"name": "PASSAROS"}, headers=ADMIN).status_code == 409
    assert claims(db) == {"passaros": aves["id"], "aves": reused.json()["id"]}


def test_keeping_own_name_with_other_case_is_allowed(client: TestClient, db: Any) -> None:
    aves = client.post(URL, json={"name": "Aves"}, headers=ADMIN).json()
    r = client.patch(f"{URL}/{aves['id']}", json={"name": "AVES", "active": False}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["name"] == "AVES" and r.json()["active"] is False
    assert claims(db) == {"aves": aves["id"]}


def test_rejected_rename_changes_nothing(client: TestClient, db: Any) -> None:
    aves = client.post(URL, json={"name": "Aves"}, headers=ADMIN).json()
    peixes = client.post(URL, json={"name": "Peixes"}, headers=ADMIN).json()
    before = claims(db)
    r = client.patch(f"{URL}/{peixes['id']}", json={"name": "AVES", "active": False}, headers=ADMIN)
    assert r.status_code == 409
    stored = {c["id"]: c for c in client.get(URL, headers=ADMIN).json()}
    assert stored[peixes["id"]]["name"] == "Peixes" and stored[peixes["id"]]["active"] is True
    assert stored[aves["id"]]["name"] == "Aves"
    assert claims(db) == before  # sem reserva parcial nem reserva antiga apagada


def test_repository_enforces_uniqueness_directly(repos: Repositories, db: Any) -> None:
    repos.categories.save(category("a", "Brinquedos"))
    with pytest.raises(CategoryNameTaken):
        repos.categories.save(category("b", "BRINQUÉDOS"))
    assert repos.categories.get("b") is None
    repos.categories.save(category("a", "brinquedos"))
    assert repos.categories.get("a") == category("a", "brinquedos")
    claim = db.collection("category_name_claims").document(codec.category_claim_id(normalize_text("Brinquedos"))).get()
    assert claim.exists and claim.get("category_id") == "a"


def test_concurrent_creation_of_equivalent_names(new_repos: Callable[[], Repositories], repos: Repositories, db: Any) -> None:
    names = ["Ração", "racao", "RAÇÃO", "Racão"][:THREADS]
    services = [CategoryService(new_repos()) for _ in names]
    results = race(len(names), lambda i: services[i].create(CategoryCreate(name=names[i])))
    winners = [r for r in results if isinstance(r, Category)]
    assert len(winners) == 1, results
    assert count(db, "categories") == 1
    assert claims(db) == {"racao": winners[0].id}


def test_concurrent_renames_to_same_name(new_repos: Callable[[], Repositories], repos: Repositories, db: Any) -> None:
    for c in (category("a", "Aves"), category("b", "Peixes"), category("c", "Répteis")):
        repos.categories.save(c)
    targets = [("a", "Roedores"), ("b", "roedores"), ("c", "RÔEDORES")]
    services = [CategoryService(new_repos()) for _ in targets]
    results = race(3, lambda i: services[i].update(targets[i][0], CategoryUpdate(name=targets[i][1])))
    winners = [r for r in results if isinstance(r, Category)]
    assert len(winners) == 1, results
    names = {c.id: normalize_text(c.name) for c in repos.categories.list()}
    assert list(names.values()).count("roedores") == 1
    # Cada categoria tem exatamente uma reserva, e a do vencedor trocou de nome.
    assert sorted(claims(db).values()) == ["a", "b", "c"]
    assert set(claims(db)) == set(names.values())
