"""Limpeza de fotos órfãs no Cloud Storage (real ou emulador), conforme a configuração do ambiente.

    python -m scripts.storage_cleanup                                     # SIMULAÇÃO (padrão): só relata
    python -m scripts.storage_cleanup --apply --confirm-bucket <BUCKET>   # exclui

Recusa (sem criar cliente nem excluir nada) bucket que não seja o padrão do projeto
(`<FIREBASE_PROJECT_ID>.firebasestorage.app`) e credencial de outro projeto — `--confirm-bucket` não
contorna essas regras.

Só considera objetos `products/{productId}/images/{imageId}.webp` com metadado `productId` igual ao
do caminho, que não são a foto atual do produto (lida no Firestore) e criados há mais de 1 hora
(envios em andamento ficam de fora). Qualquer outro objeto do bucket é ignorado. Ver docs/storage.md.

`--apply` exige repetir o nome exato do bucket em `--confirm-bucket`.
"""

import argparse
import sys

from app.core.config import Settings
from app.core.errors import ApiError
from app.core.storage import check_storage_config
from app.main import build_object_store, build_repositories
from app.services.images import ProductImageService


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="exclui os órfãos (sem esta opção, só relata)")
    parser.add_argument("--confirm-bucket", help="obrigatório com --apply: o nome exato do bucket")
    parser.add_argument("--product", help="limita a um produto")
    args = parser.parse_args(argv)

    settings = Settings()
    try:
        mode = check_storage_config(settings)
    except ApiError:
        print("Storage não configurado ou combinação de ambientes recusada (ver docs/storage.md). Nada foi feito.")
        return 2
    # Daqui em diante projeto, bucket e credencial já foram conferidos (bucket padrão do próprio projeto).
    where = "EMULADOR" if mode == "emulator" else "STORAGE REAL"
    print(f"Projeto: {settings.firebase_project_id}  Bucket: {settings.firebase_storage_bucket} ({where})")
    if args.apply and args.confirm_bucket != settings.firebase_storage_bucket:
        print("--apply recusado: --confirm-bucket precisa ser exatamente o bucket acima. Nada foi excluído.")
        return 2

    service = ProductImageService(build_repositories(settings), build_object_store(settings))
    try:
        report = service.cleanup_orphans(product_id=args.product, dry_run=not args.apply)
    except ApiError as exc:
        print(f"Falha: {exc.message}")
        return 1
    verb = "Excluídos" if args.apply else "Seriam excluídos"
    counts = f"Mantidos: {len(report.kept)}  Ignorados: {len(report.ignored)}  Falhas: {len(report.failed)}"
    print(f"{verb}: {len(report.deleted)}  {counts}")
    for path in report.deleted:
        print(f"  - {path}")
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
