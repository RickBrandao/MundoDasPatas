"""Verificação de conectividade com o Firestore configurado (real ou emulador).

    python -m scripts.firestore_check                     # SOMENTE LEITURA (padrão)
    python -m scripts.firestore_check --write-probe --confirm-project <FIREBASE_PROJECT_ID>

Somente leitura: mostra projeto, banco, modo (emulador/real) e a origem das credenciais (nunca os
valores), e conta os documentos de cada coleção da aplicação (sem ler conteúdo).

`--write-probe` (requer aprovação do proprietário do projeto): numa transação, cria um documento
temporário em `_smoke_tests/{id}`, lê de volta e o apaga. Não toca nas coleções de negócio, não
cria produtos/categorias de demonstração e exige repetir o ID do projeto em `--confirm-project`.
"""

import argparse
import os
import sys
import uuid
from datetime import UTC, datetime

from app.core.config import Settings
from app.core.firestore import EMULATOR_ENV, create_firestore_client
from app.repositories import firestore as fs

COLLECTIONS = (fs.CATEGORIES, fs.PRODUCTS, fs.SALES, fs.MOVEMENTS, fs.SETTINGS, fs.IDEMPOTENCY, fs.CATEGORY_CLAIMS)
PROBE_COLLECTION = "_smoke_tests"


def _credential_source(settings: Settings) -> str:
    if os.environ.get(EMULATOR_ENV):
        return "anônimas (emulador)"
    if settings.firebase_service_account_json is not None:
        return "FIREBASE_SERVICE_ACCOUNT_JSON (conteúdo não exibido)"
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        return "Application Default Credentials via GOOGLE_APPLICATION_CREDENTIALS (caminho não exibido)"
    return "Application Default Credentials (gcloud ou ambiente Google Cloud)"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--write-probe", action="store_true", help="grava e apaga um documento temporário")
    parser.add_argument("--confirm-project", help="obrigatório com --write-probe: o ID exato do projeto")
    args = parser.parse_args(argv)

    settings = Settings()
    emulator = os.environ.get(EMULATOR_ENV)
    print(f"Projeto:      {settings.firebase_project_id or '(não definido)'}")
    print(f"Banco:        {settings.firestore_database_id}")
    print(f"Modo:         {'EMULADOR ' + emulator if emulator else 'FIRESTORE REAL'}")
    print(f"Credenciais:  {_credential_source(settings)}")

    if args.write_probe and args.confirm_project != settings.firebase_project_id:
        print("\n--write-probe recusado: --confirm-project precisa ser exatamente o projeto acima. Nada foi gravado.")
        return 2

    try:
        db = create_firestore_client(settings)
        print("\nDocumentos por coleção (somente contagem):")
        for name in COLLECTIONS:
            total = int(db.collection(name).count().get()[0][0].value)
            print(f"  {name:<22} {total}")
        print(f"  settings/store existe: {db.collection(fs.SETTINGS).document(fs.SETTINGS_DOC).get().exists}")

        if args.write_probe:
            ref = db.collection(PROBE_COLLECTION).document(uuid.uuid4().hex)

            def probe(tx: object) -> None:
                tx.create(ref, {"created_at": datetime.now(UTC), "purpose": "firestore_check"})  # type: ignore[attr-defined]

            fs._transact(db, probe)
            assert ref.get().exists
            ref.delete()
            print(f"\nEscrita transacional OK: {PROBE_COLLECTION}/{ref.id} criado, lido e apagado.")
    except Exception as exc:  # noqa: BLE001 - ferramenta de diagnóstico: mostra só o tipo do erro
        code = getattr(getattr(exc, "code", None), "name", "") or getattr(exc, "code", "")
        print(f"\nFALHA: {type(exc).__name__} {code}".rstrip())
        return 1
    print("\nConectividade OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
