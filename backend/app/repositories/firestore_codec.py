"""Conversão entre as entidades do domínio e os documentos do Firestore.

Convenção dos documentos (independente do contrato HTTP, que usa camelCase):
- campos em snake_case, com os mesmos nomes das entidades; o ID fica só no ID do documento;
- datas como Timestamp nativo do Firestore, sempre em UTC (datas sem fuso são recusadas);
- dinheiro em centavos (inteiro) e quantidades inteiras; enumerações pelo valor (`"concluida"`);
- campos desconhecidos são ignorados na leitura (permite acrescentar campos sem migração).

Funções puras: não acessam o banco.
"""

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from app.domain.models import (
    Category,
    IdempotencyRecord,
    MovementType,
    Product,
    Sale,
    SaleItem,
    SaleStatus,
    StockMovement,
    StoreSettings,
)

Doc = dict[str, Any]


# ----------------------------------------------------------------- IDs determinísticos


def idempotency_doc_id(operation: str, actor_uid: str, key: str) -> str:
    # JSON evita ambiguidade entre separadores e o conteúdo dos campos.
    return hashlib.sha256(json.dumps([operation, actor_uid, key]).encode()).hexdigest()


def category_claim_id(normalized_name: str) -> str:
    # O hash evita caracteres inválidos ("/") e limites de tamanho em IDs de documento.
    return hashlib.sha256(normalized_name.encode()).hexdigest()


# ----------------------------------------------------------------- datas


def to_timestamp(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("datas persistidas precisam de fuso horário (UTC)")
    return value.astimezone(UTC)


def from_timestamp(value: Any) -> datetime:
    # O SDK devolve DatetimeWithNanoseconds (subclasse de datetime, em UTC); normaliza para datetime simples.
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise TypeError("campo de data inválido no documento")
    v = value.astimezone(UTC)
    return datetime(v.year, v.month, v.day, v.hour, v.minute, v.second, v.microsecond, tzinfo=UTC)


def _optional_timestamp(value: Any) -> datetime | None:
    return None if value is None else from_timestamp(value)


# ----------------------------------------------------------------- entidades


def category_to_doc(c: Category) -> Doc:
    return {"name": c.name, "icon": c.icon, "active": c.active}


def category_from_doc(doc_id: str, d: Doc) -> Category:
    return Category(id=doc_id, name=d["name"], icon=d["icon"], active=d["active"])


def product_to_doc(p: Product) -> Doc:
    return {
        "name": p.name,
        "description": p.description,
        "category_id": p.category_id,
        "brand": p.brand,
        "image_url": p.image_url,
        "image_path": p.image_path,
        "price_cents": p.price_cents,
        "show_price": p.show_price,
        "stock": p.stock,
        "min_stock": p.min_stock,
        "published": p.published,
        "featured": p.featured,
        "archived": p.archived,
        "created_at": to_timestamp(p.created_at),
        "updated_at": to_timestamp(p.updated_at),
    }


def product_from_doc(doc_id: str, d: Doc) -> Product:
    return Product(
        id=doc_id,
        name=d["name"],
        description=d["description"],
        category_id=d["category_id"],
        brand=d["brand"],
        image_url=d["image_url"],
        price_cents=d["price_cents"],
        show_price=d["show_price"],
        stock=d["stock"],
        min_stock=d["min_stock"],
        published=d["published"],
        featured=d["featured"],
        archived=d["archived"],
        created_at=from_timestamp(d["created_at"]),
        updated_at=from_timestamp(d["updated_at"]),
        # Ausente em produtos gravados antes da TASK 07A.
        image_path=d.get("image_path", ""),
    )


def movement_to_doc(m: StockMovement) -> Doc:
    return {
        "product_id": m.product_id,
        "type": m.type.value,
        "qty": m.qty,
        "created_at": to_timestamp(m.created_at),
        "note": m.note,
        "origin": m.origin,
        "actor_uid": m.actor_uid,
    }


def movement_from_doc(doc_id: str, d: Doc) -> StockMovement:
    return StockMovement(
        id=doc_id,
        product_id=d["product_id"],
        type=MovementType(d["type"]),
        qty=d["qty"],
        created_at=from_timestamp(d["created_at"]),
        note=d["note"],
        origin=d["origin"],
        actor_uid=d["actor_uid"],
    )


def sale_to_doc(s: Sale) -> Doc:
    return {
        "items": [{"product_id": i.product_id, "qty": i.qty} for i in s.items],
        "status": s.status.value,
        "created_at": to_timestamp(s.created_at),
        "created_by": s.created_by,
        "cancelled_at": None if s.cancelled_at is None else to_timestamp(s.cancelled_at),
        "cancelled_by": s.cancelled_by,
    }


def sale_from_doc(doc_id: str, d: Doc) -> Sale:
    return Sale(
        id=doc_id,
        items=tuple(SaleItem(product_id=i["product_id"], qty=i["qty"]) for i in d["items"]),
        status=SaleStatus(d["status"]),
        created_at=from_timestamp(d["created_at"]),
        created_by=d["created_by"],
        cancelled_at=_optional_timestamp(d.get("cancelled_at")),
        cancelled_by=d.get("cancelled_by"),
    )


def settings_to_doc(s: StoreSettings) -> Doc:
    return {
        "store_name": s.store_name,
        "whatsapp": s.whatsapp,
        "address": s.address,
        "hours": s.hours,
        "about": s.about,
        "show_out_of_stock": s.show_out_of_stock,
        "show_featured": s.show_featured,
    }


def settings_from_doc(d: Doc) -> StoreSettings:
    return StoreSettings(
        store_name=d["store_name"],
        whatsapp=d["whatsapp"],
        address=d["address"],
        hours=d["hours"],
        about=d["about"],
        show_out_of_stock=d["show_out_of_stock"],
        show_featured=d["show_featured"],
    )


def idempotency_to_doc(r: IdempotencyRecord) -> Doc:
    return {
        "key": r.key,
        "operation": r.operation,
        "actor_uid": r.actor_uid,
        "request_hash": r.request_hash,
        "result_id": r.result_id,
        "response": r.response,
        "response_version": r.response_version,
        "created_at": to_timestamp(r.created_at),
        "expires_at": to_timestamp(r.expires_at),
    }


def idempotency_from_doc(d: Doc) -> IdempotencyRecord:
    return IdempotencyRecord(
        key=d["key"],
        operation=d["operation"],
        actor_uid=d["actor_uid"],
        request_hash=d["request_hash"],
        result_id=d["result_id"],
        response=d["response"],
        response_version=d["response_version"],
        created_at=from_timestamp(d["created_at"]),
        expires_at=from_timestamp(d["expires_at"]),
    )


def claim_to_doc(category_id: str, normalized_name: str) -> Doc:
    return {"category_id": category_id, "normalized_name": normalized_name}
