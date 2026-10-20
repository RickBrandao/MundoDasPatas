"""Fluxo administrativo ponta a ponta sobre os repositórios em memória (autenticação simulada)."""

import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi.testclient import TestClient

from app.core.errors import InsufficientStock
from app.repositories.base import Repositories
from app.repositories.memory import MemoryState
from app.schemas.inventory import SaleCreate
from app.services.inventory import InventoryService
from tests.conftest import ADMIN, ADMIN_UID, product, seed

PRODUCT = {"name": "Ração Teste 1 kg", "categoryId": "racoes", "priceCents": 4990, "showPrice": True, "stock": 5, "minStock": 2}


def key(n: int) -> dict[str, str]:
    return ADMIN | {"Idempotency-Key": f"chave-teste-{n:04d}"}


def stock(client: TestClient, product_id: str) -> int:
    products = client.get("/api/v1/admin/products", headers=ADMIN).json()
    return next(p["stock"] for p in products if p["id"] == product_id)


# --------------------------------------------------------------------- categorias


def test_category_crud_and_unique_names(client: TestClient) -> None:
    r = client.post("/api/v1/admin/categories", json={"name": "Aves"}, headers=ADMIN)
    assert r.status_code == 201
    cat = r.json()
    assert cat["active"] is True and cat["icon"] == "label"

    dup = client.post("/api/v1/admin/categories", json={"name": " aves "}, headers=ADMIN)
    assert dup.status_code == 409
    assert dup.json()["error"]["fieldErrors"] == {"name": "Já existe uma categoria com esse nome."}

    r = client.patch(f"/api/v1/admin/categories/{cat['id']}", json={"active": False}, headers=ADMIN)
    assert r.json()["active"] is False
    assert client.patch("/api/v1/admin/categories/x", json={"active": True}, headers=ADMIN).status_code == 404


# --------------------------------------------------------------------- produtos


def test_create_product_records_initial_stock_with_actor(client: TestClient, state: MemoryState) -> None:
    seed(state)
    r = client.post("/api/v1/admin/products", json=PRODUCT, headers=ADMIN)
    assert r.status_code == 201
    created = r.json()
    assert created["stock"] == 5 and created["archived"] is False and created["published"] is False
    assert created["createdAt"].endswith("Z")

    moves = client.get("/api/v1/admin/stock/movements", params={"productId": created["id"]}, headers=ADMIN).json()
    assert [(m["type"], m["qty"], m["actorUid"]) for m in moves] == [("cadastro", 5, ADMIN_UID)]


def test_create_product_validations(client: TestClient, state: MemoryState) -> None:
    seed(state)
    r = client.post("/api/v1/admin/products", json=PRODUCT | {"categoryId": "nao-existe"}, headers=ADMIN)
    assert r.status_code == 422
    assert r.json()["error"]["fieldErrors"] == {"categoryId": "Categoria inexistente."}

    r = client.post("/api/v1/admin/products", json=PRODUCT | {"priceCents": None}, headers=ADMIN)
    assert r.status_code == 422
    assert "priceCents" in r.json()["error"]["fieldErrors"]

    r = client.post("/api/v1/admin/products", json=PRODUCT | {"priceCents": 49.9}, headers=ADMIN)
    assert r.status_code == 422
    assert "priceCents" in r.json()["error"]["fieldErrors"]


def test_patch_product_flags_and_archive_unpublishes(client: TestClient, state: MemoryState) -> None:
    seed(state)
    r = client.patch("/api/v1/admin/products/p1", json={"archived": True}, headers=ADMIN)
    assert r.status_code == 200
    assert r.json()["archived"] is True and r.json()["published"] is False
    assert client.get("/api/v1/public/products/p1").status_code == 404


def test_patch_product_cannot_change_stock(client: TestClient, state: MemoryState) -> None:
    seed(state)
    r = client.patch("/api/v1/admin/products/p1", json={"stock": 999}, headers=ADMIN)
    assert r.status_code == 422
    assert stock(client, "p1") == 10


def test_patch_product_price_rule_and_not_found(client: TestClient, state: MemoryState) -> None:
    seed(state)
    assert client.patch("/api/v1/admin/products/p1", json={"priceCents": None}, headers=ADMIN).status_code == 422
    r = client.patch("/api/v1/admin/products/p1", json={"priceCents": None, "showPrice": False}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["priceCents"] is None
    assert client.patch("/api/v1/admin/products/zzz", json={"featured": True}, headers=ADMIN).status_code == 404


# --------------------------------------------------------------------- estoque


def test_stock_entry_is_idempotent(client: TestClient, state: MemoryState) -> None:
    seed(state)
    body = {"productId": "p1", "type": "entrada", "qty": 4}
    first = client.post("/api/v1/admin/stock/movements", json=body, headers=key(1))
    assert first.status_code == 201
    assert first.headers["idempotent-replayed"] == "false"
    assert first.json()["product"]["stock"] == 14

    again = client.post("/api/v1/admin/stock/movements", json=body, headers=key(1))
    assert again.status_code == 201
    assert again.headers["idempotent-replayed"] == "true"
    assert again.json()["movement"]["id"] == first.json()["movement"]["id"]
    assert stock(client, "p1") == 14  # não somou duas vezes

    reused = client.post("/api/v1/admin/stock/movements", json=body | {"qty": 5}, headers=key(1))
    assert reused.status_code == 409
    assert reused.json()["error"]["code"] == "idempotency_key_reused"


def test_stock_movement_requires_idempotency_key(client: TestClient, state: MemoryState) -> None:
    seed(state)
    r = client.post("/api/v1/admin/stock/movements", json={"productId": "p1", "type": "entrada", "qty": 1}, headers=ADMIN)
    assert r.status_code == 422
    assert "Idempotency-Key" in r.json()["error"]["fieldErrors"]


def test_stock_adjustment_rules(client: TestClient, state: MemoryState) -> None:
    seed(state)
    url = "/api/v1/admin/stock/movements"
    no_note = client.post(url, json={"productId": "p1", "type": "ajuste", "qty": 3}, headers=key(1))
    assert no_note.status_code == 422
    assert no_note.json()["error"]["fieldErrors"] == {"note": "Informe o motivo do ajuste."}

    ok = client.post(url, json={"productId": "p1", "type": "ajuste", "qty": 3, "note": "Contagem"}, headers=key(2))
    assert ok.json()["movement"]["qty"] == -7
    assert ok.json()["product"]["stock"] == 3

    missing = client.post(url, json={"productId": "nope", "type": "entrada", "qty": 1}, headers=key(3))
    assert missing.status_code == 404


# --------------------------------------------------------------------- vendas


def test_sale_flow_with_cancellation(client: TestClient, state: MemoryState) -> None:
    seed(state)
    r = client.post(
        "/api/v1/admin/sales",
        json={"items": [{"productId": "p1", "qty": 3}, {"productId": "brinquedo", "qty": 1}]},
        headers=key(1),
    )
    assert r.status_code == 201
    sale = r.json()
    assert sale["status"] == "concluida" and sale["createdBy"] == ADMIN_UID and sale["cancelledAt"] is None
    assert stock(client, "p1") == 7 and stock(client, "brinquedo") == 0

    types = [m["type"] for m in client.get("/api/v1/admin/stock/movements", headers=ADMIN).json()]
    assert types.count("venda") == 2

    cancel = client.post(f"/api/v1/admin/sales/{sale['id']}/cancel", headers=key(2))
    assert cancel.status_code == 200
    assert cancel.json()["status"] == "cancelada" and cancel.json()["cancelledBy"] == ADMIN_UID
    assert stock(client, "p1") == 10 and stock(client, "brinquedo") == 1

    # Mesma chave: repetição segura (resposta original). Chave nova: novo cancelamento, recusado.
    again = client.post(f"/api/v1/admin/sales/{sale['id']}/cancel", headers=key(2))
    assert again.status_code == 200 and again.headers["idempotent-replayed"] == "true"
    twice = client.post(f"/api/v1/admin/sales/{sale['id']}/cancel", headers=key(3))
    assert twice.status_code == 409
    assert stock(client, "p1") == 10  # estorno não duplicado

    assert client.post("/api/v1/admin/sales/nao-existe/cancel", headers=key(4)).status_code == 404


def test_sale_with_insufficient_stock_changes_nothing(client: TestClient, state: MemoryState) -> None:
    seed(state)
    r = client.post(
        "/api/v1/admin/sales",
        json={"items": [{"productId": "p1", "qty": 1}, {"productId": "brinquedo", "qty": 2}]},
        headers=key(1),
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "insufficient_stock"
    assert stock(client, "p1") == 10
    assert client.get("/api/v1/admin/sales", headers=ADMIN).json() == []
    assert client.get("/api/v1/admin/stock/movements", headers=ADMIN).json() == []


def test_repeated_sale_request_is_registered_once(client: TestClient, state: MemoryState) -> None:
    seed(state)
    body = {"items": [{"productId": "p1", "qty": 2}]}
    first = client.post("/api/v1/admin/sales", json=body, headers=key(7))
    second = client.post("/api/v1/admin/sales", json=body, headers=key(7))
    assert first.json()["id"] == second.json()["id"]
    assert second.headers["idempotent-replayed"] == "true"
    assert stock(client, "p1") == 8
    assert len(client.get("/api/v1/admin/sales", headers=ADMIN).json()) == 1


def test_concurrent_sales_cannot_sell_the_same_unit(repos: Repositories, state: MemoryState) -> None:
    state.products["ultimo"] = product("ultimo", stock=1)
    service = InventoryService(repos)
    start = threading.Barrier(8)

    def attempt(n: int) -> str:
        start.wait()
        try:
            service.register_sale(
                SaleCreate.model_validate({"items": [{"productId": "ultimo", "qty": 1}]}), "admin", f"k-{n}-xxxxx"
            )
            return "ok"
        except InsufficientStock:
            return "sem estoque"

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, range(8)))
    assert results.count("ok") == 1
    assert repos.products.get("ultimo").stock == 0  # type: ignore[union-attr]


# --------------------------------------------------------------------- dashboard e configurações


def test_dashboard_summary(client: TestClient, state: MemoryState) -> None:
    seed(state)
    client.post("/api/v1/admin/sales", json={"items": [{"productId": "p1", "qty": 2}]}, headers=key(1))
    body: dict[str, Any] = client.get("/api/v1/admin/dashboard", headers=ADMIN).json()
    assert body["catalog"]["active"] == 7  # arquivado não conta
    assert body["catalog"]["visible"] == 5
    assert body["catalog"]["hiddenByCategory"] == 1
    assert body["catalog"]["inactiveCategories"] == 1
    assert body["salesLast7Days"] == {"count": 1, "units": 2}
    assert [i["id"] for i in body["lowStock"]] == ["esgotado", "brinquedo"]


def test_settings_default_and_update(client: TestClient) -> None:
    assert client.get("/api/v1/admin/settings", headers=ADMIN).json()["storeName"] == "Mundo das Patas"

    new = {
        "storeName": "Mundo das Patas",
        "whatsapp": "123",
        "address": "Rua A",
        "hours": "9h-18h",
        "about": "",
        "showOutOfStock": False,
        "showFeatured": True,
    }
    bad = client.put("/api/v1/admin/settings", json=new, headers=ADMIN)
    assert bad.status_code == 422
    assert "whatsapp" in bad.json()["error"]["fieldErrors"]

    ok = client.put("/api/v1/admin/settings", json=new | {"whatsapp": "+55 (11) 98765-4321"}, headers=ADMIN)
    assert ok.status_code == 200
    assert ok.json()["showOutOfStock"] is False
    assert client.get("/api/v1/public/store").json()["address"] == "Rua A"
