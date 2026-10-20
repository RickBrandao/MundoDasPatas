"""Estoque e vendas. O backend é a autoridade sobre o estoque.

Operações sensíveis (venda, movimentação e cancelamento) exigem chave de idempotência: a mesma
chave, do mesmo usuário, com o mesmo corpo, devolve a resposta original sem reaplicar a
operação (ex.: o funcionário clicou duas vezes ou a resposta se perdeu na rede). A mesma chave
com outro corpo é recusada (409).

O registro da chave guarda um snapshot da resposta original (o DTO HTTP serializado, versão
`SNAPSHOT_VERSION`) e é gravado na mesma transação da operação. A repetição devolve esse
snapshot, nunca o estado atual do recurso. A garantia vale por `IDEMPOTENCY_TTL` (ver README).
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from app.core.errors import Conflict, NotFound
from app.domain.inventory import plan_cancellation, plan_sale, plan_stock_move
from app.domain.models import IdempotencyRecord, MovementType, Sale, SaleItem, StockMovement
from app.repositories.base import InventoryTransaction, Repositories
from app.schemas.catalog import ProductAdminOut
from app.schemas.common import ApiModel
from app.schemas.inventory import SaleCreate, SaleOut, StockMovementCreate, StockMovementOut, StockMovementResult
from app.services.common import Clock, IdFactory, new_id, request_hash, utc_now

OP_SALE = "sale.create"
OP_SALE_CANCEL = "sale.cancel"
OP_STOCK_MOVE = "stock.move"

# Janela em que a chave protege contra repetição. Depois dela a chave é tratada como nova.
IDEMPOTENCY_TTL = timedelta(hours=24)
# Versão do formato dos snapshots (DTOs de resposta). Incrementar a cada mudança incompatível.
SNAPSHOT_VERSION = 1


class IdempotencyKeyReused(Conflict):
    code = "idempotency_key_reused"
    message = "Esta chave de idempotência já foi usada com outros dados."


class IdempotencyReplayUnavailable(Conflict):
    code = "idempotency_replay_unavailable"
    message = "Esta operação já foi aplicada, mas a resposta original não pode ser reproduzida. Consulte o recurso."


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

    def move_stock(self, data: StockMovementCreate, actor_uid: str, key: str) -> Outcome[StockMovementResult]:
        fingerprint = request_hash(data.model_dump(mode="json"))
        now = self._clock()
        movement_id = self._ids()

        def run(tx: InventoryTransaction) -> Outcome[StockMovementResult]:
            previous = _find_replay(tx, OP_STOCK_MOVE, actor_uid, key, fingerprint, now)
            if previous:
                return Outcome(StockMovementResult.model_validate_json(previous.response), replayed=True)
            product = tx.get_products([data.product_id]).get(data.product_id)
            if product is None:
                raise NotFound("Produto não encontrado.")
            change = plan_stock_move(
                product, MovementType(data.type), data.qty, data.note, movement_id=movement_id, actor_uid=actor_uid, now=now
            )
            result = StockMovementResult(
                movement=StockMovementOut.model_validate(change.movements[0]),
                product=ProductAdminOut.from_domain(change.products[0]),
            )
            _write(tx, change.products, change.movements)
            tx.put_idempotency(_record(key, OP_STOCK_MOVE, actor_uid, fingerprint, movement_id, result, now))
            return Outcome(result, replayed=False)

        return self._repos.inventory.run_in_transaction(run)

    # ------------------------------------------------------------------ vendas

    def register_sale(self, data: SaleCreate, actor_uid: str, key: str) -> Outcome[SaleOut]:
        fingerprint = request_hash(data.model_dump(mode="json"))
        items = [SaleItem(product_id=i.product_id, qty=i.qty) for i in data.items]
        now = self._clock()
        sale_id = self._ids()

        def run(tx: InventoryTransaction) -> Outcome[SaleOut]:
            previous = _find_replay(tx, OP_SALE, actor_uid, key, fingerprint, now)
            if previous:
                return Outcome(SaleOut.model_validate_json(previous.response), replayed=True)
            # Lê todos os produtos envolvidos na mesma transação em que o estoque será baixado:
            # duas vendas simultâneas do mesmo produto não conseguem vender a mesma unidade.
            products = tx.get_products({i.product_id for i in items})
            change = plan_sale(products, items, sale_id=sale_id, actor_uid=actor_uid, now=now, new_id=self._ids)
            assert change.sale is not None
            result = SaleOut.model_validate(change.sale)
            tx.put_sale(change.sale)
            _write(tx, change.products, change.movements)
            tx.put_idempotency(_record(key, OP_SALE, actor_uid, fingerprint, sale_id, result, now))
            return Outcome(result, replayed=False)

        return self._repos.inventory.run_in_transaction(run)

    def cancel_sale(self, sale_id: str, actor_uid: str, key: str) -> Outcome[SaleOut]:
        """A mesma chave devolve o cancelamento original; uma chave nova numa venda já cancelada é 409."""
        # A venda faz parte do corpo lógico: a mesma chave não pode cancelar outra venda.
        fingerprint = request_hash({"saleId": sale_id})
        now = self._clock()

        def run(tx: InventoryTransaction) -> Outcome[SaleOut]:
            previous = _find_replay(tx, OP_SALE_CANCEL, actor_uid, key, fingerprint, now)
            if previous:
                return Outcome(SaleOut.model_validate_json(previous.response), replayed=True)
            sale = tx.get_sale(sale_id)
            if sale is None:
                raise NotFound("Venda não encontrada.")
            products = tx.get_products({i.product_id for i in sale.items})
            # O status é verificado na transação: o estorno acontece no máximo uma vez.
            change = plan_cancellation(sale, products, actor_uid=actor_uid, now=now, new_id=self._ids)
            assert change.sale is not None
            result = SaleOut.model_validate(change.sale)
            tx.put_sale(change.sale)
            _write(tx, change.products, change.movements)
            tx.put_idempotency(_record(key, OP_SALE_CANCEL, actor_uid, fingerprint, sale_id, result, now))
            return Outcome(result, replayed=False)

        return self._repos.inventory.run_in_transaction(run)

    # ------------------------------------------------------------------ dashboard

    def sales_since(self, days: int) -> list[Sale]:
        return self._repos.sales.list(limit=10_000, since=self._clock() - timedelta(days=days))


def _find_replay(
    tx: InventoryTransaction, operation: str, actor_uid: str, key: str, fingerprint: str, now: datetime
) -> IdempotencyRecord | None:
    """Registro válido da mesma operação ou None. Registro expirado é ignorado (a chave volta a ser nova)."""
    record = tx.get_idempotency(operation, actor_uid, key)
    if record is None or record.expires_at <= now:
        return None
    if record.request_hash != fingerprint:
        raise IdempotencyKeyReused()
    if record.response_version != SNAPSHOT_VERSION:
        raise IdempotencyReplayUnavailable()
    return record


def _record(
    key: str, operation: str, actor_uid: str, fingerprint: str, result_id: str, response: ApiModel, now: datetime
) -> IdempotencyRecord:
    return IdempotencyRecord(
        key=key,
        operation=operation,
        actor_uid=actor_uid,
        request_hash=fingerprint,
        result_id=result_id,
        response=response.model_dump_json(),
        response_version=SNAPSHOT_VERSION,
        created_at=now,
        expires_at=now + IDEMPOTENCY_TTL,
    )


def _write(tx: InventoryTransaction, products: Any, movements: Any) -> None:
    for product in products:
        tx.put_product(product)
    tx.add_movements(movements)
