from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest
from pydantic import ValidationError

from app.schemas.catalog import CategoryCreate, CategoryUpdate, ProductAdminOut, ProductCreate, ProductUpdate, PublicProduct
from app.schemas.inventory import SaleCreate, StockMovementCreate, StockMovementOut
from app.schemas.store import SettingsIn
from tests.conftest import product

VALID_PRODUCT: dict[str, Any] = {
    "name": "Ração Teste 1 kg",
    "categoryId": "racoes",
    "priceCents": 4990,
    "showPrice": True,
    "stock": 5,
}


# --------------------------------------------------------------------- produtos


def test_product_create_accepts_camel_case_and_applies_defaults() -> None:
    p = ProductCreate.model_validate(VALID_PRODUCT)
    assert p.category_id == "racoes"
    assert p.price_cents == 4990
    assert p.min_stock == 0
    assert p.published is False
    assert p.image_url == ""


def test_product_create_trims_text() -> None:
    p = ProductCreate.model_validate(VALID_PRODUCT | {"name": "  Ração Teste  "})
    assert p.name == "Ração Teste"


@pytest.mark.parametrize(
    "override",
    [
        {"name": "ab"},
        {"name": "   "},
        {"categoryId": ""},
        {"categoryId": "../x"},
        {"priceCents": 0},
        {"priceCents": -100},
        {"priceCents": 49.9},
        {"priceCents": "4990"},
        {"priceCents": True},
        {"stock": -1},
        {"stock": 1.5},
        {"stock": "3"},
        {"minStock": -1},
        {"imageUrl": "data:image/png;base64,AAAA"},
        {"imageUrl": "http://inseguro.example/x.png"},
        {"createdAt": "2026-01-01T00:00:00Z"},
        {"archived": True},
    ],
)
def test_product_create_rejects_invalid(override: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ProductCreate.model_validate(VALID_PRODUCT | override)


def test_product_create_requires_name_and_category() -> None:
    with pytest.raises(ValidationError) as exc:
        ProductCreate.model_validate({})
    missing = {e["loc"][0] for e in exc.value.errors()}
    assert {"name", "categoryId"} <= missing


def test_product_update_is_partial_and_tracks_sent_fields() -> None:
    u = ProductUpdate.model_validate({"published": True, "priceCents": None})
    assert u.changes() == {"published": True, "price_cents": None}


@pytest.mark.parametrize("body", [{"stock": 3}, {"name": None}, {"published": None}, {}, {"createdBy": "x"}])
def test_product_update_rejects_server_fields_nulls_and_empty(body: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ProductUpdate.model_validate(body)


def test_product_admin_serialization_uses_camel_case_and_utc() -> None:
    p = product("p1", created_at=datetime(2026, 10, 20, 9, 0, tzinfo=timezone(timedelta(hours=-3))))
    data = ProductAdminOut.from_domain(p).model_dump(mode="json")
    assert data["categoryId"] == "racoes"
    assert data["priceCents"] == 4990
    assert data["minStock"] == 2
    assert data["stockStatus"] == "ok"
    assert data["createdAt"] == "2026-10-20T12:00:00Z"
    assert "category_id" not in data


def test_public_product_hides_price_when_not_shown() -> None:
    assert PublicProduct.from_domain(product("p", show_price=False, price_cents=1990)).price_cents is None
    assert PublicProduct.from_domain(product("p", show_price=True, price_cents=1990)).price_cents == 1990


def test_public_product_has_no_admin_fields() -> None:
    data = PublicProduct.from_domain(product("p")).model_dump(mode="json")
    assert set(data) == {
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


# --------------------------------------------------------------------- categorias


def test_category_create_defaults_and_validation() -> None:
    assert CategoryCreate.model_validate({"name": "Aves"}).icon == "label"
    with pytest.raises(ValidationError):
        CategoryCreate.model_validate({"name": "A"})
    with pytest.raises(ValidationError):
        CategoryCreate.model_validate({"name": "Aves", "icon": "<script>"})
    with pytest.raises(ValidationError):
        CategoryCreate.model_validate({"name": "Aves", "active": False})


def test_category_update_rejects_null() -> None:
    with pytest.raises(ValidationError):
        CategoryUpdate.model_validate({"active": None})


# --------------------------------------------------------------------- vendas e estoque


@pytest.mark.parametrize("qty", [0, -1, 1.5, "2", 10_001])
def test_sale_item_quantity_must_be_strict_positive_int(qty: Any) -> None:
    with pytest.raises(ValidationError):
        SaleCreate.model_validate({"items": [{"productId": "p1", "qty": qty}]})


def test_sale_requires_items() -> None:
    with pytest.raises(ValidationError):
        SaleCreate.model_validate({"items": []})
    assert SaleCreate.model_validate({"items": [{"productId": "p1", "qty": 2}]}).items[0].qty == 2


@pytest.mark.parametrize("move_type", ["venda", "estorno", "cadastro", "outro"])
def test_stock_movement_only_accepts_entry_or_adjustment(move_type: str) -> None:
    with pytest.raises(ValidationError):
        StockMovementCreate.model_validate({"productId": "p1", "type": move_type, "qty": 1})


def test_stock_movement_rejects_negative_qty() -> None:
    with pytest.raises(ValidationError):
        StockMovementCreate.model_validate({"productId": "p1", "type": "ajuste", "qty": -1, "note": "x"})


def test_datetime_output_requires_timezone() -> None:
    base = {"id": "m1", "productId": "p1", "type": "entrada", "qty": 1, "note": "", "origin": "Painel", "actorUid": None}
    with pytest.raises(ValidationError):
        StockMovementOut.model_validate(base | {"createdAt": datetime(2026, 1, 1)})
    out = StockMovementOut.model_validate(base | {"createdAt": datetime(2026, 1, 1, tzinfo=UTC)})
    assert out.model_dump(mode="json")["createdAt"] == "2026-01-01T00:00:00Z"


# --------------------------------------------------------------------- configurações


def test_settings_requires_all_flags_and_store_name() -> None:
    ok = {"storeName": "Loja", "whatsapp": "(11) 98765-4321", "showOutOfStock": True, "showFeatured": False}
    assert SettingsIn.model_validate(ok).address == ""
    with pytest.raises(ValidationError):
        SettingsIn.model_validate(ok | {"storeName": "  "})
    with pytest.raises(ValidationError):
        SettingsIn.model_validate({"storeName": "Loja", "whatsapp": "11987654321"})
