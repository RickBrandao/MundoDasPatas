from datetime import timedelta

import pytest

from app.domain.models import DEFAULT_SETTINGS, IdempotencyRecord, MovementType, Sale, SaleItem, SaleStatus, StockMovement
from app.repositories.base import InventoryTransaction, Repositories
from app.repositories.memory import MemoryState
from tests.conftest import NOW, category, product


def movement(id: str, product_id: str, minutes: int) -> StockMovement:
    return StockMovement(id, product_id, MovementType.ENTRADA, 1, NOW + timedelta(minutes=minutes), "", "Painel", "admin")


def sale(id: str, minutes: int) -> Sale:
    return Sale(id, (SaleItem("p1", 1),), SaleStatus.CONCLUIDA, NOW + timedelta(minutes=minutes), "admin")


def test_missing_resources_return_none(repos: Repositories) -> None:
    assert repos.products.get("x") is None
    assert repos.categories.get("x") is None
    assert repos.sales.get("x") is None
    assert repos.movements.get("x") is None
    assert repos.settings.get() is None


def test_category_and_settings_roundtrip(repos: Repositories) -> None:
    repos.categories.save(category("c1", "Aves"))
    assert repos.categories.get("c1") == category("c1", "Aves")
    repos.settings.save(DEFAULT_SETTINGS)
    assert repos.settings.get() == DEFAULT_SETTINGS


def test_transaction_commits_all_writes(repos: Repositories) -> None:
    def op(tx: InventoryTransaction) -> str:
        tx.put_product(product("p1"))
        tx.put_sale(sale("s1", 0))
        tx.add_movements([movement("m1", "p1", 0)])
        tx.put_idempotency(IdempotencyRecord("k", "op", "admin", "h", "s1", "{}", 1, NOW, NOW + timedelta(hours=24)))
        return "ok"

    assert repos.inventory.run_in_transaction(op) == "ok"
    assert repos.products.get("p1") is not None
    assert repos.sales.get("s1") is not None
    assert repos.movements.get("m1") is not None
    assert repos.inventory.run_in_transaction(lambda tx: tx.get_idempotency("op", "admin", "k")) is not None
    # A chave é isolada por usuário e operação.
    assert repos.inventory.run_in_transaction(lambda tx: tx.get_idempotency("op", "outro", "k")) is None


def test_transaction_failure_writes_nothing(repos: Repositories, state: MemoryState) -> None:
    state.products["p1"] = product("p1", stock=5)

    def op(tx: InventoryTransaction) -> None:
        tx.put_product(product("p1", stock=0))
        tx.add_movements([movement("m1", "p1", 0)])
        raise RuntimeError("falha no meio da operação")

    with pytest.raises(RuntimeError):
        repos.inventory.run_in_transaction(op)
    assert repos.products.get("p1") == product("p1", stock=5)
    assert repos.movements.list(10) == []


def test_lists_are_newest_first_with_limit_and_filters(repos: Repositories, state: MemoryState) -> None:
    state.movements.extend([movement("m1", "p1", 1), movement("m2", "p2", 3), movement("m3", "p1", 2)])
    assert [m.id for m in repos.movements.list(10)] == ["m2", "m3", "m1"]
    assert [m.id for m in repos.movements.list(1)] == ["m2"]
    assert [m.id for m in repos.movements.list(10, product_id="p1")] == ["m3", "m1"]

    state.sales.update({s.id: s for s in [sale("s1", -60 * 24 * 10), sale("s2", 0)]})
    assert [s.id for s in repos.sales.list(10)] == ["s2", "s1"]
    assert [s.id for s in repos.sales.list(10, since=NOW - timedelta(days=1))] == ["s2"]
