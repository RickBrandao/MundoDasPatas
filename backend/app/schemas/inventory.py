"""DTOs de movimentações de estoque e vendas (somente área administrativa)."""

from typing import Annotated, Literal

from pydantic import Field

from app.domain.models import MovementType, SaleStatus
from app.schemas.catalog import ProductAdminOut
from app.schemas.common import ApiModel, Id, InputModel, StrictNonNegInt, StrictPositiveQty, UtcDatetime, text


class StockMovementOut(ApiModel):
    id: str
    product_id: str
    type: MovementType
    qty: int
    created_at: UtcDatetime
    note: str
    origin: str
    actor_uid: str | None


class StockMovementCreate(InputModel):
    """`entrada`: `qty` = quantidade recebida (> 0). `ajuste`: `qty` = novo saldo contado (>= 0), com motivo.

    Vendas e estornos não são aceitos aqui: são gerados pelas operações de venda.
    """

    product_id: Id
    type: Literal[MovementType.ENTRADA, MovementType.AJUSTE]
    qty: StrictNonNegInt
    note: text(200) = ""


class StockMovementResult(ApiModel):
    movement: StockMovementOut
    product: ProductAdminOut


class SaleItemIn(InputModel):
    product_id: Id
    qty: StrictPositiveQty


class SaleCreate(InputModel):
    items: Annotated[list[SaleItemIn], Field(min_length=1, max_length=100)]


class SaleItemOut(ApiModel):
    product_id: str
    qty: int


class SaleOut(ApiModel):
    id: str
    items: list[SaleItemOut]
    status: SaleStatus
    created_at: UtcDatetime
    created_by: str
    cancelled_at: UtcDatetime | None
    cancelled_by: str | None
