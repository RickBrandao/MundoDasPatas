"""Idempotência das operações sensíveis: cancelamento retry-safe (IDP-01) e snapshots da resposta original (IDP-02)."""

import dataclasses
import json
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.errors import Conflict
from app.core.security import VerifiedToken
from app.domain.models import SaleStatus
from app.repositories.base import Repositories
from app.repositories.memory import MemoryState
from app.schemas.inventory import SaleCreate, SaleOut
from app.services.common import request_hash
from app.services.inventory import (
    IDEMPOTENCY_TTL,
    OP_SALE,
    OP_SALE_CANCEL,
    OP_STOCK_MOVE,
    SNAPSHOT_VERSION,
    IdempotencyKeyReused,
    InventoryService,
    Outcome,
)
from tests.conftest import ADMIN, ADMIN_UID, NOW, FakeVerifier, build_client, make_settings, seed

SALES = "/api/v1/admin/sales"
MOVES = "/api/v1/admin/stock/movements"


def key(name: str) -> dict[str, str]:
    return ADMIN | {"Idempotency-Key": f"chave-{name}"}


def stock(state: MemoryState, product_id: str) -> int:
    return state.products[product_id].stock


def movements(state: MemoryState, type_: str) -> int:
    return sum(1 for m in state.movements if m.type == type_)


def new_sale(client: TestClient, items: list[dict[str, Any]] | None = None, k: str = "venda") -> dict[str, Any]:
    r = client.post(SALES, json={"items": items or [{"productId": "p1", "qty": 3}]}, headers=key(k))
    assert r.status_code == 201
    return r.json()


def run_concurrently[T](n: int, task: Callable[[int], T]) -> list[T | Exception]:
    start = threading.Barrier(n)

    def attempt(i: int) -> T | Exception:
        start.wait()
        try:
            return task(i)
        except Exception as exc:  # noqa: BLE001 - o teste inspeciona o tipo
            return exc

    with ThreadPoolExecutor(max_workers=n) as pool:
        return list(pool.map(attempt, range(n)))


# --------------------------------------------------------------------- IDP-01: cancelamento


def test_cancel_and_retry_with_same_key_replays_without_new_refund(client: TestClient, state: MemoryState) -> None:
    seed(state)
    sale = new_sale(client, [{"productId": "p1", "qty": 3}, {"productId": "brinquedo", "qty": 1}])
    assert stock(state, "p1") == 7

    first = client.post(f"{SALES}/{sale['id']}/cancel", headers=key("cancelar-1"))
    assert first.status_code == 200
    assert first.headers["idempotent-replayed"] == "false"
    assert first.json()["status"] == "cancelada"
    assert stock(state, "p1") == 10 and stock(state, "brinquedo") == 1
    assert movements(state, "estorno") == 2

    retry = client.post(f"{SALES}/{sale['id']}/cancel", headers=key("cancelar-1"))
    assert retry.status_code == 200
    assert retry.headers["idempotent-replayed"] == "true"
    assert retry.json() == first.json()
    assert stock(state, "p1") == 10 and stock(state, "brinquedo") == 1  # estorno único
    assert movements(state, "estorno") == 2  # nenhuma movimentação adicional


def test_cancel_with_new_key_after_cancellation_is_conflict(client: TestClient, state: MemoryState) -> None:
    seed(state)
    sale = new_sale(client)
    assert client.post(f"{SALES}/{sale['id']}/cancel", headers=key("cancelar-1")).status_code == 200

    other = client.post(f"{SALES}/{sale['id']}/cancel", headers=key("cancelar-2"))
    assert other.status_code == 409
    assert other.json()["error"]["code"] == "conflict"
    assert stock(state, "p1") == 10
    assert movements(state, "estorno") == 1


def test_cancel_requires_idempotency_key(client: TestClient, state: MemoryState) -> None:
    seed(state)
    sale = new_sale(client)
    r = client.post(f"{SALES}/{sale['id']}/cancel", headers=ADMIN)
    assert r.status_code == 422
    assert "Idempotency-Key" in r.json()["error"]["fieldErrors"]
    assert state.sales[sale["id"]].status is SaleStatus.CONCLUIDA


def test_cancel_key_is_bound_to_the_sale(client: TestClient, state: MemoryState) -> None:
    seed(state)
    a = new_sale(client, k="venda-a")
    b = new_sale(client, k="venda-b")
    assert client.post(f"{SALES}/{a['id']}/cancel", headers=key("cancelar-x")).status_code == 200

    reused = client.post(f"{SALES}/{b['id']}/cancel", headers=key("cancelar-x"))
    assert reused.status_code == 409
    assert reused.json()["error"]["code"] == "idempotency_key_reused"
    assert state.sales[b["id"]].status is SaleStatus.CONCLUIDA


def test_cancel_retry_after_lost_response(client: TestClient, repos: Repositories, state: MemoryState) -> None:
    seed(state)
    sale = new_sale(client)
    # O servidor aplicou o cancelamento, mas a resposta nunca chegou ao navegador.
    lost = InventoryService(repos).cancel_sale(sale["id"], ADMIN_UID, "chave-perdida")
    assert lost.replayed is False

    retry = client.post(f"{SALES}/{sale['id']}/cancel", headers=ADMIN | {"Idempotency-Key": "chave-perdida"})
    assert retry.status_code == 200
    assert retry.headers["idempotent-replayed"] == "true"
    assert retry.json() == lost.value.model_dump(mode="json")
    assert stock(state, "p1") == 10
    assert movements(state, "estorno") == 1


def test_concurrent_cancellations_with_same_key(repos: Repositories, state: MemoryState) -> None:
    seed(state)
    service = InventoryService(repos)
    sale = service.register_sale(SaleCreate.model_validate({"items": [{"productId": "p1", "qty": 4}]}), ADMIN_UID, "k-venda-1")

    results = run_concurrently(8, lambda _: service.cancel_sale(sale.value.id, ADMIN_UID, "k-cancelar-1"))
    outcomes = [r for r in results if isinstance(r, Outcome)]
    assert len(outcomes) == 8  # todas reconhecem o sucesso
    assert [o.replayed for o in outcomes].count(False) == 1
    assert len({o.value.model_dump_json() for o in outcomes}) == 1
    assert stock(state, "p1") == 10
    assert movements(state, "estorno") == 1


def test_concurrent_cancellations_with_different_keys(repos: Repositories, state: MemoryState) -> None:
    seed(state)
    service = InventoryService(repos)
    sale = service.register_sale(SaleCreate.model_validate({"items": [{"productId": "p1", "qty": 4}]}), ADMIN_UID, "k-venda-1")

    results = run_concurrently(8, lambda i: service.cancel_sale(sale.value.id, ADMIN_UID, f"k-cancelar-{i}"))
    assert sum(isinstance(r, Outcome) for r in results) == 1
    conflicts = [r for r in results if isinstance(r, Conflict)]
    assert len(conflicts) == 7 and not any(isinstance(c, IdempotencyKeyReused) for c in conflicts)
    assert stock(state, "p1") == 10
    assert movements(state, "estorno") == 1


# --------------------------------------------------------------------- IDP-02: snapshots


def test_replay_before_any_change_returns_identical_body(client: TestClient, state: MemoryState) -> None:
    seed(state)
    body = {"productId": "p1", "type": "entrada", "qty": 2}
    first = client.post(MOVES, json=body, headers=key("k1"))
    again = client.post(MOVES, json=body, headers=key("k1"))
    assert again.status_code == first.status_code == 201
    assert again.headers["idempotent-replayed"] == "true"
    assert again.json() == first.json()


def test_movement_replay_returns_original_stock_after_later_movement(client: TestClient, state: MemoryState) -> None:
    seed(state)  # p1 começa com 10
    k1 = {"productId": "p1", "type": "entrada", "qty": 2}
    first = client.post(MOVES, json=k1, headers=key("k1"))
    assert first.json()["product"]["stock"] == 12

    assert client.post(MOVES, json={"productId": "p1", "type": "entrada", "qty": 3}, headers=key("k2")).status_code == 201
    assert stock(state, "p1") == 15

    replay = client.post(MOVES, json=k1, headers=key("k1"))
    assert replay.status_code == 201
    assert replay.headers["idempotent-replayed"] == "true"
    assert replay.json()["product"]["stock"] == 12  # resultado original, não o estado atual
    assert replay.json() == first.json()
    assert stock(state, "p1") == 15
    assert movements(state, "entrada") == 2


def test_sale_replay_after_cancellation_returns_original_sale(client: TestClient, state: MemoryState) -> None:
    seed(state)
    body = {"items": [{"productId": "p1", "qty": 3}]}
    first = client.post(SALES, json=body, headers=key("venda-1"))
    assert first.json()["status"] == "concluida"
    assert client.post(f"{SALES}/{first.json()['id']}/cancel", headers=key("cancelar-1")).status_code == 200

    replay = client.post(SALES, json=body, headers=key("venda-1"))
    assert replay.status_code == 201
    assert replay.headers["idempotent-replayed"] == "true"
    assert replay.json() == first.json()
    assert replay.json()["status"] == "concluida" and replay.json()["cancelledAt"] is None
    assert len(state.sales) == 1  # nenhuma venda nova
    assert stock(state, "p1") == 10  # nenhuma nova baixa
    assert movements(state, "venda") == 1


def test_same_key_with_different_payload_is_rejected(client: TestClient, state: MemoryState) -> None:
    seed(state)
    assert client.post(SALES, json={"items": [{"productId": "p1", "qty": 1}]}, headers=key("k1")).status_code == 201
    r = client.post(SALES, json={"items": [{"productId": "p1", "qty": 2}]}, headers=key("k1"))
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "idempotency_key_reused"
    assert len(state.sales) == 1 and stock(state, "p1") == 9


def test_same_key_from_different_users_are_independent(repos: Repositories, state: MemoryState) -> None:
    seed(state)
    verifier = FakeVerifier(
        {
            "token-a": VerifiedToken(uid="admin-a", claims={}),
            "token-b": VerifiedToken(uid="admin-b", claims={}),
        }
    )
    settings = make_settings(firebase_project_id="demo-test", admin_allowed_uids="admin-a,admin-b")
    headers_a = {"Authorization": "Bearer token-a", "Idempotency-Key": "chave-compartilhada"}
    headers_b = {"Authorization": "Bearer token-b", "Idempotency-Key": "chave-compartilhada"}
    body = {"items": [{"productId": "p1", "qty": 1}]}
    with build_client(settings, repos, verifier) as c:
        a = c.post(SALES, json=body, headers=headers_a)
        b = c.post(SALES, json=body, headers=headers_b)
        assert a.headers["idempotent-replayed"] == b.headers["idempotent-replayed"] == "false"
        assert a.json()["id"] != b.json()["id"]
        assert a.json()["createdBy"] == "admin-a" and b.json()["createdBy"] == "admin-b"
        assert c.post(SALES, json=body, headers=headers_a).json() == a.json()
    assert len(state.sales) == 2 and stock(state, "p1") == 8


def test_concurrent_sales_with_same_key_register_once(repos: Repositories, state: MemoryState) -> None:
    seed(state)
    service = InventoryService(repos)
    data = SaleCreate.model_validate({"items": [{"productId": "p1", "qty": 2}]})

    results = run_concurrently(8, lambda _: service.register_sale(data, ADMIN_UID, "k-mesma-venda"))
    outcomes = [r for r in results if isinstance(r, Outcome)]
    assert len(outcomes) == 8
    assert [o.replayed for o in outcomes].count(False) == 1
    assert len({o.value.id for o in outcomes}) == 1
    assert len(state.sales) == 1 and stock(state, "p1") == 8


def test_snapshot_is_stored_atomically_and_round_trips(client: TestClient, state: MemoryState) -> None:
    seed(state)
    sale = client.post(SALES, json={"items": [{"productId": "p1", "qty": 1}]}, headers=key("k1")).json()
    move = client.post(MOVES, json={"productId": "p1", "type": "entrada", "qty": 5}, headers=key("k2")).json()
    cancel = client.post(f"{SALES}/{sale['id']}/cancel", headers=key("k3")).json()

    expected = {
        OP_SALE: (
            sale["id"],
            sale,
            SaleCreate.model_validate({"items": [{"productId": "p1", "qty": 1}]}).model_dump(mode="json"),
        ),
        OP_STOCK_MOVE: (move["movement"]["id"], move, None),
        OP_SALE_CANCEL: (sale["id"], cancel, {"saleId": sale["id"]}),
    }
    assert len(state.idempotency) == 3
    for (operation, actor, _), record in state.idempotency.items():
        result_id, body, payload = expected[operation]
        assert actor == ADMIN_UID and record.actor_uid == ADMIN_UID
        assert record.result_id == result_id
        assert isinstance(record.response, str) and json.loads(record.response) == body
        assert record.response_version == SNAPSHOT_VERSION
        assert record.expires_at - record.created_at == IDEMPOTENCY_TTL
        if payload is not None:
            assert record.request_hash == request_hash(payload)
        with pytest.raises(dataclasses.FrozenInstanceError):
            record.response = "{}"  # type: ignore[misc]
    assert (
        SaleOut.model_validate_json(state.idempotency[(OP_SALE_CANCEL, ADMIN_UID, "chave-k3")].response).model_dump(mode="json")
        == cancel
    )


def test_failed_operation_records_no_key(client: TestClient, state: MemoryState) -> None:
    seed(state)
    r = client.post(SALES, json={"items": [{"productId": "p1", "qty": 999}]}, headers=key("k1"))
    assert r.status_code == 409
    assert state.idempotency == {}
    # A mesma chave pode ser usada depois para uma tentativa válida.
    assert client.post(SALES, json={"items": [{"productId": "p1", "qty": 1}]}, headers=key("k1")).status_code == 201


def test_unknown_snapshot_version_is_never_reapplied(client: TestClient, state: MemoryState) -> None:
    seed(state)
    body = {"items": [{"productId": "p1", "qty": 1}]}
    assert client.post(SALES, json=body, headers=key("k1")).status_code == 201
    record_key = (OP_SALE, ADMIN_UID, "chave-k1")
    state.idempotency[record_key] = dataclasses.replace(state.idempotency[record_key], response_version=0)

    r = client.post(SALES, json=body, headers=key("k1"))
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "idempotency_replay_unavailable"
    assert len(state.sales) == 1 and stock(state, "p1") == 9


# --------------------------------------------------------------------- expiração


class _Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def test_key_protects_until_expiration_and_is_new_afterwards(repos: Repositories, state: MemoryState) -> None:
    seed(state)
    clock = _Clock(NOW)
    service = InventoryService(repos, clock=clock)
    data = SaleCreate.model_validate({"items": [{"productId": "p1", "qty": 1}]})
    first = service.register_sale(data, ADMIN_UID, "k-venda-ttl")

    clock.now = NOW + IDEMPOTENCY_TTL - timedelta(microseconds=1)
    before = service.register_sale(data, ADMIN_UID, "k-venda-ttl")
    assert before.replayed is True and before.value == first.value

    # No instante da expiração a chave deixa de proteger: a repetição é tratada como venda nova.
    clock.now = NOW + IDEMPOTENCY_TTL
    after = service.register_sale(data, ADMIN_UID, "k-venda-ttl")
    assert after.replayed is False and after.value.id != first.value.id
    assert len(state.sales) == 2 and stock(state, "p1") == 8
    # O registro novo substitui o expirado e conta a janela a partir de agora.
    assert state.idempotency[(OP_SALE, ADMIN_UID, "k-venda-ttl")].expires_at == NOW + 2 * IDEMPOTENCY_TTL


def test_expired_cancel_key_still_cannot_refund_twice(repos: Repositories, state: MemoryState) -> None:
    seed(state)
    clock = _Clock(NOW)
    service = InventoryService(repos, clock=clock)
    sale = service.register_sale(SaleCreate.model_validate({"items": [{"productId": "p1", "qty": 2}]}), ADMIN_UID, "k-venda")
    service.cancel_sale(sale.value.id, ADMIN_UID, "k-cancelar")

    clock.now = NOW + IDEMPOTENCY_TTL
    with pytest.raises(Conflict):
        service.cancel_sale(sale.value.id, ADMIN_UID, "k-cancelar")
    assert stock(state, "p1") == 10
    assert movements(state, "estorno") == 1
