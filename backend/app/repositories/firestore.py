"""Repositórios do Cloud Firestore (implementam os Protocols de `repositories/base.py`).

Coleções: `categories`, `products`, `sales`, `stock_movements`, `settings/store`,
`idempotency_keys/{sha256(operação, usuário, chave)}` e `category_name_claims/{sha256(nome)}`.
Formato dos documentos em `firestore_codec.py`.

Transações (`run_in_transaction` e `CategoryRepository.save`):
- usam as transações do Firestore: todas as leituras antes das escritas; se outro processo altera
  um documento lido, o commit falha e a função é **reexecutada** com dados novos. Por isso a função
  não tem efeitos externos e os IDs/horários são fixados antes dela (ver `services/inventory.py`);
- o SDK só repete quando o conflito aparece no commit, e sem espera. Aqui a função inteira é
  repetida em novas rodadas, com espera aleatória crescente, tanto para `Aborted` numa leitura
  quanto para commits esgotados; persistindo a disputa, responde 503 `database_busy`;
- movimentações são gravadas com `create` (imutáveis: nunca sobrescrevem um documento existente).

Falhas do Google Cloud (rede, permissão, credenciais, índice ausente) viram 503 `database_unavailable`;
o log registra só o tipo e o código gRPC, nunca a mensagem. Erros de negócio levantados dentro da
transação (estoque insuficiente, conflitos) desfazem tudo e seguem inalterados até a API.

Nenhum estado em memória é fonte de verdade: cada leitura vai ao banco, e várias instâncias podem
operar ao mesmo tempo (a consistência vem das transações, não de locks do processo).
"""

import logging
import random
import time
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from datetime import datetime
from functools import wraps
from typing import TYPE_CHECKING, Any

from google.api_core import exceptions as gexc
from google.auth.exceptions import GoogleAuthError
from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from app.core.config import Settings
from app.core.firestore import DatabaseBusy, DatabaseUnavailable, LazyFirestoreClient
from app.domain.catalog import normalize_text
from app.domain.models import Category, IdempotencyRecord, Product, Sale, StockMovement, StoreSettings
from app.repositories import firestore_codec as codec
from app.repositories.base import CategoryNameTaken, Repositories

if TYPE_CHECKING:
    from google.cloud.firestore import Client, DocumentReference, DocumentSnapshot, Transaction

logger = logging.getLogger("app.firestore")

CATEGORIES = "categories"
PRODUCTS = "products"
SALES = "sales"
MOVEMENTS = "stock_movements"
SETTINGS = "settings"
SETTINGS_DOC = "store"
IDEMPOTENCY = "idempotency_keys"
CATEGORY_CLAIMS = "category_name_claims"

# Tentativas do SDK quando o commit é recusado por conflito (padrão do SDK: 5).
COMMIT_ATTEMPTS = 5
# Rodadas completas (cada uma com até COMMIT_ATTEMPTS commits) com espera aleatória entre elas.
# Pior caso de espera acumulada ~1,5 s antes de responder 503 `database_busy`.
CONTENTION_ROUNDS = 5

ClientFactory = Callable[[], "Client"]


# ----------------------------------------------------------------- erros


@contextmanager
def _translate_errors() -> Iterator[None]:
    try:
        yield
    except (gexc.GoogleAPICallError, gexc.RetryError, GoogleAuthError) as exc:
        code = getattr(exc, "code", None)
        logger.error("Falha ao acessar o Firestore: %s código=%s", type(exc).__name__, getattr(code, "name", code) or "-")
        raise DatabaseUnavailable() from None


def _guarded[F: Callable[..., Any]](method: F) -> F:
    @wraps(method)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        with _translate_errors():
            return method(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


def _is_contention(exc: BaseException) -> bool:
    # Aborted numa leitura (o SDK não repete) ou tentativas de commit esgotadas (o SDK embrulha o
    # último Aborted num ValueError).
    return isinstance(exc, gexc.Aborted) or (isinstance(exc, ValueError) and isinstance(exc.__cause__, gexc.Aborted))


def _transact[T](db: "Client", fn: Callable[["Transaction"], T]) -> T:
    """Executa `fn` numa transação do Firestore, repetindo-a em disputa. `fn` precisa ser reexecutável.

    O SDK repete o commit sem espera; sob disputa intensa as tentativas colidem em sincronia. Aqui
    cada nova rodada espera um intervalo aleatório crescente, que dessincroniza os concorrentes.
    """
    for attempt in range(1, CONTENTION_ROUNDS + 1):
        try:
            return firestore.transactional(fn)(db.transaction(max_attempts=COMMIT_ATTEMPTS))
        except (gexc.Aborted, ValueError) as exc:
            if not _is_contention(exc):
                raise
            if attempt == CONTENTION_ROUNDS:
                logger.warning("Transação abandonada após %s rodadas de tentativas (disputa).", attempt)
                raise DatabaseBusy() from None
            time.sleep(random.uniform(0, 0.05 * 2**attempt))  # noqa: S311 - jitter, não criptografia
    raise AssertionError("inalcançável")


def _snapshots_by_id(snapshots: Iterable["DocumentSnapshot"]) -> dict[str, "DocumentSnapshot"]:
    # get_all não garante a ordem: indexa pelo caminho do documento.
    return {s.reference.path: s for s in snapshots}


# ----------------------------------------------------------------- repositórios simples


class _Base:
    def __init__(self, client: ClientFactory) -> None:
        self._client = client

    def _col(self, name: str) -> Any:
        return self._client().collection(name)


class FirestoreCategoryRepository(_Base):
    @_guarded
    def list(self) -> list[Category]:
        return [codec.category_from_doc(s.id, s.to_dict()) for s in self._col(CATEGORIES).stream()]

    @_guarded
    def get(self, category_id: str) -> Category | None:
        snap = self._col(CATEGORIES).document(category_id).get()
        return codec.category_from_doc(snap.id, snap.to_dict()) if snap.exists else None

    @_guarded
    def save(self, category: Category) -> None:
        db = self._client()
        new_key = normalize_text(category.name)
        cat_ref = db.collection(CATEGORIES).document(category.id)
        claim_ref = db.collection(CATEGORY_CLAIMS).document(codec.category_claim_id(new_key))

        def body(tx: "Transaction") -> None:
            # Leituras: categoria atual e reserva do novo nome (e, numa renomeação, a reserva antiga).
            snaps = _snapshots_by_id(tx.get_all([cat_ref, claim_ref]))
            current, claim = snaps[cat_ref.path], snaps[claim_ref.path]
            if claim.exists and claim.get("category_id") != category.id:
                raise CategoryNameTaken()
            old_claim_ref: DocumentReference | None = None
            if current.exists:
                old_key = normalize_text(current.get("name"))
                if old_key != new_key:
                    old_claim_ref = db.collection(CATEGORY_CLAIMS).document(codec.category_claim_id(old_key))
            old_claim = next(iter(tx.get_all([old_claim_ref])), None) if old_claim_ref else None

            # Escritas.
            tx.set(cat_ref, codec.category_to_doc(category))
            if not claim.exists:
                tx.create(claim_ref, codec.claim_to_doc(category.id, new_key))
            if old_claim_ref and old_claim and old_claim.exists and old_claim.get("category_id") == category.id:
                tx.delete(old_claim_ref)  # o nome antigo fica livre

        _transact(db, body)


class FirestoreProductRepository(_Base):
    @_guarded
    def list(self) -> list[Product]:
        return [codec.product_from_doc(s.id, s.to_dict()) for s in self._col(PRODUCTS).stream()]

    @_guarded
    def get(self, product_id: str) -> Product | None:
        snap = self._col(PRODUCTS).document(product_id).get()
        return codec.product_from_doc(snap.id, snap.to_dict()) if snap.exists else None


class FirestoreSaleRepository(_Base):
    @_guarded
    def list(self, limit: int, since: datetime | None = None) -> list[Sale]:
        # Filtro e ordenação no mesmo campo: atendido pelo índice simples automático de created_at.
        query = self._col(SALES)
        if since is not None:
            query = query.where(filter=FieldFilter("created_at", ">=", codec.to_timestamp(since)))
        query = query.order_by("created_at", direction=firestore.Query.DESCENDING).limit(limit)
        return [codec.sale_from_doc(s.id, s.to_dict()) for s in query.stream()]

    @_guarded
    def get(self, sale_id: str) -> Sale | None:
        snap = self._col(SALES).document(sale_id).get()
        return codec.sale_from_doc(snap.id, snap.to_dict()) if snap.exists else None


class FirestoreStockMovementRepository(_Base):
    @_guarded
    def list(self, limit: int, product_id: str | None = None) -> list[StockMovement]:
        query = self._col(MOVEMENTS)
        if product_id is not None:
            # Índice composto (product_id ASC, created_at DESC) — ver firestore.indexes.json.
            query = query.where(filter=FieldFilter("product_id", "==", product_id))
        query = query.order_by("created_at", direction=firestore.Query.DESCENDING).limit(limit)
        return [codec.movement_from_doc(s.id, s.to_dict()) for s in query.stream()]

    @_guarded
    def get(self, movement_id: str) -> StockMovement | None:
        snap = self._col(MOVEMENTS).document(movement_id).get()
        return codec.movement_from_doc(snap.id, snap.to_dict()) if snap.exists else None


class FirestoreSettingsRepository(_Base):
    @_guarded
    def get(self) -> StoreSettings | None:
        snap = self._col(SETTINGS).document(SETTINGS_DOC).get()
        return codec.settings_from_doc(snap.to_dict()) if snap.exists else None

    @_guarded
    def save(self, settings: StoreSettings) -> None:
        self._col(SETTINGS).document(SETTINGS_DOC).set(codec.settings_to_doc(settings))


# ----------------------------------------------------------------- transação de inventário


class ReadAfterWrite(RuntimeError):
    """Erro de programação: o Firestore exige todas as leituras antes da primeira escrita."""


class FirestoreInventoryTransaction:
    def __init__(self, db: "Client", tx: "Transaction") -> None:
        self._db = db
        self._tx = tx
        self._writing = False

    def _read(self, collection: str, doc_ids: Iterable[str]) -> list["DocumentSnapshot"]:
        if self._writing:
            raise ReadAfterWrite()
        refs = [self._db.collection(collection).document(i) for i in dict.fromkeys(doc_ids)]
        if not refs:
            return []
        found = _snapshots_by_id(self._tx.get_all(refs))
        return [found[ref.path] for ref in refs]

    def get_products(self, product_ids: Iterable[str]) -> dict[str, Product]:
        return {s.id: codec.product_from_doc(s.id, s.to_dict()) for s in self._read(PRODUCTS, product_ids) if s.exists}

    def get_sale(self, sale_id: str) -> Sale | None:
        (snap,) = self._read(SALES, [sale_id])
        return codec.sale_from_doc(snap.id, snap.to_dict()) if snap.exists else None

    def get_idempotency(self, operation: str, actor_uid: str, key: str) -> IdempotencyRecord | None:
        (snap,) = self._read(IDEMPOTENCY, [codec.idempotency_doc_id(operation, actor_uid, key)])
        if not snap.exists:
            return None
        record = codec.idempotency_from_doc(snap.to_dict())
        # Defesa contra colisão de hash: o registro precisa ser exatamente desta operação.
        if (record.operation, record.actor_uid, record.key) != (operation, actor_uid, key):
            return None
        return record

    def put_product(self, product: Product) -> None:
        self._writing = True
        self._tx.set(self._db.collection(PRODUCTS).document(product.id), codec.product_to_doc(product))

    def put_sale(self, sale: Sale) -> None:
        self._writing = True
        self._tx.set(self._db.collection(SALES).document(sale.id), codec.sale_to_doc(sale))

    def add_movements(self, movements: Iterable[StockMovement]) -> None:
        self._writing = True
        for m in movements:
            self._tx.create(self._db.collection(MOVEMENTS).document(m.id), codec.movement_to_doc(m))

    def put_idempotency(self, record: IdempotencyRecord) -> None:
        self._writing = True
        # `set` no ID determinístico: substitui um registro expirado da mesma chave.
        doc_id = codec.idempotency_doc_id(record.operation, record.actor_uid, record.key)
        self._tx.set(self._db.collection(IDEMPOTENCY).document(doc_id), codec.idempotency_to_doc(record))


class FirestoreInventoryRepository(_Base):
    @_guarded
    def run_in_transaction[T](self, operation: Callable[[FirestoreInventoryTransaction], T]) -> T:
        db = self._client()
        return _transact(db, lambda tx: operation(FirestoreInventoryTransaction(db, tx)))


def create_firestore_repositories(settings: Settings, client: ClientFactory | None = None) -> Repositories:
    """Nenhuma conexão é aberta aqui: o cliente é criado na primeira operação (ver `LazyFirestoreClient`)."""
    factory = client or LazyFirestoreClient(settings)
    return Repositories(
        categories=FirestoreCategoryRepository(factory),
        products=FirestoreProductRepository(factory),
        sales=FirestoreSaleRepository(factory),
        movements=FirestoreStockMovementRepository(factory),
        settings=FirestoreSettingsRepository(factory),
        inventory=FirestoreInventoryRepository(factory),
    )
