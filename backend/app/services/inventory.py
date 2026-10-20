"""Estoque e vendas. O backend é a autoridade sobre o estoque.

Operações sensíveis (venda e movimentação) exigem chave de idempotência: a mesma chave,
do mesmo usuário, com o mesmo corpo, devolve o resultado original sem reaplicar a operação
(ex.: o funcionário clicou duas vezes ou a resposta se perdeu na rede). A mesma chave com
outro corpo é recusada (409). O registro da chave é gravado na mesma transação da operação.
"""

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from app.core.errors import Conflict, NotFound
from app.domain.inventory import plan_cancellation, plan_sale, plan_stock_move
from app.domain.models import IdempotencyRecord, MovementType, Product, Sale, SaleItem, StockMovement
from app.repositories.base import InventoryTransaction, Repositories
from app.schemas.inventory import SaleCreate, StockMovementCreate
from app.services.common import Clock, IdFactory, new_id, request_hash, utc_now

OP_SALE = "sale.create"
OP_STOCK_MOVE = "stock.move"


class IdempotencyKeyReused(Conflict):
    code = "idempotency_key_reused"
    message = "Esta chave de idempotência já foi usada com outros dados."


@dataclass(frozen=True, slots=True)
class Outcome[T]:
    value: T
    # True quando a resposta é a repetição de uma operação já aplicada.
    replayed: bool


class InventoryService:
    def __init__(self, repos: Repositories, clock: Clock = utc_now, ids: IdFactory = new_id) -> None:
        self._repos = repos
        self._clock = clock
        self._ids = ids

    # ------------------------------------------------------------------ consultas

    def list_movements(self, limit: int, product_id: str | None = None) -> list[StockMovement]:
        return self._repos.movements.list(limit, product_id)

    def list_sales(self, limit: int) -> list[Sale]:
        return self._repos.sales.list(limit)

    # ------------------------------------------------------------------ movimentações

    def move_stock(self, data: StockMovementCreate, actor_uid: str, key: str) -> Outcome[tuple[StockMovement, Product]]:
        fingerprint = request_hash(data.model_dump(mode="json"))
        now = self._clock()
        movement_id = self._ids()

        def run(tx: InventoryTransaction) -> str | None:
            previous = _check_idempotency(tx, OP_STOCK_MOVE, actor_uid, key, fingerprint)
            if previous:
                return previous
            product = tx.get_products([data.product_id]).get(data.product_id)
            if product is None:
                raise NotFound("Produto não encontrado.")
            change = plan_stock_move(
                product, MovementType(data.type), data.qty, data.note, movement_id=movement_id, actor_uid=actor_uid, now=now
            )
            _write(tx, change.products, change.movements)
            tx.put_idempotency(IdempotencyRecord(key, OP_STOCK_MOVE, actor_uid, fingerprint, movement_id, now))
            return None

        replayed_id = self._repos.inventory.run_in_transaction(run)
        result_id = replayed_id or movement_id
        movement = self._repos.movements.get(result_id)
        product = self._repos.products.get(data.product_id)
        if movement is None or product is None:
            raise NotFound("Movimentação não encontrada.")
        return Outcome((movement, product), replayed=replayed_id is not None)

    # ------------------------------------------------------------------ vendas

    def register_sale(self, data: SaleCreate, actor_uid: str, key: str) -> Outcome[Sale]:
        fingerprint = request_hash(data.model_dump(mode="json"))
        items = [SaleItem(product_id=i.product_id, qty=i.qty) for i in data.items]
        now = self._clock()
        sale_id = self._ids()

        def run(tx: InventoryTransaction) -> Outcome[Sale]:
            previous = _check_idempotency(tx, OP_SALE, actor_uid, key, fingerprint)
            if previous:
                sale = tx.get_sale(previous)
                if sale is None:
                    raise NotFound("Venda não encontrada.")
                return Outcome(sale, replayed=True)
            # Lê todos os produtos envolvidos na mesma transação em que o estoque será baixado:
            # duas vendas simultâneas do mesmo produto não conseguem vender a mesma unidade.
            products = tx.get_products({i.product_id for i in items})
            change = plan_sale(products, items, sale_id=sale_id, actor_uid=actor_uid, now=now, new_id=self._ids)
            assert change.sale is not None
            tx.put_sale(change.sale)
            _write(tx, change.products, change.movements)
            tx.put_idempotency(IdempotencyRecord(key, OP_SALE, actor_uid, fingerprint, sale_id, now))
            return Outcome(change.sale, replayed=False)

        return self._repos.inventory.run_in_transaction(run)

    def cancel_sale(self, sale_id: str, actor_uid: str) -> Sale:
        """Naturalmente idempotente: o status é verificado na transação, então o estorno ocorre uma vez."""
        now = self._clock()

        def run(tx: InventoryTransaction) -> Sale:
            sale = tx.get_sale(sale_id)
            if sale is None:
                raise NotFound("Venda não encontrada.")
            products = tx.get_products({i.product_id for i in sale.items})
            change = plan_cancellation(sale, products, actor_uid=actor_uid, now=now, new_id=self._ids)
            assert change.sale is not None
            tx.put_sale(change.sale)
            _write(tx, change.products, change.movements)
            return change.sale

        return self._repos.inventory.run_in_transaction(run)

    # ------------------------------------------------------------------ dashboard

    def sales_since(self, days: int) -> list[Sale]:
        return self._repos.sales.list(limit=10_000, since=self._clock() - timedelta(days=days))


def _check_idempotency(tx: InventoryTransaction, operation: str, actor_uid: str, key: str, fingerprint: str) -> str | None:
    record = tx.get_idempotency(operation, actor_uid, key)
    if record is None:
        return None
    if record.request_hash != fingerprint:
        raise IdempotencyKeyReused()
    return record.result_id


def _write(tx: InventoryTransaction, products: Any, movements: Any) -> None:
    for product in products:
        tx.put_product(product)
    tx.add_movements(movements)
