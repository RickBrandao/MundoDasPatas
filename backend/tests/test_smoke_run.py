"""Travas e regras de posse do script de smoke test no Firestore Dev (sem acesso ao Firestore)."""

import pytest

from app.domain.catalog import normalize_text
from app.repositories import firestore_codec as codec
from scripts.smoke_run import SMOKE_PROJECT, GuardError, check_target, classify, revalidate

RUN = "AUDIT_20261024T1200"


def claim(name: str) -> str:
    return codec.category_claim_id(normalize_text(name))


def run_docs() -> dict:
    cat_name = f"{RUN}_Racoes"
    return {
        "categories": {"c1": {"name": cat_name}, "c-cliente": {"name": "Rações"}},
        "category_name_claims": {claim(cat_name): {"category_id": "c1"}, claim("Rações"): {"category_id": "c-cliente"}},
        "products": {
            "p1": {"name": f"{RUN}_Racao_1kg", "category_id": "c1"},
            "p-cliente": {"name": "Ração X", "category_id": "c-cliente"},
        },
        "stock_movements": {"m1": {"product_id": "p1"}, "m2": {"product_id": "p1"}, "m-cliente": {"product_id": "p-cliente"}},
        "sales": {
            "s1": {"items": [{"product_id": "p1", "qty": 2}]},
            "s-cliente": {"items": [{"product_id": "p-cliente", "qty": 1}]},
        },
        "idempotency_keys": {
            "i1": {"operation": "stock.move", "result_id": "m1"},
            "i2": {"operation": "sale.create", "result_id": "s1"},
            "i3": {"operation": "sale.cancel", "result_id": "s1"},
            "i-cliente": {"operation": "sale.create", "result_id": "s-cliente"},
        },
    }


def test_guard_accepts_only_the_dev_project_on_real_firestore() -> None:
    check_target(SMOKE_PROJECT, "(default)", None, SMOKE_PROJECT)
    with pytest.raises(GuardError):
        check_target("mdp-prod", "(default)", None)
    with pytest.raises(GuardError):
        check_target(SMOKE_PROJECT, "outro", None)
    with pytest.raises(GuardError):
        check_target(SMOKE_PROJECT, "(default)", "127.0.0.1:8181")
    with pytest.raises(GuardError):
        check_target(SMOKE_PROJECT, "(default)", None, "mdp-prod")


@pytest.mark.parametrize("run_id", ["", "AUDIT_", "AUDIT_x", "TEST_20261024", "AUDIT_../x123", "AUDIT_ 12345"])
def test_invalid_run_ids_are_refused(run_id: str) -> None:
    with pytest.raises(GuardError):
        classify(run_id, run_docs())


def test_classify_selects_only_the_run_through_relationships() -> None:
    owned, problems = classify(RUN, run_docs())
    assert problems == []
    assert owned == {
        "categories": ["c1"],
        "category_name_claims": [claim(f"{RUN}_Racoes")],
        "products": ["p1"],
        "stock_movements": ["m1", "m2"],
        "sales": ["s1"],
        "idempotency_keys": ["i1", "i2", "i3"],
    }


def test_prefix_alone_is_not_ownership() -> None:
    docs = run_docs()
    # Produto com o prefixo, mas numa categoria do cliente: inconsistência, não é apagado.
    docs["products"]["p-falso"] = {"name": f"{RUN}_Falso", "category_id": "c-cliente"}
    owned, problems = classify(RUN, docs)
    assert "p-falso" not in owned["products"]
    assert any("p-falso" in p for p in problems)


def test_sale_mixing_run_and_client_products_blocks_cleanup() -> None:
    docs = run_docs()
    docs["sales"]["s-mista"] = {"items": [{"product_id": "p1", "qty": 1}, {"product_id": "p-cliente", "qty": 1}]}
    owned, problems = classify(RUN, docs)
    assert "s-mista" not in owned["sales"]
    assert any("s-mista" in p for p in problems)


def test_revalidate_detects_drift_between_manifest_and_current_state() -> None:
    owned, _ = classify(RUN, run_docs())
    assert revalidate(owned, owned) == []
    drift = {**owned, "sales": [], "products": ["p1", "p-novo"]}
    problems = revalidate(owned, drift)
    assert any(p.startswith("sales") for p in problems)
    assert any(p.startswith("products") and "p-novo" in p for p in problems)
