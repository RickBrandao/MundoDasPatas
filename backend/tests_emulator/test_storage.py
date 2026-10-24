"""Fotos dos produtos no Storage Emulator + Firestore Emulator, com o cliente real (google-cloud-storage).

Executados por `npm run test:integration:emulator`, que define `FIREBASE_STORAGE_EMULATOR_HOST`
(e `E2E_REQUIRE_STORAGE=1`, que transforma a ausência do emulador em falha em vez de pulo).

Travas antes de qualquer escrita ou limpeza:
- host loopback, sem protocolo, que se identifica como o Storage Emulator (cabeçalho exclusivo);
- projeto `demo-*` e bucket do projeto de emulação;
- a limpeza usa `POST /internal/reset`, rota que só existe no emulador.

O que o emulador NÃO comprova (ver docs/storage.md): pré-condição `if_generation_match=0` no envio
(o emulador sobrescreve), IAM, CORS do bucket e o comportamento de CDN/cache do Firebase.
"""

import io
import os
import urllib.error
import urllib.request
from collections.abc import Iterator
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core.config import Settings
from app.repositories.base import Repositories
from app.services.images import ProductImageService, image_path
from app.storage.firebase import FirebaseObjectStore
from tests.conftest import ADMIN, NOW, build_client, category, default_verifier, make_settings, product
from tests_emulator.conftest import EMULATOR_PROJECT, LOOPBACK, put_docs

BUCKET = f"{EMULATOR_PROJECT}.firebasestorage.app"


def _request(method: str, url: str, data: bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, bytes, Any]:
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})  # noqa: S310 - loopback validado
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
            return resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), exc.headers


@pytest.fixture(scope="session")
def storage_host() -> str:
    host = os.environ.get("FIREBASE_STORAGE_EMULATOR_HOST", "")
    if not host:
        if os.environ.get("E2E_REQUIRE_STORAGE") == "1":
            pytest.exit("FIREBASE_STORAGE_EMULATOR_HOST ausente, mas o Storage Emulator é obrigatório nesta execução.", 2)
        pytest.skip("Storage Emulator não iniciado (FIREBASE_STORAGE_EMULATOR_HOST ausente).")
    if "://" in host or host.rsplit(":", 1)[0] not in LOOPBACK:
        pytest.exit(f"FIREBASE_STORAGE_EMULATOR_HOST precisa ser loopback host:porta (recebido {host!r}).", 2)
    _, _, headers = _request("GET", f"http://{host}/")
    if "x-firebase-storage-version" not in (headers.get("Access-Control-Expose-Headers") or ""):
        pytest.exit(f"{host} não respondeu como o Storage Emulator. Nada foi executado.", 2)
    assert EMULATOR_PROJECT.startswith("demo-")
    return host


@pytest.fixture
def st_settings(storage_host: str, fs_settings: Settings) -> Settings:
    settings = make_settings(
        data_backend="firestore",
        firebase_project_id=EMULATOR_PROJECT,
        admin_allowed_uids="admin-uid-1",
        image_storage="firebase",
        firebase_storage_bucket=BUCKET,
        firebase_storage_emulator_host=storage_host,
    )
    assert settings.firestore_emulator_host == fs_settings.firestore_emulator_host
    return settings


@pytest.fixture
def store(st_settings: Settings, storage_host: str) -> FirebaseObjectStore:
    status, _, _ = _request("POST", f"http://{storage_host}/internal/reset")
    assert status == 200
    s = FirebaseObjectStore(st_settings)
    assert s.ready()
    return s


@pytest.fixture
def seeded(db: Any) -> None:
    put_docs(db, categories=[category("racoes", "Rações")], products=[product("p1"), product("p2")])


@pytest.fixture
def api(st_settings: Settings, repos: Repositories, store: FirebaseObjectStore, seeded: None) -> Iterator[TestClient]:
    from app.main import create_app

    app = create_app(st_settings, repos, object_store=store)
    from app.api.dependencies import get_token_verifier

    app.dependency_overrides[get_token_verifier] = default_verifier
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def jpeg(color: tuple[int, int, int] = (10, 120, 200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (640, 480), color).save(buf, format="JPEG")
    return buf.getvalue()


def names(store: FirebaseObjectStore) -> set[str]:
    return {o.path for o in store.list("products/")}


def upload(api: TestClient, pid: str, data: bytes | None = None) -> dict[str, Any]:
    r = api.put(f"/api/v1/admin/products/{pid}/image", content=data or jpeg(), headers={**ADMIN, "Content-Type": "image/jpeg"})
    assert r.status_code == 200, r.text
    return r.json()


def stored_path(repos: Repositories, pid: str) -> str:
    p = repos.products.get(pid)
    assert p is not None
    return p.image_path


def test_upload_persists_in_storage_and_firestore_and_is_public(
    api: TestClient, repos: Repositories, store: FirebaseObjectStore, storage_host: str
) -> None:
    body = upload(api, "p1")
    path = stored_path(repos, "p1")
    assert names(store) == {path}
    assert body["imageUrl"].startswith(f"http://{storage_host}/v0/b/{BUCKET}/o/products%2Fp1%2Fimages%2F")

    # Vitrine sem login: o catálogo público traz a URL, e o arquivo baixa sem credenciais.
    public = api.get("/api/v1/public/products/p1").json()
    status, content, headers = _request("GET", public["imageUrl"])
    assert status == 200 and headers.get("Content-Type") == "image/webp"
    assert Image.open(io.BytesIO(content)).format == "WEBP"
    assert "immutable" in (headers.get("Cache-Control") or "")


def test_storage_rules_block_direct_client_access(api: TestClient, repos: Repositories, storage_host: str) -> None:
    """Regras deny-all (storage.rules): sem token de download, nada é lido, listado, enviado ou excluído."""
    upload(api, "p1")
    encoded = stored_path(repos, "p1").replace("/", "%2F")
    base = f"http://{storage_host}/v0/b/{BUCKET}/o"
    assert _request("GET", f"{base}/{encoded}?alt=media")[0] == 403
    assert _request("GET", f"{base}/{encoded}?alt=media&token=token-errado")[0] == 403
    assert _request("GET", f"{base}?prefix=products%2F")[0] == 403
    assert _request("POST", f"{base}?name=products%2Fp1%2Fimages%2Fx.webp", b"x", {"Content-Type": "image/webp"})[0] == 403
    assert _request("DELETE", f"{base}/{encoded}")[0] == 403
    # Usuário Firebase autenticado (qualquer um) também não envia direto: só o FastAPI, com a allowlist.
    fake_user = {"Authorization": "Bearer owner-nao", "Content-Type": "image/webp"}
    assert _request("POST", f"{base}?name=products%2Fp1%2Fimages%2Fy.webp", b"x", fake_user)[0] in (401, 403)
    assert stored_path(repos, "p1")


def test_replacement_and_removal_clean_up_only_own_objects(
    api: TestClient, repos: Repositories, store: FirebaseObjectStore
) -> None:
    upload(api, "p2")
    other = stored_path(repos, "p2")
    upload(api, "p1")
    first = stored_path(repos, "p1")
    upload(api, "p1", jpeg((200, 30, 30)))
    second = stored_path(repos, "p1")
    assert second != first and names(store) == {other, second}

    r = api.delete("/api/v1/admin/products/p1/image", headers=ADMIN)
    assert r.status_code == 200 and r.json()["imageUrl"] == ""
    assert stored_path(repos, "p1") == "" and names(store) == {other}


def test_missing_product_creates_no_object(api: TestClient, store: FirebaseObjectStore) -> None:
    r = api.put("/api/v1/admin/products/nao-existe/image", content=jpeg(), headers={**ADMIN, "Content-Type": "image/jpeg"})
    assert r.status_code == 404 and names(store) == set()


def test_orphan_cleanup_with_real_object_dates(api: TestClient, repos: Repositories, store: FirebaseObjectStore) -> None:
    upload(api, "p1")
    current = stored_path(repos, "p1")
    orphan = image_path("p1", "f" * 32)
    store.put(orphan, b"x", content_type="image/webp", cache_control="", metadata={"productId": "p1"})
    service = ProductImageService(repos, store)
    # Dentro da carência: mantido (pode ser um envio em andamento).
    assert service.cleanup_orphans(dry_run=False).deleted == []
    report = service.cleanup_orphans(dry_run=False, grace=timedelta(0))
    assert report.deleted == [orphan] and report.kept == [current]
    assert names(store) == {current}


def test_health_reports_storage_emulator(st_settings: Settings, repos: Repositories) -> None:
    with build_client(st_settings, repos, verifier=default_verifier()) as c:
        assert c.get("/health").json()["dependencies"]["storage"]["status"] == "emulator"


def test_products_written_before_storage_support_still_load(db: Any, repos: Repositories) -> None:
    from app.repositories import firestore_codec as codec

    doc = codec.product_to_doc(product("antigo", created_at=NOW))
    del doc["image_path"]
    db.collection("products").document("antigo").set(doc)
    p = repos.products.get("antigo")
    assert p is not None and p.image_path == ""


def test_concurrent_replacements_and_removal_stay_consistent(
    repos: Repositories, store: FirebaseObjectStore, seeded: None
) -> None:
    """P3 da auditoria da TASK 07A: duas trocas e uma remoção simultâneas no mesmo produto, com outro
    produto tendo foto própria. A lógica transacional não muda; o teste trava o comportamento."""
    from concurrent.futures import ThreadPoolExecutor

    from app.core.errors import ApiError

    service = ProductImageService(repos, store)
    service.upload("p2", jpeg((0, 200, 0)), "image/jpeg")
    other = stored_path(repos, "p2")
    for round_ in range(3):
        service.upload("p1", jpeg((round_ * 40, 0, 0)), "image/jpeg")  # foto inicial a ser trocada
        ops = [
            lambda: service.upload("p1", jpeg((200, 0, 0)), "image/jpeg"),
            lambda: service.upload("p1", jpeg((0, 0, 200)), "image/jpeg"),
            lambda: service.remove("p1"),
        ]
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(op) for op in ops]
        errors = [f.exception() for f in futures if f.exception() is not None]
        # Disputa só pode aparecer como erro de API explícito (ex.: 503 database_busy), nunca escondida.
        assert all(isinstance(e, ApiError) for e in errors), errors
        assert len(errors) < len(ops)

        current = stored_path(repos, "p1")
        objects = names(store)
        # Referência coerente: sem foto, ou apontando para um objeto que existe e é do próprio produto.
        assert current == "" or (current in objects and current.startswith("products/p1/images/"))
        product_p1 = repos.products.get("p1")
        assert product_p1 is not None and bool(product_p1.image_url) == bool(current)
        # Sem exclusão cruzada: a foto do outro produto continua lá e continua sendo a dele.
        assert other in objects and stored_path(repos, "p2") == other
        assert _request("GET", store.public_url(other, _token(store, other)))[0] == 200

        # Objetos intermediários não referenciados são exatamente os que a limpeza identifica.
        extras = {p for p in objects if p.startswith("products/p1/")} - {current}
        report = service.cleanup_orphans(product_id="p1", dry_run=True, grace=timedelta(0))
        assert set(report.deleted) == extras
        service.cleanup_orphans(product_id="p1", dry_run=False, grace=timedelta(0))
        assert names(store) == {other} | ({current} if current else set())


def _token(store: FirebaseObjectStore, path: str) -> str:
    from app.storage.firebase import TOKEN_METADATA

    (obj,) = [o for o in store.list(path) if o.path == path]
    return obj.metadata[TOKEN_METADATA]
