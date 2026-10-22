"""Firestore sem rede: serialização, seleção do cliente, tradução de erros e repetição de transações.

O comportamento transacional real (concorrência, rollback, consultas) é testado contra o
emulador em `tests_emulator/` — ver README, seção "Firestore Emulator".
"""

import logging
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest
from google.api_core import exceptions as gexc
from google.api_core.datetime_helpers import DatetimeWithNanoseconds
from pydantic import ValidationError

from app.core import firestore as core_fs
from app.core.firestore import DatabaseBusy, DatabaseNotConfigured, DatabaseUnavailable, LazyFirestoreClient
from app.domain.models import (
    DEFAULT_SETTINGS,
    IdempotencyRecord,
    MovementType,
    Sale,
    SaleItem,
    SaleStatus,
    StockMovement,
)
from app.main import build_repositories
from app.repositories import firestore as fs
from app.repositories import firestore_codec as codec
from app.repositories.firestore import FirestoreInventoryTransaction, ReadAfterWrite
from app.services.common import derived_ids
from tests.conftest import NOW, UnreachableFirestore, category, make_settings, product, unreachable_firestore_repos

# --------------------------------------------------------------------- serialização


def test_entities_roundtrip_through_documents() -> None:
    p = product("p1", price_cents=None, show_price=False)
    assert codec.product_from_doc("p1", codec.product_to_doc(p)) == p
    c = category("c1", "Rações")
    assert codec.category_from_doc("c1", codec.category_to_doc(c)) == c
    m = StockMovement("m1", "p1", MovementType.VENDA, -2, NOW, "Venda registrada", "Venda s1", "admin")
    assert codec.movement_from_doc("m1", codec.movement_to_doc(m)) == m
    s = Sale("s1", (SaleItem("p1", 2), SaleItem("p2", 1)), SaleStatus.CANCELADA, NOW, "a", NOW + timedelta(hours=1), "b")
    assert codec.sale_from_doc("s1", codec.sale_to_doc(s)) == s
    assert codec.settings_from_doc(codec.settings_to_doc(DEFAULT_SETTINGS)) == DEFAULT_SETTINGS
    r = IdempotencyRecord("k", "sale.create", "admin", "h", "s1", '{"id":"s1"}', 1, NOW, NOW + timedelta(hours=24))
    assert codec.idempotency_from_doc(codec.idempotency_to_doc(r)) == r


def test_documents_use_snake_case_native_types_and_no_id_field() -> None:
    doc = codec.product_to_doc(product("p1"))
    assert "id" not in doc
    assert {"category_id", "price_cents", "min_stock", "created_at"} <= doc.keys()
    assert isinstance(doc["price_cents"], int) and isinstance(doc["stock"], int)
    assert isinstance(doc["created_at"], datetime) and doc["created_at"].tzinfo is UTC
    sale_doc = codec.sale_to_doc(Sale("s1", (SaleItem("p1", 1),), SaleStatus.CONCLUIDA, NOW, "a"))
    assert sale_doc["status"] == "concluida" and sale_doc["items"] == [{"product_id": "p1", "qty": 1}]


def test_naive_datetimes_are_rejected_and_offsets_normalized_to_utc() -> None:
    with pytest.raises(ValueError):
        codec.to_timestamp(datetime(2026, 1, 1, 12, 0))  # noqa: DTZ001
    brt = datetime(2026, 1, 1, 9, 0, tzinfo=timezone(timedelta(hours=-3)))
    assert codec.to_timestamp(brt) == datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    assert codec.to_timestamp(brt).utcoffset() == timedelta(0)


def test_sdk_timestamps_become_plain_utc_datetimes() -> None:
    raw = DatetimeWithNanoseconds(2026, 10, 20, 12, 0, 0, 123456, tzinfo=UTC)
    value = codec.from_timestamp(raw)
    assert type(value) is datetime and value == datetime(2026, 10, 20, 12, 0, 0, 123456, tzinfo=UTC)
    with pytest.raises(TypeError):
        codec.from_timestamp("2026-10-20T12:00:00Z")


def test_deterministic_document_ids() -> None:
    a = codec.idempotency_doc_id("sale.create", "admin", "key-1")
    assert a == codec.idempotency_doc_id("sale.create", "admin", "key-1")
    assert len(a) == 64 and "/" not in a
    # Escopo (operação, usuário, chave) sem ambiguidade de separadores.
    assert a != codec.idempotency_doc_id("sale.create", "admi", "nkey-1")
    assert a != codec.idempotency_doc_id("sale.cancel", "admin", "key-1")
    assert codec.category_claim_id("racao") == codec.category_claim_id("racao") != codec.category_claim_id("racoes")


def test_derived_ids_restart_identically_on_each_attempt() -> None:
    first, retry = derived_ids("seed"), derived_ids("seed")
    run1 = [first(), first(), first()]
    assert [retry(), retry(), retry()] == run1
    assert len(set(run1)) == 3 and all(len(i) == 32 for i in run1)
    assert derived_ids("outra")() != run1[0]


# --------------------------------------------------------------------- configuração do cliente


def test_emulator_is_forbidden_in_deployed_environments() -> None:
    with pytest.raises(ValidationError, match="FIRESTORE_EMULATOR_HOST"):
        make_settings(
            app_env="production",
            data_backend="firestore",
            firebase_project_id="mdp-prod",
            cors_origins="https://mundodaspatas.com.br",
            firestore_emulator_host="127.0.0.1:8181",
        )


def test_client_requires_project_id() -> None:
    with pytest.raises(DatabaseNotConfigured):
        core_fs.create_firestore_client(make_settings(data_backend="firestore"))


def test_emulator_only_in_env_file_is_refused(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    # Definido só na configuração (.env), o SDK não o enxergaria e iria ao projeto real: recusado.
    settings = make_settings(data_backend="firestore", firebase_project_id="demo-x", firestore_emulator_host="127.0.0.1:8181")
    with pytest.raises(DatabaseNotConfigured), caplog.at_level(logging.ERROR):
        core_fs.create_firestore_client(settings)
    assert "8181" not in caplog.text


def test_emulator_in_process_env_uses_anonymous_local_client(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8181")
    settings = make_settings(data_backend="firestore", firebase_project_id="demo-x")
    client = core_fs.create_firestore_client(settings)  # não conecta: o canal é criado sob demanda
    assert client.project == "demo-x"
    assert client._emulator_host == "127.0.0.1:8181"
    assert type(client._credentials).__name__ == "AnonymousCredentials"


def test_emulator_in_process_env_is_refused_when_deployed(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = make_settings(
        app_env="staging", data_backend="firestore", firebase_project_id="mdp", cors_origins="https://a.example"
    )
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8181")
    # O processo ganhou a variável depois da validação da configuração: ainda assim é recusado.
    object.__setattr__(settings, "firestore_emulator_host", "127.0.0.1:8181")
    with pytest.raises(DatabaseNotConfigured):
        core_fs.create_firestore_client(settings)


def test_real_client_failure_from_firebase_is_503(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core import firebase

    def broken(_: Any) -> Any:
        raise firebase.FirebaseInitFailed()

    monkeypatch.setattr(firebase, "get_firebase_app", broken)
    with pytest.raises(DatabaseNotConfigured):
        core_fs.create_firestore_client(make_settings(data_backend="firestore", firebase_project_id="demo"))


def test_lazy_client_is_created_once_and_failures_are_not_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []

    def factory(_: Any) -> Any:
        calls.append(1)
        if len(calls) == 1:
            raise DatabaseNotConfigured()
        return object()

    monkeypatch.setattr(core_fs, "create_firestore_client", factory)
    lazy = LazyFirestoreClient(make_settings())
    with pytest.raises(DatabaseNotConfigured):
        lazy()
    assert lazy() is lazy()
    assert len(calls) == 2


def test_building_firestore_repositories_opens_no_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(_: Any) -> Any:
        raise AssertionError("cliente criado na inicialização")

    monkeypatch.setattr(core_fs, "create_firestore_client", forbidden)
    repos = build_repositories(make_settings(data_backend="firestore", firebase_project_id="demo"))
    assert type(repos.products).__name__ == "FirestoreProductRepository"


# --------------------------------------------------------------------- erros


@pytest.mark.parametrize(
    "error",
    [
        gexc.ServiceUnavailable("10.0.0.1 token=SEGREDO"),
        gexc.DeadlineExceeded("SEGREDO"),
        gexc.PermissionDenied("SEGREDO"),
        gexc.Unauthenticated("SEGREDO"),
        gexc.FailedPrecondition("The query requires an index SEGREDO"),
        gexc.RetryError("SEGREDO", cause=None),
    ],
    ids=lambda e: type(e).__name__,
)
def test_google_errors_become_503_without_leaking(error: Exception, caplog: pytest.LogCaptureFixture) -> None:
    repos = unreachable_firestore_repos(make_settings(data_backend="firestore", firebase_project_id="demo"), error)
    with caplog.at_level(logging.INFO), pytest.raises(DatabaseUnavailable) as info:
        repos.products.list()
    assert info.value.__cause__ is None and info.value.__suppress_context__
    assert "SEGREDO" not in caplog.text
    assert type(error).__name__ in caplog.text


def test_every_repository_method_translates_errors() -> None:
    repos = unreachable_firestore_repos(make_settings(data_backend="firestore", firebase_project_id="demo"))
    calls = [
        lambda: repos.categories.list(),
        lambda: repos.categories.get("c"),
        lambda: repos.categories.save(category("c", "X")),
        lambda: repos.products.get("p"),
        lambda: repos.sales.list(10, since=NOW),
        lambda: repos.sales.get("s"),
        lambda: repos.movements.list(10, product_id="p"),
        lambda: repos.movements.get("m"),
        lambda: repos.settings.get(),
        lambda: repos.settings.save(DEFAULT_SETTINGS),
        lambda: repos.inventory.run_in_transaction(lambda tx: None),
    ]
    for call in calls:
        with pytest.raises(DatabaseUnavailable):
            call()


class _FakeTransactional:
    """Substitui `firestore.transactional`: falha `errors` vezes e depois executa a função."""

    def __init__(self, errors: list[Exception]) -> None:
        self.errors = errors
        self.runs = 0

    def __call__(self, fn: Any) -> Any:
        def run(tx: Any) -> Any:
            self.runs += 1
            if self.errors:
                raise self.errors.pop(0)
            return fn(tx)

        return run


class _FakeDb:
    def transaction(self, **_: Any) -> object:
        return object()


def _patch_transactional(monkeypatch: pytest.MonkeyPatch, errors: list[Exception]) -> _FakeTransactional:
    fake = _FakeTransactional(errors)
    monkeypatch.setattr(fs.firestore, "transactional", fake)
    monkeypatch.setattr(fs.time, "sleep", lambda _: None)
    return fake


def test_abort_during_reads_is_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _patch_transactional(monkeypatch, [gexc.Aborted("lock"), gexc.Aborted("lock")])
    assert fs._transact(_FakeDb(), lambda tx: "ok") == "ok"  # type: ignore[arg-type]
    assert fake.runs == 3


def test_persistent_contention_is_503_busy(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_transactional(monkeypatch, [gexc.Aborted("lock")] * fs.CONTENTION_ROUNDS)
    with pytest.raises(DatabaseBusy):
        fs._transact(_FakeDb(), lambda tx: "ok")  # type: ignore[arg-type]

    exhausted = ValueError("Failed to commit transaction in 5 attempts.")
    exhausted.__cause__ = gexc.Aborted("contention")
    fake = _patch_transactional(monkeypatch, [exhausted] * (fs.CONTENTION_ROUNDS - 1))
    assert fs._transact(_FakeDb(), lambda tx: "ok") == "ok"  # type: ignore[arg-type]
    assert fake.runs == fs.CONTENTION_ROUNDS
    _patch_transactional(monkeypatch, [exhausted] * fs.CONTENTION_ROUNDS)
    with pytest.raises(DatabaseBusy):
        fs._transact(_FakeDb(), lambda tx: "ok")  # type: ignore[arg-type]


def test_other_value_errors_are_not_mistaken_for_contention(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_transactional(monkeypatch, [ValueError("bug")])
    with pytest.raises(ValueError, match="bug"):
        fs._transact(_FakeDb(), lambda tx: "ok")  # type: ignore[arg-type]


def test_reads_after_writes_are_a_programming_error() -> None:
    class Tx:
        def set(self, *_: Any) -> None: ...

    tx = FirestoreInventoryTransaction(UnreachableFirestore(), Tx())  # type: ignore[arg-type]
    # Nenhuma leitura chega ao cliente depois de uma escrita.
    tx._writing = True
    with pytest.raises(ReadAfterWrite):
        tx.get_products(["p1"])
