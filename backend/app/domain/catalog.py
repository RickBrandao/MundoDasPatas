"""Regras do catálogo público — espelham `src/domain/catalog.ts` e `money.ts`."""

import unicodedata
from collections.abc import Iterable

from app.domain.models import Category, Product, StockStatus, StoreSettings


def normalize_text(value: str) -> str:
    """Remove acentos e caixa ("Ração" == "racao")."""
    decomposed = unicodedata.normalize("NFD", value)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).lower()


def stock_status(product: Product) -> StockStatus:
    if product.stock <= 0:
        return StockStatus.OUT
    return StockStatus.LOW if product.stock <= product.min_stock else StockStatus.OK


def has_public_price(product: Product) -> bool:
    return product.show_price and product.price_cents is not None and product.price_cents > 0


def active_category_ids(categories: Iterable[Category]) -> set[str]:
    return {c.id for c in categories if c.active}


def is_product_visible(product: Product, active_categories: set[str], settings: StoreSettings) -> bool:
    """Publicado, não arquivado, categoria ativa e — se a loja oculta esgotados — com estoque."""
    return (
        product.published
        and not product.archived
        and product.category_id in active_categories
        and (settings.show_out_of_stock or product.stock > 0)
    )


def visible_products(products: Iterable[Product], categories: Iterable[Category], settings: StoreSettings) -> list[Product]:
    active = active_category_ids(categories)
    visible = [p for p in products if is_product_visible(p, active, settings)]
    return sorted(visible, key=lambda p: (not p.featured, normalize_text(p.name)))
