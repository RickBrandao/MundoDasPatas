"""Regras de domínio (puras) — mesmos cenários de `src/domain/operations.test.ts`."""

import itertools
from datetime import timedelta

import pytest

from app.core.errors import Conflict, InsufficientStock, ValidationFailed
from app.domain.inventory import initial_stock_movement, merge_items, plan_cancellation, plan_sale, plan_stock_move
from app.domain.models import MovementType, SaleItem, SaleStatus
from tests.conftest import NOW, product

_ids = itertools.count(1)


def new_id() -> str:
    return f"id{next(_ids)}"


PRODUCTS = {"a": product("a", stock=5), "b": product("b", stock=2), "arq": product("arq", archived=True)}


def sell(items: list[SaleItem], products: dict = PRODUCTS):  # type: ignore[type-arg]
    return plan_sale(products, items, sale_id="v1", actor_uid="admin", now=NOW, new_id=new_id)


# --------------------------------------------------------------------- vendas


def test_sale_reduces_stock_and_records_movements() -> None:
    change = sell([SaleItem("a", 2), SaleItem("b", 2)])
    assert change.sale is not None
    assert change.sale.status is SaleStatus.CONCLUIDA
    assert change.sale.created_by == "admin"
    assert {p.id: p.stock for p in change.products} == {"a": 3, "b": 0}
    assert [(m.product_id, m.type, m.qty, m.actor_uid) for m in change.movements] == [
        ("a", MovementType.VENDA, -2, "admin"),
        ("b", MovementType.VENDA, -2, "admin"),
    ]
    assert all(m.origin == "Venda v1" for m in change.movements)


def test_sale_merges_repeated_lines_before_checking_stock() -> None:
    assert merge_items([SaleItem("a", 2), SaleItem("b", 1), SaleItem("a", 3)]) == (SaleItem("a", 5), SaleItem("b", 1))
    with pytest.raises(InsufficientStock):
        sell([SaleItem("a", 3), SaleItem("a", 3)])  # 6 > 5, mesmo com cada linha cabendo isoladamente


def test_sale_is_all_or_nothing() -> None:
    with pytest.raises(InsufficientStock, match="2 un. disponíveis"):
        sell([SaleItem("a", 1), SaleItem("b", 3)])


@pytest.mark.parametrize(
    ("items", "error"),
    [
        ([], ValidationFailed),
        ([SaleItem("a", 0)], ValidationFailed),
        ([SaleItem("a", -1)], ValidationFailed),
        ([SaleItem("nao-existe", 1)], ValidationFailed),
        ([SaleItem("arq", 1)], Conflict),
        ([SaleItem("a", 6)], InsufficientStock),
    ],
)
def test_sale_rejections(items: list[SaleItem], error: type[Exception]) -> None:
    with pytest.raises(error):
        sell(items)


def test_selling_entire_stock_is_allowed() -> None:
    change = sell([SaleItem("a", 5)])
    assert change.products[0].stock == 0


# --------------------------------------------------------------------- cancelamento


def test_cancellation_returns_stock_once() -> None:
    sale = sell([SaleItem("a", 2)]).sale
    assert sale is not None
    after_sale = {"a": product("a", stock=3)}
    change = plan_cancellation(sale, after_sale, actor_uid="admin2", now=NOW + timedelta(hours=1), new_id=new_id)
    assert change.sale is not None
    assert change.sale.status is SaleStatus.CANCELADA
    assert change.sale.cancelled_by == "admin2"
    assert change.sale.cancelled_at == NOW + timedelta(hours=1)
    assert change.products[0].stock == 5
    assert [(m.type, m.qty) for m in change.movements] == [(MovementType.ESTORNO, 2)]

    with pytest.raises(Conflict, match="já foi cancelada"):
        plan_cancellation(change.sale, after_sale, actor_uid="admin", now=NOW, new_id=new_id)


def test_cancellation_returns_stock_even_if_product_was_archived() -> None:
    sale = sell([SaleItem("a", 1)]).sale
    assert sale is not None
    change = plan_cancellation(sale, {"a": product("a", stock=4, archived=True)}, actor_uid="x", now=NOW, new_id=new_id)
    assert change.products[0].stock == 5


def test_cancellation_with_missing_product_is_conflict() -> None:
    sale = sell([SaleItem("a", 1)]).sale
    assert sale is not None
    with pytest.raises(Conflict):
        plan_cancellation(sale, {}, actor_uid="x", now=NOW, new_id=new_id)


# --------------------------------------------------------------------- movimentações


def move(move_type: MovementType, qty: int, note: str = "", stock: int = 5):  # type: ignore[no-untyped-def]
    return plan_stock_move(product("a", stock=stock), move_type, qty, note, movement_id="m1", actor_uid="admin", now=NOW)


def test_entry_adds_stock() -> None:
    change = move(MovementType.ENTRADA, 3)
    assert change.products[0].stock == 8
    m = change.movements[0]
    assert (m.type, m.qty, m.note, m.origin, m.actor_uid) == (MovementType.ENTRADA, 3, "Entrada de mercadoria", "Painel", "admin")


def test_adjustment_sets_new_balance_and_records_delta() -> None:
    change = move(MovementType.AJUSTE, 2, note="Contagem")
    assert change.products[0].stock == 2
    assert change.movements[0].qty == -3
    assert change.movements[0].note == "Contagem"


def test_adjustment_to_zero_is_allowed() -> None:
    assert move(MovementType.AJUSTE, 0, note="Perda").products[0].stock == 0


@pytest.mark.parametrize(
    ("move_type", "qty", "note", "field"),
    [
        (MovementType.ENTRADA, 0, "", "qty"),
        (MovementType.AJUSTE, 5, "Contagem", "qty"),  # igual ao atual
        (MovementType.AJUSTE, 3, "   ", "note"),  # motivo obrigatório
        (MovementType.AJUSTE, -1, "x", "qty"),  # saldo negativo
        (MovementType.VENDA, 1, "", "type"),  # vendas só pela operação de venda
    ],
)
def test_stock_move_rejections(move_type: MovementType, qty: int, note: str, field: str) -> None:
    with pytest.raises(ValidationFailed) as exc:
        move(move_type, qty, note)
    assert exc.value.field_errors and field in exc.value.field_errors


def test_initial_stock_movement() -> None:
    p = product("novo", stock=7)
    m = initial_stock_movement(p, movement_id="m1", actor_uid="admin")
    assert m is not None
    assert (m.type, m.qty, m.origin, m.created_at) == (MovementType.CADASTRO, 7, "Cadastro de produto", p.created_at)
    assert initial_stock_movement(product("vazio", stock=0), movement_id="m2", actor_uid="admin") is None
