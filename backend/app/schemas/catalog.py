"""DTOs de produtos e categorias (administrativos) e do catálogo público."""

from dataclasses import fields
from typing import Annotated, ClassVar

from pydantic import AfterValidator, Field

from app.domain.catalog import has_public_price, stock_status
from app.domain.models import Product, StockStatus
from app.schemas.common import (
    ApiModel,
    Id,
    InputModel,
    PatchModel,
    PriceCents,
    StrictNonNegInt,
    UtcDatetime,
    text,
)


def _image_url(value: str) -> str:
    # Imagens ficarão no Cloud Storage; data URLs (usadas na demo) não são aceitas.
    if value and not value.startswith("https://"):
        raise ValueError("Use uma URL https:// ou deixe vazio.")
    return value


ImageUrl = Annotated[text(2048), AfterValidator(_image_url)]
ProductName = text(120, 3)
Icon = Annotated[str, Field(pattern=r"^[a-z0-9_]{1,40}$")]

# --------------------------------------------------------------------- categorias


class CategoryOut(ApiModel):
    id: str
    name: str
    icon: str
    active: bool


class CategoryCreate(InputModel):
    name: text(60, 2)
    icon: Icon = "label"


class CategoryUpdate(PatchModel):
    name: text(60, 2) | None = None
    icon: Icon | None = None
    active: bool | None = None


# --------------------------------------------------------------------- produtos


class ProductAdminOut(ApiModel):
    id: str
    name: str
    description: str
    category_id: str
    brand: str
    image_url: str
    price_cents: int | None
    show_price: bool
    stock: int
    min_stock: int
    stock_status: StockStatus
    published: bool
    featured: bool
    archived: bool
    created_at: UtcDatetime
    updated_at: UtcDatetime

    @classmethod
    def from_domain(cls, p: Product) -> "ProductAdminOut":
        return cls.model_validate({**_fields(p), "stock_status": stock_status(p)})


class ProductCreate(InputModel):
    name: ProductName
    description: text(2000) = ""
    category_id: Id
    brand: text(80) = ""
    image_url: ImageUrl = ""
    price_cents: PriceCents | None = None
    show_price: bool = False
    # Estoque inicial: depois do cadastro, o estoque muda apenas por movimentações.
    stock: StrictNonNegInt = 0
    min_stock: StrictNonNegInt = 0
    published: bool = False
    featured: bool = False


class ProductUpdate(PatchModel):
    """Edição e publicação/ocultação/arquivamento. Não aceita `stock` (use movimentações)."""

    nullable_fields: ClassVar[frozenset[str]] = frozenset({"priceCents"})

    name: ProductName | None = None
    description: text(2000) | None = None
    category_id: Id | None = None
    brand: text(80) | None = None
    image_url: ImageUrl | None = None
    price_cents: PriceCents | None = None
    show_price: bool | None = None
    min_stock: StrictNonNegInt | None = None
    published: bool | None = None
    featured: bool | None = None
    archived: bool | None = None


# --------------------------------------------------------------------- catálogo público


class PublicCategory(ApiModel):
    id: str
    name: str
    icon: str


class PublicProduct(ApiModel):
    """Somente o necessário para o catálogo e a encomenda.

    Não inclui: estoque mínimo, flags de publicação/arquivamento, datas, preço oculto.
    `stock` é exposto porque a encomenda limita a quantidade ao disponível (como na demo).
    """

    id: str
    name: str
    description: str
    category_id: str
    brand: str
    image_url: str
    # null quando a loja optou por não exibir o preço.
    price_cents: int | None
    featured: bool
    stock: int
    stock_status: StockStatus

    @classmethod
    def from_domain(cls, p: Product) -> "PublicProduct":
        return cls(
            id=p.id,
            name=p.name,
            description=p.description,
            category_id=p.category_id,
            brand=p.brand,
            image_url=p.image_url,
            price_cents=p.price_cents if has_public_price(p) else None,
            featured=p.featured,
            stock=max(p.stock, 0),
            stock_status=stock_status(p),
        )


def _fields(p: Product) -> dict[str, object]:
    return {f.name: getattr(p, f.name) for f in fields(p)}
