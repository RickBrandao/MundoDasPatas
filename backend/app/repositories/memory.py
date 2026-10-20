"""Implementação em memória dos repositórios — para testes e desenvolvimento local.

NÃO é persistência de produção: os dados vivem no processo, somem ao reiniciar e não são
compartilhados entre instâncias serverless. A configuração impede seu uso em staging/produção.

As transações seguem a mesma semântica prevista para o Firestore: as escritas ficam em
buffer e só são aplicadas se a operação inteira terminar sem erro.
"""

import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime

from app.domain.models import Category, IdempotencyRecord, Product, Sale, StockMovement, StoreSettings
from app.repositories.base import Repositories


@dataclass
class MemoryState:
    categories: dict[str, Category] = field(default_factory=dict)
    products: dict[str, Product] = field(default_factory=dict)
    sales: dict[str, Sale] = field(default_factory=dict)
    movements: list[StockMovement] = field(default_factory=list)
    settings: StoreSettings | None = None
    idempotency: dict[tuple[str, str, str], IdempotencyRecord] = field(default_factory=dict)
    lock: threading.RLock = field(default_factory=threading.RLock)


def _newest_first[T](items: Iterable[T], key: Callable[[T], object], limit: int) -> list[T]:
    return sorted(items, key=key, reverse=True)[:limit]  # type: ignore[arg-type]


class MemoryCategoryRepository:
    def __init__(self, state: MemoryState) -> None:
        self._s = state

    def list(self) -> list[Category]:
        with self._s.lock:
            return list(self._s.categories.values())

    def get(self, category_id: str) -> Category | None:
        return self._s.categories.get(category_id)

    def save(self, category: Category) -> None:
        with self._s.lock:
            self._s.categories[category.id] = category


class MemoryProductRepository:
    def __init__(self, state: MemoryState) -> None:
        self._s = state

    def list(self) -> list[Product]:
        with self._s.lock:
            return list(self._s.products.values())

    def get(self, product_id: str) -> Product | None:
        return self._s.products.get(product_id)


class MemorySaleRepository:
    def __init__(self, state: MemoryState) -> None:
        self._s = state

    def list(self, limit: int, since: datetime | None = None) -> list[Sale]:
        with self._s.lock:
            items = [s for s in self._s.sales.values() if since is None or s.created_at >= since]
            return _newest_first(items, lambda s: s.created_at, limit)

    def get(self, sale_id: str) -> Sale | None:
        return self._s.sales.get(sale_id)


class MemoryStockMovementRepository:
    def __init__(self, state: MemoryState) -> None:
        self._s = state

    def list(self, limit: int, product_id: str | None = None) -> list[StockMovement]:
        with self._s.lock:
            items = [m for m in self._s.movements if product_id is None or m.product_id == product_id]
            return _newest_first(items, lambda m: m.created_at, limit)

    def get(self, movement_id: str) -> StockMovement | None:
        with self._s.lock:
            return next((m for m in self._s.movements if m.id == movement_id), None)


class MemorySettingsRepository:
    def __init__(self, state: MemoryState) -> None:
        self._s = state

    def get(self) -> StoreSettings | None:
        return self._s.settings

    def save(self, settings: StoreSettings) -> None:
        with self._s.lock:
            self._s.settings = settings


class _MemoryTransaction:
    def __init__(self, state: MemoryState) -> None:
        self._s = state
        self.products: dict[str, Product] = {}
        self.sales: dict[str, Sale] = {}
        self.movements: list[StockMovement] = []
        self.idempotency: list[IdempotencyRecord] = []

    def get_products(self, product_ids: Iterable[str]) -> dict[str, Product]:
        return {pid: self._s.products[pid] for pid in product_ids if pid in self._s.products}

    def get_sale(self, sale_id: str) -> Sale | None:
        return self._s.sales.get(sale_id)

    def get_idempotency(self, operation: str, actor_uid: str, key: str) -> IdempotencyRecord | None:
        return self._s.idempotency.get((operation, actor_uid, key))

    def put_product(self, product: Product) -> None:
        self.products[product.id] = product

    def put_sale(self, sale: Sale) -> None:
        self.sales[sale.id] = sale

    def add_movements(self, movements: Iterable[StockMovement]) -> None:
        self.movements.extend(movements)

    def put_idempotency(self, record: IdempotencyRecord) -> None:
        self.idempotency.append(record)

    def commit(self) -> None:
        self._s.products.update(self.products)
        self._s.sales.update(self.sales)
        self._s.movements.extend(self.movements)
        for r in self.idempotency:
            self._s.idempotency[(r.operation, r.actor_uid, r.key)] = r


class MemoryInventoryRepository:
    def __init__(self, state: MemoryState) -> None:
        self._s = state

    def run_in_transaction[T](self, operation: Callable[[_MemoryTransaction], T]) -> T:
        # O lock serializa transações: equivale ao isolamento que o Firestore garante por documento.
        with self._s.lock:
            tx = _MemoryTransaction(self._s)
            result = operation(tx)
            tx.commit()
            return result


def create_memory_repositories(state: MemoryState | None = None) -> Repositories:
    state = state or MemoryState()
    return Repositories(
        categories=MemoryCategoryRepository(state),
        products=MemoryProductRepository(state),
        sales=MemorySaleRepository(state),
        movements=MemoryStockMovementRepository(state),
        settings=MemorySettingsRepository(state),
        inventory=MemoryInventoryRepository(state),
    )
