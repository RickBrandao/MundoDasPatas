"""Persistência, serialização, consultas e rollback no Firestore Emulator."""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.domain.models import DEFAULT_SETTINGS, MovementType, Sale, SaleItem, SaleStatus, StockMovement
from app.repositories import firestore_codec as codec
from app.repositories.base import InventoryTransaction, Repositories
from tests.conftest import ADMIN, NOW, category, product
from tests_emulator.conftest import count, put_docs

API = "/api/v1"


def test_empty_database_serves_empty_catalog_without_writing(client: TestClient, db: Any) -> None:
    r = client.get(f"{API}/public/catalog")
    assert r.status_code == 200
    body = r.json()
    assert body["products"] == [] and body["categories"] == []
    assert body["store"]["storeName"] == DEFAULT_SETTINGS.store_name
    assert client.get(f"{API}/admin/dashboard", headers=ADMIN).status_code == 200
    # Configurações padrão são calculadas, nunca gravadas implicitamente.
    assert not db.collection("settings").document("store").get().exists
    assert list(db.collections()) == []


def test_product_and_initial_movement_persist_across_instances(
    client: TestClient, new_repos: Callable[[], Repositories], db: Any
) -> None:
    cat = client.post(f"{API}/admin/categories", json={"name": "Rações"}, headers=ADMIN).json()
    body = {
        "name": "Ração Premium",
        "categoryId": cat["id"],
        "priceCents": 15990,
        "showPrice": True,
        "stock": 7,
        "published": True,
    }
    created = client.post(f"{API}/admin/products", json=body, headers=ADMIN)
    assert created.status_code == 201, created.text
    pid = created.json()["id"]

    other = new_repos()  # outra "instância": nada vem de memória do processo
    p = other.products.get(pid)
    assert p is not None and p.stock == 7 and p.price_cents == 15990 and p.category_id == cat["id"]
    (movement,) = other.movements.list(10, product_id=pid)
    assert movement.type is MovementType.CADASTRO and movement.qty == 7
    raw = db.collection("products").document(pid).get().to_dict()
    assert raw["price_cents"] == 15990 and "priceCents" not in raw and "id" not in raw
    public = client.get(f"{API}/public/catalog").json()
    assert [x["id"] for x in public["products"]] == [pid]


def test_product_patch_keeps_stock_and_validates(client: TestClient, db: Any) -> None:
    put_docs(db, categories=[category("racoes", "Rações")], products=[product("p1", stock=4)])
    r = client.patch(f"{API}/admin/products/p1", json={"name": "Novo nome", "archived": True}, headers=ADMIN)
    assert r.status_code == 200
    raw = db.collection("products").document("p1").get().to_dict()
    assert raw["name"] == "Novo nome" and raw["stock"] == 4 and raw["published"] is False
    assert client.patch(f"{API}/admin/products/nao-existe", json={"name": "Outro nome"}, headers=ADMIN).status_code == 404


def test_settings_update_persists(client: TestClient, new_repos: Callable[[], Repositories]) -> None:
    data = {
        "storeName": "Mundo das Patas",
        "whatsapp": "(11) 98765-4321",
        "address": "Rua A, 1",
        "hours": "Seg a Sáb",
        "about": "Pet shop",
        "showOutOfStock": False,
        "showFeatured": True,
    }
    assert client.put(f"{API}/admin/settings", json=data, headers=ADMIN).status_code == 200
    saved = new_repos().settings.get()
    assert saved is not None and saved.address == "Rua A, 1" and saved.show_out_of_stock is False
    assert client.get(f"{API}/public/store").json()["address"] == "Rua A, 1"


def test_timestamps_are_native_utc_with_microseconds(repos: Repositories, db: Any) -> None:
    moment = datetime(2026, 10, 20, 9, 30, 15, 123456, tzinfo=UTC)
    put_docs(db, products=[product("p1", created_at=moment, updated_at=moment)])
    raw = db.collection("products").document("p1").get().to_dict()["created_at"]
    assert isinstance(raw, datetime) and raw.utcoffset() == timedelta(0)
    loaded = repos.products.get("p1")
    assert loaded is not None and loaded.created_at == moment and type(loaded.created_at) is datetime


def _movement(mid: str, pid: str, minutes: int) -> StockMovement:
    return StockMovement(mid, pid, MovementType.ENTRADA, 1, NOW + timedelta(minutes=minutes), "", "Painel", "admin")


def _sale(sid: str, minutes: int) -> Sale:
    return Sale(sid, (SaleItem("p1", 1),), SaleStatus.CONCLUIDA, NOW + timedelta(minutes=minutes), "admin")


def test_queries_order_filter_and_limit(repos: Repositories) -> None:
    def write(tx: InventoryTransaction) -> None:
        tx.add_movements([_movement("m1", "p1", 1), _movement("m2", "p2", 3), _movement("m3", "p1", 2)])
        tx.put_sale(_sale("s1", -60 * 24 * 10))
        tx.put_sale(_sale("s2", 0))
        tx.put_sale(_sale("s3", 5))

    repos.inventory.run_in_transaction(write)
    assert [m.id for m in repos.movements.list(10)] == ["m2", "m3", "m1"]
    assert [m.id for m in repos.movements.list(1)] == ["m2"]
    assert [m.id for m in repos.movements.list(10, product_id="p1")] == ["m3", "m1"]
    assert repos.movements.get("m3") == _movement("m3", "p1", 2)
    assert [s.id for s in repos.sales.list(10)] == ["s3", "s2", "s1"]
    assert [s.id for s in repos.sales.list(2)] == ["s3", "s2"]
    assert [s.id for s in repos.sales.list(10, since=NOW - timedelta(days=1))] == ["s3", "s2"]
    assert repos.sales.get("s1") == _sale("s1", -60 * 24 * 10)


def test_missing_documents_return_none(repos: Repositories) -> None:
    assert repos.products.get("x") is None
    assert repos.categories.get("x") is None
    assert repos.sales.get("x") is None
    assert repos.movements.get("x") is None
    assert repos.settings.get() is None
    assert repos.inventory.run_in_transaction(lambda tx: (tx.get_products(["x"]), tx.get_sale("x"))) == ({}, None)


def test_failed_transaction_writes_nothing(repos: Repositories, db: Any) -> None:
    put_docs(db, products=[product("p1", stock=5)])

    def op(tx: InventoryTransaction) -> None:
        current = tx.get_products(["p1"])["p1"]
        tx.put_product(product("p1", stock=current.stock - 5))
        tx.put_sale(_sale("s1", 0))
        tx.add_movements([_movement("m1", "p1", 0)])
        raise RuntimeError("falha no meio da operação")

    with pytest.raises(RuntimeError):
        repos.inventory.run_in_transaction(op)
    assert repos.products.get("p1") == product("p1", stock=5)
    assert count(db, "sales") == 0 and count(db, "stock_movements") == 0


def test_movements_are_immutable(repos: Repositories) -> None:
    repos.inventory.run_in_transaction(lambda tx: tx.add_movements([_movement("m1", "p1", 0)]))
    from app.core.firestore import DatabaseUnavailable

    # `create`: regravar o mesmo ID falha (AlreadyExists) e nada é alterado.
    with pytest.raises(DatabaseUnavailable):
        repos.inventory.run_in_transaction(lambda tx: tx.add_movements([_movement("m1", "p9", 9)]))
    assert repos.movements.get("m1") == _movement("m1", "p1", 0)


def test_idempotency_document_layout(client: TestClient, db: Any) -> None:
    put_docs(db, categories=[category("racoes", "Rações")], products=[product("p1", stock=3)])
    r = client.post(
        f"{API}/admin/sales", json={"items": [{"productId": "p1", "qty": 1}]}, headers=ADMIN | {"Idempotency-Key": "k-layout-1"}
    )
    assert r.status_code == 201
    doc_id = codec.idempotency_doc_id("sale.create", "admin-uid-1", "k-layout-1")
    raw = db.collection("idempotency_keys").document(doc_id).get().to_dict()
    assert raw["result_id"] == r.json()["id"] and raw["response_version"] == 1
    assert raw["expires_at"] - raw["created_at"] == timedelta(hours=24)
    assert set(raw) == {
        "key", "operation", "actor_uid", "request_hash", "result_id", "response", "response_version", "created_at", "expires_at"
    }  # fmt: skip
