from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from app.api.dependencies import AdminDep, IdempotencyKey, get_inventory_service
from app.schemas.catalog import ProductAdminOut
from app.schemas.inventory import SaleCreate, SaleOut, StockMovementCreate, StockMovementOut, StockMovementResult
from app.services.inventory import InventoryService

router = APIRouter()

InventoryDep = Annotated[InventoryService, Depends(get_inventory_service)]
Limit = Annotated[int, Query(ge=1, le=500)]
REPLAYED_HEADER = "Idempotent-Replayed"


@router.get("/stock/movements", tags=["Admin · Estoque"], summary="Histórico de movimentações (mais recentes primeiro)")
def list_movements(
    inventory: InventoryDep, limit: Limit = 100, product_id: Annotated[str | None, Query(alias="productId")] = None
) -> list[StockMovementOut]:
    return [StockMovementOut.model_validate(m) for m in inventory.list_movements(limit, product_id)]


@router.post(
    "/stock/movements",
    tags=["Admin · Estoque"],
    status_code=status.HTTP_201_CREATED,
    summary="Registrar entrada ou ajuste de estoque",
)
def create_movement(
    data: StockMovementCreate, admin: AdminDep, key: IdempotencyKey, inventory: InventoryDep, response: Response
) -> StockMovementResult:
    outcome = inventory.move_stock(data, admin.uid, key)
    movement, product = outcome.value
    response.headers[REPLAYED_HEADER] = str(outcome.replayed).lower()
    return StockMovementResult(movement=StockMovementOut.model_validate(movement), product=ProductAdminOut.from_domain(product))


@router.get("/sales", tags=["Admin · Vendas"], summary="Vendas (mais recentes primeiro)")
def list_sales(inventory: InventoryDep, limit: Limit = 100) -> list[SaleOut]:
    return [SaleOut.model_validate(s) for s in inventory.list_sales(limit)]


@router.post("/sales", tags=["Admin · Vendas"], status_code=status.HTTP_201_CREATED, summary="Registrar venda concluída")
def create_sale(data: SaleCreate, admin: AdminDep, key: IdempotencyKey, inventory: InventoryDep, response: Response) -> SaleOut:
    outcome = inventory.register_sale(data, admin.uid, key)
    response.headers[REPLAYED_HEADER] = str(outcome.replayed).lower()
    return SaleOut.model_validate(outcome.value)


@router.post("/sales/{sale_id}/cancel", tags=["Admin · Vendas"], summary="Cancelar venda e devolver itens ao estoque")
def cancel_sale(sale_id: str, admin: AdminDep, inventory: InventoryDep) -> SaleOut:
    return SaleOut.model_validate(inventory.cancel_sale(sale_id, admin.uid))
