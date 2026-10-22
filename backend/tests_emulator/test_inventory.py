"""Vendas, movimentações, cancelamentos, idempotência e concorrência no Firestore Emulator.

Nos testes concorrentes cada thread usa repositórios com cliente próprio (como instâncias
serverless distintas): a consistência vem só das transações do Firestore.
"""

import dataclasses
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.errors import ApiError, Conflict, InsufficientStock
from app.core.firestore import DatabaseBusy, DatabaseUnavailable
from app.domain.models import MovementType, SaleStatus
from app.repositories.base import Repositories
from app.schemas.catalog import ProductUpdate
from app.schemas.inventory import SaleCreate, SaleItemIn, StockMovementCreate
from app.services.catalog import ProductService
from app.services.inventory import InventoryService
from tests.conftest import ADMIN, ADMIN_UID, NOW, category, product
from tests_emulator.conftest import count, put_docs

SALES = "/api/v1/admin/sales"
MOVES = "/api/v1/admin/stock/movements"
# 4 threads bastam para provar a serialização. O emulador resolve impasses de lock por timeout
# (~10 s por rodada, observado); com mais threads as rodadas se acumulam (limitação do emulador,
# não do Firestore real, que usa wound-wait). Ver README, "Firestore Emulator".
THREADS = 4


def key(k: str) -> dict[str, str]:
    return ADMIN | {"Idempotency-Key": k}


def sale_body(*items: tuple[str, int]) -> dict[str, Any]:
    return {"items": [{"productId": p, "qty": q} for p, q in items]}


def assert_ledger(repos: Repositories, product_id: str, initial: int) -> int:
    """Invariante: estoque = inicial + soma das movimentações. Devolve o estoque."""
    p = repos.products.get(product_id)
    assert p is not None
    assert p.stock == initial + sum(m.qty for m in repos.movements.list(500, product_id=product_id))
    assert p.stock >= 0
    return p.stock


BUSY_RETRIES: list[int] = []  # quantas repetições por 503 cada corrida precisou (registrado no relatório)


def race(n: int, task: Callable[[int], Any]) -> list[Any]:
    """Executa `task(i)` em n threads ao mesmo tempo.

    Sob disputa extrema a API pode responder 503 `database_busy` (nada foi aplicado). O contrato
    manda o cliente repetir com a MESMA chave de idempotência — é o que a thread faz aqui; o
    resultado final de cada thread é então o da repetição.
    """
    start = threading.Barrier(n)
    retries = 0
    lock = threading.Lock()

    def attempt(i: int) -> Any:
        nonlocal retries
        start.wait()
        for _ in range(5):
            try:
                return task(i)
            except DatabaseBusy:
                with lock:
                    retries += 1
            except ApiError as exc:
                return exc
        return DatabaseBusy()

    with ThreadPoolExecutor(max_workers=n) as pool:
        results = list(pool.map(attempt, range(n)))
    BUSY_RETRIES.append(retries)
    return results


@pytest.fixture
def stocked(db: Any) -> Any:
    put_docs(
        db,
        categories=[category("racoes", "Rações")],
        products=[product("p1", stock=10), product("p2", stock=3), product("arq", stock=5, archived=True, published=False)],
    )
    return db


# --------------------------------------------------------------------- vendas e estoque


def test_multi_item_sale_decrements_stock_atomically(client: TestClient, repos: Repositories, stocked: Any) -> None:
    r = client.post(SALES, json=sale_body(("p1", 2), ("p2", 3), ("p1", 1)), headers=key("sale-multi-1"))
    assert r.status_code == 201, r.text
    sale = r.json()
    assert r.headers["idempotent-replayed"] == "false"
    assert sale["status"] == "concluida" and sale["items"] == [{"productId": "p1", "qty": 3}, {"productId": "p2", "qty": 3}]
    assert assert_ledger(repos, "p1", 10) == 7
    assert assert_ledger(repos, "p2", 3) == 0
    movements = repos.movements.list(10)
    assert {(m.product_id, m.qty, m.type) for m in movements} == {("p1", -3, MovementType.VENDA), ("p2", -3, MovementType.VENDA)}
    assert all(m.origin == f"Venda {sale['id']}" and m.actor_uid == ADMIN_UID for m in movements)
    stored = repos.sales.get(sale["id"])
    assert stored is not None and stored.created_by == ADMIN_UID


def test_insufficient_stock_writes_nothing(client: TestClient, repos: Repositories, stocked: Any) -> None:
    r = client.post(SALES, json=sale_body(("p1", 2), ("p2", 4)), headers=key("sale-short-1"))
    assert r.status_code == 409 and r.json()["error"]["code"] == "insufficient_stock"
    assert repos.products.get("p1").stock == 10  # type: ignore[union-attr]
    for collection in ("sales", "stock_movements", "idempotency_keys"):
        assert count(stocked, collection) == 0
    # A chave não foi registrada: pode ser usada numa nova tentativa válida.
    assert client.post(SALES, json=sale_body(("p1", 2)), headers=key("sale-short-1")).status_code == 201


def test_archived_and_missing_products_cannot_be_sold(client: TestClient, stocked: Any) -> None:
    assert client.post(SALES, json=sale_body(("arq", 1)), headers=key("sale-arq-1")).status_code == 409
    assert client.post(SALES, json=sale_body(("nao-existe", 1)), headers=key("sale-nx-1")).status_code == 422
    assert count(stocked, "sales") == 0


def test_stock_entry_and_adjustment(client: TestClient, repos: Repositories, stocked: Any) -> None:
    r = client.post(MOVES, json={"productId": "p2", "type": "entrada", "qty": 5}, headers=key("move-in-1"))
    assert r.status_code == 201 and r.json()["product"]["stock"] == 8
    r = client.post(MOVES, json={"productId": "p2", "type": "ajuste", "qty": 6, "note": "Contagem"}, headers=key("move-adj-1"))
    assert r.status_code == 201 and r.json()["movement"]["qty"] == -2
    assert assert_ledger(repos, "p2", 3) == 6


# --------------------------------------------------------------------- cancelamento


def test_cancellation_restores_stock_exactly_once(client: TestClient, repos: Repositories, stocked: Any) -> None:
    sale = client.post(SALES, json=sale_body(("p1", 4)), headers=key("sale-c-1")).json()
    first = client.post(f"{SALES}/{sale['id']}/cancel", headers=key("cancel-c-1"))
    assert first.status_code == 200 and first.json()["status"] == "cancelada"
    assert first.json()["cancelledBy"] == ADMIN_UID
    again = client.post(f"{SALES}/{sale['id']}/cancel", headers=key("cancel-c-2"))
    assert again.status_code == 409
    assert assert_ledger(repos, "p1", 10) == 10
    assert [m.type for m in repos.movements.list(10, product_id="p1")] == [MovementType.ESTORNO, MovementType.VENDA]
    assert client.post(f"{SALES}/nao-existe/cancel", headers=key("cancel-nx-1")).status_code == 404


# --------------------------------------------------------------------- idempotência


def test_replay_returns_original_snapshot_after_later_changes(client: TestClient, repos: Repositories, stocked: Any) -> None:
    original = client.post(SALES, json=sale_body(("p1", 1)), headers=key("sale-r-1"))
    client.post(f"{SALES}/{original.json()['id']}/cancel", headers=key("cancel-r-1"))

    replay = client.post(SALES, json=sale_body(("p1", 1)), headers=key("sale-r-1"))
    assert replay.status_code == 201 and replay.headers["idempotent-replayed"] == "true"
    assert replay.json() == original.json() and replay.json()["status"] == "concluida"
    assert count(stocked, "sales") == 1
    assert assert_ledger(repos, "p1", 10) == 10

    moved = client.post(MOVES, json={"productId": "p1", "type": "entrada", "qty": 2}, headers=key("move-r-1"))
    client.post(MOVES, json={"productId": "p1", "type": "entrada", "qty": 3}, headers=key("move-r-2"))
    again = client.post(MOVES, json={"productId": "p1", "type": "entrada", "qty": 2}, headers=key("move-r-1"))
    assert again.json() == moved.json() and again.json()["product"]["stock"] == 12
    assert assert_ledger(repos, "p1", 10) == 15

    cancel_replay = client.post(f"{SALES}/{original.json()['id']}/cancel", headers=key("cancel-r-1"))
    assert cancel_replay.status_code == 200 and cancel_replay.headers["idempotent-replayed"] == "true"


def test_same_key_with_different_payload_is_409(client: TestClient, stocked: Any) -> None:
    assert client.post(SALES, json=sale_body(("p1", 1)), headers=key("sale-d-1")).status_code == 201
    r = client.post(SALES, json=sale_body(("p1", 2)), headers=key("sale-d-1"))
    assert r.status_code == 409 and r.json()["error"]["code"] == "idempotency_key_reused"
    assert count(stocked, "sales") == 1


def test_expired_key_no_longer_protects(repos: Repositories, stocked: Any) -> None:
    clock = {"now": NOW}
    service = InventoryService(repos, clock=lambda: clock["now"])
    data = SaleCreate(items=[SaleItemIn(product_id="p1", qty=1)])
    first = service.register_sale(data, ADMIN_UID, "sale-exp-1")
    clock["now"] = NOW + timedelta(hours=23, minutes=59)
    assert service.register_sale(data, ADMIN_UID, "sale-exp-1").replayed
    clock["now"] = NOW + timedelta(hours=24)
    late = service.register_sale(data, ADMIN_UID, "sale-exp-1")
    # Contrato: após 24 h a chave volta a ser nova (o documento expirado é substituído).
    assert not late.replayed and late.value.id != first.value.id
    assert count(stocked, "sales") == 2 and count(stocked, "idempotency_keys") == 1


def test_retry_after_lost_response_does_not_reapply(repos: Repositories, stocked: Any) -> None:
    """O commit acontece, mas a resposta se perde (rede): a repetição com a mesma chave devolve o snapshot."""

    class LossyInventory:
        def __init__(self, inner: Any) -> None:
            self.inner, self.lost = inner, False

        def run_in_transaction(self, op: Any) -> Any:
            result = self.inner.run_in_transaction(op)
            if not self.lost:
                self.lost = True
                raise DatabaseUnavailable()
            return result

    service = InventoryService(dataclasses.replace(repos, inventory=LossyInventory(repos.inventory)))
    data = SaleCreate(items=[SaleItemIn(product_id="p2", qty=3)])
    with pytest.raises(DatabaseUnavailable):
        service.register_sale(data, ADMIN_UID, "sale-lost-1")
    retry = service.register_sale(data, ADMIN_UID, "sale-lost-1")
    assert retry.replayed and retry.value.status is SaleStatus.CONCLUIDA
    assert count(stocked, "sales") == 1
    assert assert_ledger(repos, "p2", 3) == 0


# --------------------------------------------------------------------- concorrência


def test_concurrent_sales_of_the_last_unit(new_repos: Callable[[], Repositories], repos: Repositories, db: Any) -> None:
    put_docs(db, products=[product("last", stock=1)])
    services = [InventoryService(new_repos()) for _ in range(THREADS)]
    data = SaleCreate(items=[SaleItemIn(product_id="last", qty=1)])

    results = race(THREADS, lambda i: services[i].register_sale(data, ADMIN_UID, f"sale-last-{i}"))
    sold = [r for r in results if not isinstance(r, ApiError)]
    assert len(sold) == 1, results
    assert all(isinstance(r, InsufficientStock) for r in results if isinstance(r, ApiError)), results
    assert count(db, "sales") == 1
    assert assert_ledger(repos, "last", 1) == 0


def test_concurrent_same_key_applies_once(new_repos: Callable[[], Repositories], repos: Repositories, db: Any) -> None:
    put_docs(db, products=[product("p", stock=20)])
    services = [InventoryService(new_repos()) for _ in range(THREADS)]
    data = SaleCreate(items=[SaleItemIn(product_id="p", qty=2)])

    results = race(THREADS, lambda i: services[i].register_sale(data, ADMIN_UID, "sale-same-key"))
    assert not [r for r in results if isinstance(r, ApiError)], results
    assert sum(not r.replayed for r in results) == 1
    assert len({r.value.id for r in results}) == 1
    assert count(db, "sales") == 1
    assert assert_ledger(repos, "p", 20) == 18


def test_concurrent_sale_and_adjustment_serialize(new_repos: Callable[[], Repositories], repos: Repositories, db: Any) -> None:
    put_docs(db, products=[product("p", stock=5)])
    a, b = InventoryService(new_repos()), InventoryService(new_repos())
    tasks = [
        lambda: a.register_sale(SaleCreate(items=[SaleItemIn(product_id="p", qty=3)]), ADMIN_UID, "mix-sale"),
        lambda: b.move_stock(StockMovementCreate(product_id="p", type="ajuste", qty=10, note="Contagem"), ADMIN_UID, "mix-adj"),
    ]
    results = race(2, lambda i: tasks[i]())
    assert not [r for r in results if isinstance(r, ApiError)], results
    # Venda→ajuste termina em 10; ajuste→venda termina em 7. Nunca um valor intermediário perdido.
    assert assert_ledger(repos, "p", 5) in (7, 10)


def test_concurrent_cancellations_restore_once(new_repos: Callable[[], Repositories], repos: Repositories, db: Any) -> None:
    put_docs(db, products=[product("p", stock=6)])
    sale = InventoryService(repos).register_sale(SaleCreate(items=[SaleItemIn(product_id="p", qty=4)]), ADMIN_UID, "c-sale").value
    services = [InventoryService(new_repos()) for _ in range(THREADS)]

    results = race(THREADS, lambda i: services[i].cancel_sale(sale.id, ADMIN_UID, f"c-cancel-{i}"))
    ok = [r for r in results if not isinstance(r, ApiError)]
    assert len(ok) == 1, results
    assert all(isinstance(r, Conflict) for r in results if isinstance(r, ApiError)), results
    assert assert_ledger(repos, "p", 6) == 6
    assert sum(m.type is MovementType.ESTORNO for m in repos.movements.list(50)) == 1


def test_product_edit_during_stock_change_keeps_both(new_repos: Callable[[], Repositories], repos: Repositories, db: Any) -> None:
    put_docs(db, categories=[category("racoes", "Rações")], products=[product("p", stock=2)])
    edit, move = ProductService(new_repos()), InventoryService(new_repos())
    tasks = [
        lambda: edit.update("p", ProductUpdate(name="Nome editado", featured=True)),
        lambda: move.move_stock(StockMovementCreate(product_id="p", type="entrada", qty=8), ADMIN_UID, "edit-move"),
    ]
    results = race(2, lambda i: tasks[i]())
    assert not [r for r in results if isinstance(r, ApiError)], results
    final = repos.products.get("p")
    assert final is not None and final.name == "Nome editado" and final.featured and final.stock == 10
    assert assert_ledger(repos, "p", 2) == 10


def test_heavy_contention_never_oversells(new_repos: Callable[[], Repositories], repos: Repositories, db: Any) -> None:
    put_docs(db, products=[product("hot", stock=2)])
    services = [InventoryService(new_repos()) for _ in range(THREADS)]
    data = SaleCreate(items=[SaleItemIn(product_id="hot", qty=1)])

    results = race(THREADS, lambda i: services[i].register_sale(data, ADMIN_UID, f"hot-{i}"))
    sold = [r for r in results if not isinstance(r, ApiError)]
    assert len(sold) == 2, results
    assert all(isinstance(r, InsufficientStock) for r in results if isinstance(r, ApiError)), results
    assert count(db, "sales") == 2
    assert assert_ledger(repos, "hot", 2) == 0
