"""Contratos de persistência. Serviços dependem destes Protocols, nunca do Firestore.

Coleções previstas no Firestore (ver README): products, categories, sales,
stock_movements, settings (documento único `store`) e idempotency_keys.

Toda escrita que altera estoque passa por `InventoryRepository.run_in_transaction`, porque
precisa ler e gravar produtos, vendas e movimentações atomicamente. Isso mapeia diretamente
para `@firestore.transactional`: todas as leituras antes das escritas e repetição automática
da função quando outro processo altera os mesmos documentos (por isso ela não pode ter
efeitos colaterais fora da transação).
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from app.domain.models import Category, IdempotencyRecord, Product, Sale, StockMovement, StoreSettings


class CategoryRepository(Protocol):
    def list(self) -> list[Category]: ...
    def get(self, category_id: str) -> Category | None: ...
    def save(self, category: Category) -> None: ...


class ProductRepository(Protocol):
    """Somente leitura: cadastro e edição gravam via transação de inventário (não sobrescrevem estoque)."""

    def list(self) -> list[Product]: ...
    def get(self, product_id: str) -> Product | None: ...


class SaleRepository(Protocol):
    # Mais recentes primeiro; `since` filtra por data de criação (índice em created_at no Firestore).
    def list(self, limit: int, since: datetime | None = None) -> list[Sale]: ...
    def get(self, sale_id: str) -> Sale | None: ...


class StockMovementRepository(Protocol):
    # Mais recentes primeiro. Movimentações são imutáveis: não há atualização nem exclusão.
    def list(self, limit: int, product_id: str | None = None) -> list[StockMovement]: ...
    def get(self, movement_id: str) -> StockMovement | None: ...


class SettingsRepository(Protocol):
    def get(self) -> StoreSettings | None: ...
    def save(self, settings: StoreSettings) -> None: ...


class InventoryTransaction(Protocol):
    # Leituras (devem acontecer antes de qualquer escrita).
    def get_products(self, product_ids: Iterable[str]) -> dict[str, Product]: ...
    def get_sale(self, sale_id: str) -> Sale | None: ...
    def get_idempotency(self, operation: str, actor_uid: str, key: str) -> IdempotencyRecord | None: ...

    # Escritas (aplicadas somente se a função terminar sem exceção).
    def put_product(self, product: Product) -> None: ...
    def put_sale(self, sale: Sale) -> None: ...
    def add_movements(self, movements: Iterable[StockMovement]) -> None: ...
    def put_idempotency(self, record: IdempotencyRecord) -> None: ...


class InventoryRepository(Protocol):
    def run_in_transaction[T](self, operation: Callable[[InventoryTransaction], T]) -> T: ...


@dataclass(frozen=True, slots=True)
class Repositories:
    categories: CategoryRepository
    products: ProductRepository
    sales: SaleRepository
    movements: StockMovementRepository
    settings: SettingsRepository
    inventory: InventoryRepository
