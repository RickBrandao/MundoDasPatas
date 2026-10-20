from dataclasses import replace

from fastapi.testclient import TestClient

from app.domain.models import DEFAULT_SETTINGS, MovementType, Sale, SaleItem, SaleStatus, StockMovement
from app.repositories.memory import MemoryState
from tests.conftest import NOW, seed

PUBLIC_PRODUCT_FIELDS = {
    "id",
    "name",
    "description",
    "categoryId",
    "brand",
    "imageUrl",
    "priceCents",
    "featured",
    "stock",
    "stockStatus",
}
FORBIDDEN_KEYS = {
    "minStock",
    "published",
    "archived",
    "showPrice",
    "createdAt",
    "updatedAt",
    "sales",
    "movements",
    "createdBy",
    "actorUid",
    "showOutOfStock",
    "active",
    "seq",
}


def _all_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _all_keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _all_keys(v)}
    return set()


def _with_private_data(state: MemoryState) -> None:
    seed(state)
    state.sales["s1"] = Sale(
        id="s1", items=(SaleItem("p1", 1),), status=SaleStatus.CONCLUIDA, created_at=NOW, created_by="admin-uid-1"
    )
    state.movements.append(
        StockMovement(
            id="m1",
            product_id="p1",
            type=MovementType.VENDA,
            qty=-1,
            created_at=NOW,
            note="",
            origin="Venda s1",
            actor_uid="admin-uid-1",
        )
    )


def test_catalog_lists_only_visible_products(client: TestClient, state: MemoryState) -> None:
    seed(state)
    body = client.get("/api/v1/public/catalog").json()
    ids = [p["id"] for p in body["products"]]
    # Destaque primeiro; oculto, arquivado e categoria inativa nunca aparecem.
    assert ids[0] == "p1"
    assert set(ids) == {"p1", "p2", "p3", "esgotado", "brinquedo"}


def test_catalog_hides_out_of_stock_when_store_says_so(client: TestClient, state: MemoryState) -> None:
    seed(state, settings=replace(DEFAULT_SETTINGS, show_out_of_stock=False))
    ids = {p["id"] for p in client.get("/api/v1/public/catalog").json()["products"]}
    assert "esgotado" not in ids
    assert "p1" in ids


def test_catalog_respects_price_display(client: TestClient, state: MemoryState) -> None:
    seed(state)
    products = {p["id"]: p for p in client.get("/api/v1/public/catalog").json()["products"]}
    assert products["p1"]["priceCents"] == 4990
    assert products["p2"]["priceCents"] is None
    assert products["p3"]["priceCents"] is None  # tem preço cadastrado, mas a loja não exibe


def test_catalog_exposes_availability_without_admin_fields(client: TestClient, state: MemoryState) -> None:
    _with_private_data(state)
    body = client.get("/api/v1/public/catalog").json()
    assert set(body) == {"store", "categories", "products"}
    for p in body["products"]:
        assert set(p) == PUBLIC_PRODUCT_FIELDS
    statuses = {p["id"]: p["stockStatus"] for p in body["products"]}
    assert statuses == {"p1": "ok", "p2": "ok", "p3": "ok", "esgotado": "out", "brinquedo": "low"}
    assert not (_all_keys(body) & FORBIDDEN_KEYS)
    assert "admin-uid-1" not in str(body)


def test_categories_only_active(client: TestClient, state: MemoryState) -> None:
    seed(state)
    body = client.get("/api/v1/public/categories").json()
    assert body == [
        {"id": "brinquedos", "name": "Brinquedos", "icon": "label"},
        {"id": "racoes", "name": "Rações", "icon": "label"},
    ]


def test_product_detail(client: TestClient, state: MemoryState) -> None:
    seed(state)
    r = client.get("/api/v1/public/products/p1")
    assert r.status_code == 200
    assert set(r.json()) == PUBLIC_PRODUCT_FIELDS


def test_hidden_products_respond_404(client: TestClient, state: MemoryState) -> None:
    seed(state)
    for pid in ["oculto", "arquivado", "cat-inativa", "inexistente"]:
        r = client.get(f"/api/v1/public/products/{pid}")
        assert r.status_code == 404, pid
        assert r.json()["error"]["code"] == "not_found"


def test_store_info_without_internal_settings(client: TestClient, state: MemoryState) -> None:
    seed(state, settings=replace(DEFAULT_SETTINGS, whatsapp="(11) 98765-4321", show_out_of_stock=False))
    body = client.get("/api/v1/public/store").json()
    assert body == {
        "storeName": "Mundo das Patas",
        "whatsapp": "(11) 98765-4321",
        "address": "",
        "hours": "",
        "about": "",
        "showFeatured": True,
    }


def test_public_api_is_read_only(client: TestClient) -> None:
    assert client.post("/api/v1/public/catalog", json={}).status_code == 405
    assert client.post("/api/v1/public/products/p1", json={}).status_code == 405


def test_empty_store_returns_defaults_not_fake_data(client: TestClient) -> None:
    body = client.get("/api/v1/public/catalog").json()
    assert body["products"] == []
    assert body["categories"] == []
    assert body["store"]["whatsapp"] == ""
