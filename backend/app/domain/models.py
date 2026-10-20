"""Entidades internas (independentes de HTTP e do Firestore).

Espelham `src/domain/types.ts`, com convenção Python (snake_case) e datas `datetime` em UTC.
Diferenças em relação à demo: `date` → `created_at`; vendas e movimentações registram o
usuário responsável; não existem sequências (`seq`), os IDs são gerados aleatoriamente.
"""

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class StockStatus(StrEnum):
    OK = "ok"
    LOW = "low"
    OUT = "out"


class MovementType(StrEnum):
    ENTRADA = "entrada"
    AJUSTE = "ajuste"
    VENDA = "venda"
    ESTORNO = "estorno"
    CADASTRO = "cadastro"


class SaleStatus(StrEnum):
    CONCLUIDA = "concluida"
    CANCELADA = "cancelada"


@dataclass(frozen=True, slots=True)
class Category:
    id: str
    name: str
    # Nome do ícone Material Symbols.
    icon: str
    active: bool


@dataclass(frozen=True, slots=True)
class Product:
    id: str
    name: str
    description: str
    category_id: str
    brand: str
    # URL pública da imagem (futuramente no Cloud Storage). Vazio = ilustração padrão.
    image_url: str
    price_cents: int | None
    show_price: bool
    stock: int
    min_stock: int
    published: bool
    featured: bool
    archived: bool
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class StockMovement:
    id: str
    product_id: str
    type: MovementType
    # Variação de estoque: positiva (entrada) ou negativa (saída).
    qty: int
    created_at: datetime
    note: str
    origin: str
    actor_uid: str | None


@dataclass(frozen=True, slots=True)
class SaleItem:
    product_id: str
    qty: int


@dataclass(frozen=True, slots=True)
class Sale:
    id: str
    items: tuple[SaleItem, ...]
    status: SaleStatus
    created_at: datetime
    created_by: str
    cancelled_at: datetime | None = None
    cancelled_by: str | None = None


@dataclass(frozen=True, slots=True)
class StoreSettings:
    store_name: str
    whatsapp: str
    address: str
    hours: str
    about: str
    show_out_of_stock: bool
    show_featured: bool


# Usadas enquanto a loja não salvar as próprias configurações. Sem WhatsApp: o número
# oficial precisa ser cadastrado pelo proprietário (nunca um número fictício em produção).
DEFAULT_SETTINGS = StoreSettings(
    store_name="Mundo das Patas",
    whatsapp="",
    address="",
    hours="",
    about="",
    show_out_of_stock=True,
    show_featured=True,
)


@dataclass(frozen=True, slots=True)
class IdempotencyRecord:
    """Resultado de uma operação sensível já aplicada, para responder a repetições sem reaplicar."""

    key: str
    operation: str
    actor_uid: str
    request_hash: str
    result_id: str
    created_at: datetime
