"""Smoke test controlado no Firestore Dev real: inventário e limpeza dos dados de UMA execução.

    python -m scripts.smoke_run counts                                   # somente leitura
    python -m scripts.smoke_run discover --run-id AUDIT_x --out m.json   # somente leitura
    python -m scripts.smoke_run cleanup --manifest m.json --confirm-project mundo-das-patas---dev

Trava: só roda contra `SMOKE_PROJECT` (Firestore real, banco `(default)`), nunca com emulador.

`discover` lê as coleções da aplicação e separa o que pertence à execução pelos relacionamentos
(categoria com o prefixo → claim do nome → produtos da categoria com o prefixo → movimentações e
vendas desses produtos → registros de idempotência cujo `result_id` é uma dessas movimentações/vendas).
Qualquer documento ligado à execução que também aponte para dados alheios é uma inconsistência.

`cleanup` relê cada ID do manifesto, revalida a posse e só então apaga, na ordem das dependências
(idempotência → movimentações → vendas → produtos → claims → categorias). Havendo qualquer problema,
nada é apagado. Nunca apaga coleções inteiras nem IDs fora do manifesto. Não imprime conteúdo sensível.
"""

import argparse
import json
import os
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from app.core.config import Settings
from app.core.firestore import EMULATOR_ENV, create_firestore_client
from app.domain.catalog import normalize_text
from app.repositories import firestore as fs
from app.repositories import firestore_codec as codec

SMOKE_PROJECT = "mundo-das-patas---dev"
SMOKE_DATABASE = "(default)"
RUN_PREFIX = "AUDIT_"
COLLECTIONS = (fs.CATEGORIES, fs.PRODUCTS, fs.SALES, fs.MOVEMENTS, fs.SETTINGS, fs.IDEMPOTENCY, fs.CATEGORY_CLAIMS)
# Ordem de exclusão: primeiro quem referencia, por último quem é referenciado.
DELETE_ORDER = (fs.IDEMPOTENCY, fs.MOVEMENTS, fs.SALES, fs.PRODUCTS, fs.CATEGORY_CLAIMS, fs.CATEGORIES)
RESULT_COLLECTION = {"stock.move": fs.MOVEMENTS, "sale.create": fs.SALES, "sale.cancel": fs.SALES}

Docs = Mapping[str, Mapping[str, Mapping[str, Any]]]  # coleção → id → campos


class GuardError(RuntimeError):
    pass


def check_target(project: str | None, database: str, emulator: str | None, confirm: str | None = None) -> None:
    """Recusa qualquer alvo que não seja exatamente o Firestore real do projeto Dev autorizado."""
    if emulator:
        raise GuardError("FIRESTORE_EMULATOR_HOST definida: este script é só para o Firestore Dev real.")
    if project != SMOKE_PROJECT:
        raise GuardError(f"Projeto configurado não autorizado (esperado {SMOKE_PROJECT}).")
    if database != SMOKE_DATABASE:
        raise GuardError(f"Banco configurado não autorizado (esperado {SMOKE_DATABASE}).")
    if confirm is not None and confirm != SMOKE_PROJECT:
        raise GuardError("--confirm-project diferente do projeto autorizado.")


def valid_run_id(run_id: str) -> bool:
    rest = run_id.removeprefix(RUN_PREFIX)
    return run_id.startswith(RUN_PREFIX) and len(rest) >= 6 and rest.replace("_", "").isalnum()


def classify(run_id: str, docs: Docs) -> tuple[dict[str, list[str]], list[str]]:
    """IDs da execução por coleção e lista de inconsistências (vazia = seguro limpar)."""
    if not valid_run_id(run_id):
        raise GuardError("run-id inválido (formato AUDIT_<id>, ao menos 6 caracteres).")
    prefix = f"{run_id}_"
    get = lambda col: docs.get(col, {})  # noqa: E731
    problems: list[str] = []

    categories = {i for i, d in get(fs.CATEGORIES).items() if str(d.get("name", "")).startswith(prefix)}
    claims = {i for i, d in get(fs.CATEGORY_CLAIMS).items() if d.get("category_id") in categories}
    for cid in categories:
        expected = codec.category_claim_id(normalize_text(get(fs.CATEGORIES)[cid]["name"]))
        if expected not in claims:
            problems.append(f"claim do nome ausente para a categoria {cid}")
    for i in claims - {codec.category_claim_id(normalize_text(get(fs.CATEGORIES)[c]["name"])) for c in categories}:
        problems.append(f"claim {i} aponta para a categoria da execução mas não corresponde ao nome atual")

    products = set()
    for i, d in get(fs.PRODUCTS).items():
        mine_name = str(d.get("name", "")).startswith(prefix)
        mine_cat = d.get("category_id") in categories
        if mine_name and mine_cat:
            products.add(i)
        elif mine_name or mine_cat:
            problems.append(f"produto {i} só parcialmente ligado à execução (nome/categoria)")

    movements = {i for i, d in get(fs.MOVEMENTS).items() if d.get("product_id") in products}
    sales = set()
    for i, d in get(fs.SALES).items():
        refs = {it.get("product_id") for it in d.get("items", [])}
        if refs & products:
            if refs <= products:
                sales.add(i)
            else:
                problems.append(f"venda {i} mistura produtos da execução com produtos alheios")

    idempotency = set()
    for i, d in get(fs.IDEMPOTENCY).items():
        target = RESULT_COLLECTION.get(str(d.get("operation")))
        if target == fs.MOVEMENTS and d.get("result_id") in movements or target == fs.SALES and d.get("result_id") in sales:
            idempotency.add(i)
        elif d.get("result_id") in movements | sales:
            problems.append(f"registro de idempotência {i} com operação inesperada")

    owned = {
        fs.CATEGORIES: sorted(categories),
        fs.CATEGORY_CLAIMS: sorted(claims),
        fs.PRODUCTS: sorted(products),
        fs.MOVEMENTS: sorted(movements),
        fs.SALES: sorted(sales),
        fs.IDEMPOTENCY: sorted(idempotency),
    }
    return owned, problems


def revalidate(manifest_owned: Mapping[str, list[str]], current_owned: Mapping[str, list[str]]) -> list[str]:
    """O manifesto precisa continuar idêntico ao que a releitura classifica como da execução."""
    problems = []
    for col in DELETE_ORDER:
        before, now = set(manifest_owned.get(col, [])), set(current_owned.get(col, []))
        if missing := before - now:
            problems.append(f"{col}: ID(s) do manifesto que sumiram ou não pertencem mais à execução: {sorted(missing)}")
        if extra := now - before:
            problems.append(f"{col}: documento(s) da execução fora do manifesto: {sorted(extra)}")
    return problems


# ----------------------------------------------------------------- acesso ao Firestore


def _client() -> Any:
    settings = Settings()
    check_target(settings.firebase_project_id, settings.firestore_database_id, os.environ.get(EMULATOR_ENV))
    return create_firestore_client(settings)


def _read_all(db: Any) -> dict[str, dict[str, dict[str, Any]]]:
    # O banco Dev é pequeno; ler as coleções permite provar a ausência de referências órfãs.
    return {col: {s.id: s.to_dict() or {} for s in db.collection(col).stream()} for col in COLLECTIONS}


def _counts(db: Any) -> dict[str, int]:
    return {col: int(db.collection(col).count().get()[0][0].value) for col in COLLECTIONS}


def _orphans(docs: Docs) -> list[str]:
    """Referências que apontam para documentos inexistentes (em qualquer dado, não só da execução)."""
    out = []
    cats, prods = set(docs[fs.CATEGORIES]), set(docs[fs.PRODUCTS])
    out += [f"claim {i}" for i, d in docs[fs.CATEGORY_CLAIMS].items() if d.get("category_id") not in cats]
    out += [f"produto {i}" for i, d in docs[fs.PRODUCTS].items() if d.get("category_id") not in cats]
    out += [f"movimentação {i}" for i, d in docs[fs.MOVEMENTS].items() if d.get("product_id") not in prods]
    for i, d in docs[fs.SALES].items():
        if any(it.get("product_id") not in prods for it in d.get("items", [])):
            out.append(f"venda {i}")
    for i, d in docs[fs.IDEMPOTENCY].items():
        target = RESULT_COLLECTION.get(str(d.get("operation")))
        if target and d.get("result_id") not in docs[target]:
            out.append(f"idempotência {i}")
    return out


def cmd_counts(_: argparse.Namespace) -> int:
    db = _client()
    docs = _read_all(db)
    summary = {"project": SMOKE_PROJECT, "database": SMOKE_DATABASE, "counts": _counts(db), "orphans": _orphans(docs)}
    print(json.dumps(summary, indent=2))
    return 0


def cmd_discover(args: argparse.Namespace) -> int:
    db = _client()
    docs = _read_all(db)
    owned, problems = classify(args.run_id, docs)
    total = {col: len(ids) for col, ids in docs.items()}
    foreign = {col: total[col] - len(owned.get(col, [])) for col in COLLECTIONS}
    result = {
        "runId": args.run_id,
        "project": SMOKE_PROJECT,
        "database": SMOKE_DATABASE,
        "discoveredAt": datetime.now(UTC).isoformat(),
        "owned": owned,
        "foreignCounts": foreign,
        "problems": problems,
        "orphans": _orphans(docs),
    }
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2, ensure_ascii=False)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 1 if problems else 0


def cmd_cleanup(args: argparse.Namespace) -> int:
    settings = Settings()
    check_target(settings.firebase_project_id, settings.firestore_database_id, os.environ.get(EMULATOR_ENV), args.confirm_project)
    with open(args.manifest, encoding="utf-8") as fh:
        manifest = json.load(fh)
    if manifest.get("project") != SMOKE_PROJECT or manifest.get("database") != SMOKE_DATABASE:
        raise GuardError("Manifesto de outro projeto/banco.")
    db = create_firestore_client(settings)
    current, problems = classify(manifest["runId"], _read_all(db))
    problems += revalidate(manifest["owned"], current)
    if problems:
        print("LIMPEZA INTERROMPIDA, nada foi apagado:\n  " + "\n  ".join(problems))
        return 1
    deleted: dict[str, list[str]] = {}
    for col in DELETE_ORDER:
        for doc_id in manifest["owned"].get(col, []):
            db.collection(col).document(doc_id).delete()
            deleted.setdefault(col, []).append(doc_id)
            print(f"apagado {col}/{doc_id}")
    after = _read_all(db)
    leftover, _ = classify(manifest["runId"], after)
    report = {
        "cleanedAt": datetime.now(UTC).isoformat(),
        "deleted": deleted,
        "leftover": {c: ids for c, ids in leftover.items() if ids},
        "orphans": _orphans(after),
        "counts": _counts(db),
    }
    print(json.dumps(report, indent=2))
    return 0 if not report["leftover"] and not report["orphans"] else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("counts")
    d = sub.add_parser("discover")
    d.add_argument("--run-id", required=True)
    d.add_argument("--out")
    c = sub.add_parser("cleanup")
    c.add_argument("--manifest", required=True)
    c.add_argument("--confirm-project", required=True)
    args = parser.parse_args(argv)
    try:
        return {"counts": cmd_counts, "discover": cmd_discover, "cleanup": cmd_cleanup}[args.cmd](args)
    except GuardError as exc:
        print(f"RECUSADO: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
