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
    # URL pública da foto (download do Cloud Storage com token) ou vazio = ilustração padrão.
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
    # Objeto no Storage que pertence a este produto (`products/{id}/images/{imageId}.webp`), ou vazio.
    # Interno: nunca sai na API. Só um objeto registrado aqui pode ser excluído como "foto anterior".
    image_path: str = ""


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
    """Operação sensível já aplicada e a resposta original, para responder a repetições sem reaplicar.

    `response` é o snapshot imutável (texto JSON) da resposta original. O domínio não interpreta
    o conteúdo: o formato pertence ao contrato HTTP e é identificado por `response_version`.
    Depois de `expires_at` o registro deixa de valer (e pode ser removido pelo TTL do Firestore).
    """

    key: str
    operation: str
    actor_uid: str
    request_hash: str
    # ID do recurso criado ou alterado pela operação (venda ou movimentação).
    result_id: str
    response: str
    response_version: int
    created_at: datetime
    expires_at: datetime
