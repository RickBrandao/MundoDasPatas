"""Regras de estoque, vendas e cancelamentos — espelham `src/domain/operations.ts`.

Funções puras: recebem o estado lido (produtos, venda) e devolvem o que deve ser gravado.
A gravação atômica fica a cargo da transação do repositório (ver `InventoryRepository`),
que garante que leitura, validação e escrita ocorram sobre o mesmo estado.
"""

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime

from app.core.errors import Conflict, InsufficientStock, ValidationFailed
from app.domain.models import MovementType, Product, Sale, SaleItem, SaleStatus, StockMovement


@dataclass(frozen=True, slots=True)
class InventoryChange:
    """Resultado de uma operação: produtos com o novo estoque e movimentações a registrar."""

    products: tuple[Product, ...]
    movements: tuple[StockMovement, ...]
    sale: Sale | None = None


def merge_items(items: Iterable[SaleItem]) -> tuple[SaleItem, ...]:
    """Soma linhas repetidas do mesmo produto, preservando a ordem da primeira ocorrência."""
    totals: dict[str, int] = {}
    for item in items:
        totals[item.product_id] = totals.get(item.product_id, 0) + item.qty
    return tuple(SaleItem(product_id=pid, qty=qty) for pid, qty in totals.items())


def initial_stock_movement(product: Product, *, movement_id: str, actor_uid: str) -> StockMovement | None:
    if product.stock <= 0:
        return None
    return StockMovement(
        id=movement_id,
        product_id=product.id,
        type=MovementType.CADASTRO,
        qty=product.stock,
        created_at=product.created_at,
        note="Estoque inicial",
        origin="Cadastro de produto",
        actor_uid=actor_uid,
    )


def plan_stock_move(
    product: Product,
    move_type: MovementType,
    qty: int,
    note: str,
    *,
    movement_id: str,
    actor_uid: str,
    now: datetime,
) -> InventoryChange:
    """Entrada: `qty` é a quantidade recebida (> 0). Ajuste: `qty` é o novo saldo (>= 0) e exige motivo."""
    note = note.strip()
    if move_type is MovementType.ENTRADA:
        if qty <= 0:
            raise ValidationFailed(
                "A entrada deve ser maior que zero.", field_errors={"qty": "A entrada deve ser maior que zero."}
            )
        delta = qty
        note = note or "Entrada de mercadoria"
    elif move_type is MovementType.AJUSTE:
        if qty < 0:
            raise ValidationFailed("O estoque não pode ficar negativo.", field_errors={"qty": "Informe 0 ou mais."})
        if qty == product.stock:
            raise ValidationFailed(
                "A nova quantidade é igual à atual.", field_errors={"qty": "A nova quantidade é igual à atual."}
            )
        if not note:
            raise ValidationFailed("Informe o motivo do ajuste.", field_errors={"note": "Informe o motivo do ajuste."})
        delta = qty - product.stock
    else:
        raise ValidationFailed("Tipo de movimentação não permitido.", field_errors={"type": "Use 'entrada' ou 'ajuste'."})

    if product.stock + delta < 0:
        raise InsufficientStock("O estoque não pode ficar negativo.")

    updated = replace(product, stock=product.stock + delta, updated_at=now)
    movement = StockMovement(
        id=movement_id,
        product_id=product.id,
        type=move_type,
        qty=delta,
        created_at=now,
        note=note,
        origin="Painel",
        actor_uid=actor_uid,
    )
    return InventoryChange(products=(updated,), movements=(movement,))


def plan_sale(
    products: Mapping[str, Product],
    items: Iterable[SaleItem],
    *,
    sale_id: str,
    actor_uid: str,
    now: datetime,
    new_id: Callable[[], str],
) -> InventoryChange:
    """Valida todos os itens contra o estoque lido e só então planeja as baixas (tudo ou nada)."""
    merged = merge_items(items)
    if not merged:
        raise ValidationFailed("Adicione pelo menos um produto.", field_errors={"items": "Adicione pelo menos um produto."})
    if any(i.qty <= 0 for i in merged):
        raise ValidationFailed("Quantidades devem ser inteiras e positivas.")

    for item in merged:
        product = products.get(item.product_id)
        if product is None:
            raise ValidationFailed(f"Produto inexistente: {item.product_id}.")
        if product.archived:
            raise Conflict(f"O produto “{product.name}” está arquivado e não pode ser vendido.")
        if item.qty > product.stock:
            raise InsufficientStock(f"Estoque insuficiente: {product.stock} un. disponíveis de “{product.name}”.")

    sale = Sale(id=sale_id, items=merged, status=SaleStatus.CONCLUIDA, created_at=now, created_by=actor_uid)
    updated = tuple(replace(products[i.product_id], stock=products[i.product_id].stock - i.qty, updated_at=now) for i in merged)
    movements = tuple(
        StockMovement(
            id=new_id(),
            product_id=i.product_id,
            type=MovementType.VENDA,
            qty=-i.qty,
            created_at=now,
            note="Venda registrada",
            origin=f"Venda {sale_id}",
            actor_uid=actor_uid,
        )
        for i in merged
    )
    return InventoryChange(products=updated, movements=movements, sale=sale)


def plan_cancellation(
    sale: Sale,
    products: Mapping[str, Product],
    *,
    actor_uid: str,
    now: datetime,
    new_id: Callable[[], str],
) -> InventoryChange:
    """Cancela uma venda concluída e devolve os itens ao estoque — exatamente uma vez."""
    if sale.status is not SaleStatus.CONCLUIDA:
        raise Conflict(f"A venda {sale.id} já foi cancelada; o estoque já foi estornado.")

    merged = merge_items(sale.items)
    missing = [i.product_id for i in merged if i.product_id not in products]
    if missing:
        # Produtos nunca são excluídos (só arquivados): isto indica dados inconsistentes.
        raise Conflict("Não foi possível estornar: produto da venda não encontrado.")

    cancelled = replace(sale, status=SaleStatus.CANCELADA, cancelled_at=now, cancelled_by=actor_uid)
    updated = tuple(replace(products[i.product_id], stock=products[i.product_id].stock + i.qty, updated_at=now) for i in merged)
    movements = tuple(
        StockMovement(
            id=new_id(),
            product_id=i.product_id,
            type=MovementType.ESTORNO,
            qty=i.qty,
            created_at=now,
            note="Cancelamento de venda",
            origin=f"Venda {sale.id}",
            actor_uid=actor_uid,
        )
        for i in merged
    )
    return InventoryChange(products=updated, movements=movements, sale=cancelled)
