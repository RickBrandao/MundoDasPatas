"""Fotos dos produtos (TASK 07A): validação do arquivo, autorização, associação, substituição,
remoção, limpeza de órfãos e falhas do Storage. Armazenamento em memória (sem rede)."""

import io
import struct
import time
from collections.abc import Iterator
from dataclasses import replace
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core.config import ImageStorage
from app.core.storage import StorageNotConfigured, check_storage_config
from app.main import create_app
from app.repositories.base import Repositories
from app.repositories.memory import MemoryState
from app.services.image_processing import MAX_UPLOAD_BYTES, InvalidImage, process_image, sniff_format
from app.services.images import IMAGE_PATH, ORPHAN_GRACE, ProductImageService, image_path, owned_by
from app.storage.firebase import TOKEN_METADATA, FirebaseObjectStore
from app.storage.memory import MemoryObjectStore
from tests.conftest import ADMIN, USER, build_client, category, default_verifier, make_settings, product

# --------------------------------------------------------------------- arquivos de exemplo


def make_image(fmt: str, size: tuple[int, int] = (320, 240), mode: str = "RGB", **save: Any) -> bytes:
    img = Image.new(mode, size, (200, 120, 40, 128) if mode == "RGBA" else (200, 120, 40))
    buf = io.BytesIO()
    img.save(buf, format=fmt, **save)
    return buf.getvalue()


JPEG = make_image("JPEG")
PNG = make_image("PNG", mode="RGBA")
WEBP = make_image("WEBP")
CT = {"image/jpeg": JPEG, "image/png": PNG, "image/webp": WEBP}


def png_header_only(width: int, height: int) -> bytes:
    """PNG válido no cabeçalho, com dimensões gigantes declaradas (decompression bomb)."""
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00" * 64)) + chunk(b"IEND", b"")


# --------------------------------------------------------------------- ambiente


@pytest.fixture
def store() -> MemoryObjectStore:
    return MemoryObjectStore()


@pytest.fixture
def seeded(state: MemoryState) -> MemoryState:
    state.categories["racoes"] = category("racoes", "Rações")
    state.products["p1"] = product("p1")
    state.products["p2"] = product("p2")
    return state


@pytest.fixture
def client(repos: Repositories, seeded: MemoryState, store: MemoryObjectStore) -> Iterator[TestClient]:
    settings = make_settings(firebase_project_id="demo-test", admin_allowed_uids="admin-uid-1")
    app = create_app(settings, repos, object_store=store)
    from app.api.dependencies import get_token_verifier

    app.dependency_overrides[get_token_verifier] = default_verifier
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def put(c: TestClient, pid: str, data: bytes, content_type: str = "image/jpeg", headers: dict[str, str] | None = None) -> Any:
    return c.put(
        f"/api/v1/admin/products/{pid}/image", content=data, headers={**ADMIN, "Content-Type": content_type, **(headers or {})}
    )


def stored_image(store: MemoryObjectStore, path: str) -> Image.Image:
    return Image.open(io.BytesIO(store.objects[path].data))


# --------------------------------------------------------------------- 1–3: formatos aceitos


@pytest.mark.parametrize("content_type", ["image/jpeg", "image/png", "image/webp"])
def test_valid_upload_is_reencoded_as_webp_and_associated(
    client: TestClient, store: MemoryObjectStore, seeded: MemoryState, content_type: str
) -> None:
    r = put(client, "p1", CT[content_type], content_type)
    assert r.status_code == 200, r.text
    body = r.json()
    p = seeded.products["p1"]
    # 10: associação produto ↔ objeto, caminho montado no servidor.
    assert IMAGE_PATH.fullmatch(p.image_path) and owned_by(p.image_path, "p1")
    assert body["imageUrl"] == p.image_url and p.image_path.replace("/", "%2F") in p.image_url
    assert "imagePath" not in body
    obj = store.objects[p.image_path]
    assert obj.content_type == "image/webp" and obj.cache_control.startswith("public")
    assert obj.metadata["productId"] == "p1"
    assert obj.metadata[TOKEN_METADATA] in p.image_url
    img = stored_image(store, p.image_path)
    assert img.format == "WEBP" and img.size == (320, 240)
    assert list(store.objects) == [p.image_path]


def test_png_transparency_is_preserved() -> None:
    out = process_image(PNG, "image/png")
    assert Image.open(io.BytesIO(out.data)).mode == "RGBA"


def test_large_image_is_reduced_and_metadata_is_stripped() -> None:
    exif = Image.Exif()
    exif[0x8825] = {2: (23.0, 33.0, 1.0)}  # GPSInfo
    exif[0x010F] = "Câmera do dono"
    raw = make_image("JPEG", size=(3000, 1500), exif=exif.tobytes())
    assert b"Exif" in raw
    out = process_image(raw, "image/jpeg")
    img = Image.open(io.BytesIO(out.data))
    assert max(img.size) == 1600 and img.size == (1600, 800)
    assert not img.getexif() and b"Exif" not in out.data and "icc_profile" not in img.info


def test_exif_orientation_is_applied() -> None:
    exif = Image.Exif()
    exif[0x0112] = 6  # girar 90°
    out = process_image(make_image("JPEG", size=(300, 100), exif=exif.tobytes()), "image/jpeg")
    assert (out.width, out.height) == (100, 300)


# --------------------------------------------------------------------- 4–6: arquivos recusados


def test_file_above_limit_is_rejected_before_processing(client: TestClient, store: MemoryObjectStore) -> None:
    big = JPEG + b"\x00" * (MAX_UPLOAD_BYTES + 1 - len(JPEG))
    r = put(client, "p1", big)
    assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"
    assert store.objects == {}


def test_declared_content_length_above_limit_is_rejected(client: TestClient) -> None:
    r = put(client, "p1", JPEG, headers={"Content-Length": str(MAX_UPLOAD_BYTES + 1)})
    assert r.status_code == 413


@pytest.mark.parametrize(
    ("content_type", "data"),
    [
        ("image/png", b"isto nao e uma imagem" * 10),
        ("image/jpeg", PNG),  # assinatura de outro formato
        ("image/webp", b"RIFF\x00\x00\x00\x00WEBPVP8 lixo"),  # cabeçalho válido, conteúdo corrompido
        ("image/jpeg", JPEG[: len(JPEG) // 2]),  # truncado
        ("image/png", b""),
    ],
)
def test_image_extension_with_invalid_content_is_rejected(
    client: TestClient, store: MemoryObjectStore, seeded: MemoryState, content_type: str, data: bytes
) -> None:
    r = put(client, "p1", data, content_type)
    assert r.status_code == 422
    assert r.json()["error"]["fieldErrors"]["image"]
    assert store.objects == {} and seeded.products["p1"].image_url == ""


@pytest.mark.parametrize(
    ("content_type", "data"),
    [
        ("image/svg+xml", b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        ("text/html", b"<html><script>alert(1)</script></html>"),
        ("image/gif", b"GIF89a" + b"\x00" * 20),
        ("application/octet-stream", b"MZ\x90\x00executavel"),
        ("application/x-msdownload", b"MZ\x90\x00"),
        ("", JPEG),
    ],
)
def test_dangerous_types_are_rejected(client: TestClient, store: MemoryObjectStore, content_type: str, data: bytes) -> None:
    r = put(client, "p1", data, content_type)
    assert r.status_code == 415 and r.json()["error"]["code"] == "unsupported_media_type"
    assert store.objects == {}


@pytest.mark.parametrize(
    "data",
    [
        b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        b"<?php system($_GET['c']); ?>",
        b"MZ\x90\x00\x03\x00\x00\x00",
        JPEG[:3] + b"<script>alert(1)</script>",  # assinatura JPEG seguida de lixo
    ],
)
def test_dangerous_content_declared_as_image_is_rejected(data: bytes) -> None:
    with pytest.raises(InvalidImage):
        process_image(data, "image/jpeg")


def test_polyglot_payload_after_image_does_not_survive() -> None:
    out = process_image(JPEG + b"<script>alert(1)</script>", "image/jpeg")
    assert b"<script>" not in out.data and out.data.startswith(b"RIFF")


def test_decompression_bomb_is_rejected_without_decoding() -> None:
    bomb = png_header_only(30_000, 30_000)
    started = time.perf_counter()
    with pytest.raises(InvalidImage, match="Dimensões"):
        process_image(bomb, "image/png")
    assert time.perf_counter() - started < 1


def test_animated_image_is_rejected() -> None:
    frames = [Image.new("RGB", (40, 40), c) for c in ((255, 0, 0), (0, 255, 0))]
    buf = io.BytesIO()
    frames[0].save(buf, format="WEBP", save_all=True, append_images=frames[1:])
    with pytest.raises(InvalidImage, match="animadas"):
        process_image(buf.getvalue(), "image/webp")


def test_sniff_format() -> None:
    assert (sniff_format(JPEG), sniff_format(PNG), sniff_format(WEBP)) == ("JPEG", "PNG", "WEBP")
    assert sniff_format(b"GIF89a") is None


# --------------------------------------------------------------------- 7–9: autorização e produto


def test_upload_without_token_is_rejected_before_reading_body(client: TestClient, store: MemoryObjectStore) -> None:
    r = client.put("/api/v1/admin/products/p1/image", content=JPEG, headers={"Content-Type": "image/jpeg"})
    assert r.status_code == 401
    assert store.objects == {}


def test_upload_by_non_admin_is_forbidden(client: TestClient, store: MemoryObjectStore) -> None:
    for method in ("PUT", "DELETE"):
        r = client.request(
            method, "/api/v1/admin/products/p1/image", content=JPEG, headers={**USER, "Content-Type": "image/jpeg"}
        )
        assert r.status_code == 403
    assert store.objects == {}


def test_upload_to_missing_product_stores_nothing(client: TestClient, store: MemoryObjectStore) -> None:
    r = put(client, "nao-existe", JPEG)
    assert r.status_code == 404
    assert store.objects == {}


@pytest.mark.parametrize("pid", ["..%2Fp2", "p1%2F..%2Fp2", "p%2E1", "a" * 65])
def test_product_id_cannot_shape_the_storage_path(client: TestClient, store: MemoryObjectStore, pid: str) -> None:
    r = put(client, pid, JPEG)
    assert r.status_code in (404, 422)
    assert store.objects == {}


def test_image_path_helpers() -> None:
    assert image_path("p1", "a" * 32) == f"products/p1/images/{'a' * 32}.webp"
    with pytest.raises(ValueError):
        image_path("../p2", "a" * 32)
    assert not owned_by(f"products/p2/images/{'a' * 32}.webp", "p1")
    assert not owned_by("products/p1/outra-coisa.txt", "p1")


# --------------------------------------------------------------------- 11–13: substituição e remoção


def test_replacement_deletes_only_the_previous_object(client: TestClient, store: MemoryObjectStore, seeded: MemoryState) -> None:
    assert put(client, "p2", JPEG).status_code == 200
    other = seeded.products["p2"].image_path
    assert put(client, "p1", JPEG).status_code == 200
    first = seeded.products["p1"].image_path
    r = put(client, "p1", PNG, "image/png")
    assert r.status_code == 200
    second = seeded.products["p1"].image_path
    assert second != first and r.json()["imageUrl"] == seeded.products["p1"].image_url
    assert set(store.objects) == {other, second}


@pytest.mark.parametrize("failing", ["put"])
def test_storage_failure_during_replacement_keeps_previous_image(
    client: TestClient, store: MemoryObjectStore, seeded: MemoryState, failing: str
) -> None:
    assert put(client, "p1", JPEG).status_code == 200
    before = seeded.products["p1"]
    store.fail_next(failing)
    r = put(client, "p1", PNG, "image/png")
    assert r.status_code == 503 and r.json()["error"]["code"] == "storage_unavailable"
    assert seeded.products["p1"] == before
    assert set(store.objects) == {before.image_path}


def test_database_failure_during_replacement_discards_new_object(
    repos: Repositories, seeded: MemoryState, store: MemoryObjectStore
) -> None:
    service = ProductImageService(repos, store)
    before = service.upload("p1", JPEG, "image/jpeg")

    class FailingInventory:
        def run_in_transaction(self, _: Any) -> Any:
            from app.core.firestore import DatabaseUnavailable

            raise DatabaseUnavailable()

    broken = ProductImageService(replace(repos, inventory=FailingInventory()), store)
    from app.core.firestore import DatabaseUnavailable

    with pytest.raises(DatabaseUnavailable):
        broken.upload("p1", PNG, "image/png")
    assert seeded.products["p1"] == before
    assert set(store.objects) == {before.image_path}


def test_uncertain_commit_keeps_the_object_the_product_points_to(
    repos: Repositories, seeded: MemoryState, store: MemoryObjectStore
) -> None:
    """Gravou no banco, mas a resposta falhou: o objeto novo não pode ser excluído."""

    class CommitThenFail:
        def run_in_transaction(self, op: Any) -> Any:
            repos.inventory.run_in_transaction(op)
            raise RuntimeError("conexão perdida após o commit")

    service = ProductImageService(replace(repos, inventory=CommitThenFail()), store)
    with pytest.raises(RuntimeError):
        service.upload("p1", JPEG, "image/jpeg")
    path = seeded.products["p1"].image_path
    assert path and set(store.objects) == {path}


def test_failure_deleting_previous_object_keeps_the_new_image(
    client: TestClient, store: MemoryObjectStore, seeded: MemoryState
) -> None:
    assert put(client, "p1", JPEG).status_code == 200
    old = seeded.products["p1"].image_path
    store.fail_next("delete")
    assert put(client, "p1", PNG, "image/png").status_code == 200
    new = seeded.products["p1"].image_path
    # A foto anterior virou órfã (removida depois pela limpeza); a nova está associada.
    assert set(store.objects) == {old, new}


def test_previous_path_outside_product_prefix_is_never_deleted(
    repos: Repositories, seeded: MemoryState, store: MemoryObjectStore
) -> None:
    foreign = f"products/p2/images/{'b' * 32}.webp"
    store.put(foreign, b"x", content_type="image/webp", cache_control="", metadata={"productId": "p2"})
    seeded.products["p1"] = replace(seeded.products["p1"], image_path=foreign, image_url="https://x")
    ProductImageService(repos, store).upload("p1", JPEG, "image/jpeg")
    assert foreign in store.objects


def test_remove_image(client: TestClient, store: MemoryObjectStore, seeded: MemoryState) -> None:
    assert put(client, "p1", JPEG).status_code == 200
    r = client.delete("/api/v1/admin/products/p1/image", headers=ADMIN)
    assert r.status_code == 200 and r.json()["imageUrl"] == ""
    assert seeded.products["p1"].image_path == "" and store.objects == {}
    # Repetir é seguro (sem foto: nada muda).
    again = client.delete("/api/v1/admin/products/p1/image", headers=ADMIN)
    assert again.status_code == 200 and again.json()["imageUrl"] == ""
    assert client.delete("/api/v1/admin/products/nao-existe/image", headers=ADMIN).status_code == 404


def test_remove_clears_legacy_external_url(client: TestClient, seeded: MemoryState, store: MemoryObjectStore) -> None:
    seeded.products["p1"] = replace(seeded.products["p1"], image_url="https://cdn.example/x.jpg")
    assert client.delete("/api/v1/admin/products/p1/image", headers=ADMIN).json()["imageUrl"] == ""


# --------------------------------------------------------------------- 14: limpeza de órfãos


def test_orphan_cleanup_only_deletes_proven_old_orphans(
    repos: Repositories, seeded: MemoryState, store: MemoryObjectStore
) -> None:
    service = ProductImageService(repos, store)
    current = service.upload("p1", JPEG, "image/jpeg").image_path
    old = f"products/p1/images/{'1' * 32}.webp"
    recent = f"products/p1/images/{'2' * 32}.webp"
    gone = f"products/apagado/images/{'3' * 32}.webp"
    no_owner = f"products/p2/images/{'4' * 32}.webp"
    foreign = "outros/arquivo.pdf"
    odd = "products/p1/images/manual.jpg"
    for path, owner in [(old, "p1"), (recent, "p1"), (gone, "apagado"), (no_owner, "p9"), (foreign, "p1"), (odd, "p1")]:
        store.put(path, b"x", content_type="image/webp", cache_control="", metadata={"productId": owner})
    past = store.objects[current].created_at - ORPHAN_GRACE - timedelta(minutes=1)
    for path in (old, gone, no_owner, foreign, odd, current):
        store.objects[path].created_at = past

    preview = service.cleanup_orphans(dry_run=True)
    assert sorted(preview.deleted) == sorted([old, gone]) and len(store.objects) == 7

    report = service.cleanup_orphans(dry_run=False)
    assert sorted(report.deleted) == sorted([old, gone])
    assert sorted(report.kept) == sorted([current, recent])
    # Fora de `products/` nem é listado; no prefixo, sem prova de propriedade, é ignorado.
    assert sorted(report.ignored) == sorted([no_owner, odd])
    assert set(store.objects) == {current, recent, no_owner, foreign, odd}
    assert service.cleanup_orphans(product_id="p1", dry_run=False).deleted == []


# --------------------------------------------------------------------- 15–17: sem foto, vitrine e indisponibilidade


def test_product_without_image_and_public_catalog_shows_uploaded_photo(client: TestClient, seeded: MemoryState) -> None:
    catalog = client.get("/api/v1/public/catalog").json()
    assert {p["id"]: p["imageUrl"] for p in catalog["products"]} == {"p1": "", "p2": ""}
    put(client, "p1", JPEG)
    # Vitrine sem login: a URL pública de download vem no catálogo; nenhum dado interno da foto.
    public = client.get("/api/v1/public/products/p1").json()
    assert public["imageUrl"] == seeded.products["p1"].image_url and "?alt=media&token=" in public["imageUrl"]
    assert "imagePath" not in public


def test_upload_unavailable_when_storage_disabled(repos: Repositories, seeded: MemoryState) -> None:
    with build_client(repos=repos, verifier=default_verifier()) as c:
        assert c.get("/api/v1/admin/images/config", headers=ADMIN).json()["available"] is False
        r = put(c, "p1", JPEG)
        assert r.status_code == 503 and r.json()["error"]["code"] == "storage_unavailable"
        # Produtos continuam podendo ser cadastrados sem foto.
        created = c.post("/api/v1/admin/products", json={"name": "Sem Foto", "categoryId": "racoes"}, headers=ADMIN)
        assert created.status_code == 201 and created.json()["imageUrl"] == ""
        assert c.get("/health").json()["dependencies"]["storage"]["status"] == "disabled"


def test_image_config_reports_limits(client: TestClient) -> None:
    body = client.get("/api/v1/admin/images/config", headers=ADMIN).json()
    assert body == {
        "available": True,
        "maxBytes": MAX_UPLOAD_BYTES,
        "acceptedTypes": ["image/jpeg", "image/png", "image/webp"],
        "maxSide": 1600,
    }


def test_storage_connection_failure_is_503_quickly(repos: Repositories, seeded: MemoryState) -> None:
    """Cliente real do google-cloud-storage apontado para uma porta local fechada."""
    settings = make_settings(
        firebase_project_id="demo-test",
        admin_allowed_uids="admin-uid-1",
        image_storage="firebase",
        firebase_storage_bucket="demo-test.firebasestorage.app",
        firebase_storage_emulator_host="127.0.0.1:9",
    )
    app = create_app(settings, repos)
    from app.api.dependencies import get_token_verifier

    app.dependency_overrides[get_token_verifier] = default_verifier
    with TestClient(app, raise_server_exceptions=False) as c:
        started = time.perf_counter()
        r = put(c, "p1", JPEG)
        assert r.status_code == 503 and r.json()["error"]["code"] == "storage_unavailable"
        assert time.perf_counter() - started < 30
        assert seeded.products["p1"].image_url == ""


# --------------------------------------------------------------------- foto só pelas rotas de imagem


def test_product_payload_cannot_set_arbitrary_image_url(client: TestClient, seeded: MemoryState) -> None:
    r = client.patch("/api/v1/admin/products/p1", json={"imageUrl": "https://evil.example/x.png"}, headers=ADMIN)
    assert r.status_code == 422 and "imageUrl" in r.json()["error"]["fieldErrors"]
    created = client.post(
        "/api/v1/admin/products",
        json={"name": "Com URL", "categoryId": "racoes", "imageUrl": "https://x.example/a.png"},
        headers=ADMIN,
    )
    assert created.status_code == 422
    put(client, "p1", JPEG)
    url = seeded.products["p1"].image_url
    # Reenviar a URL atual (formulário inteiro) não muda nada.
    same = client.patch("/api/v1/admin/products/p1", json={"imageUrl": url, "name": "Novo Nome"}, headers=ADMIN)
    assert same.status_code == 200 and seeded.products["p1"].image_path


# --------------------------------------------------------------------- configuração (fail-closed)


def storage_settings(**over: Any) -> Any:
    base: dict[str, Any] = {
        "firebase_project_id": "demo-test",
        "image_storage": "firebase",
        "firebase_storage_bucket": "demo-test.firebasestorage.app",
    }
    return make_settings(**(base | over))


@pytest.mark.parametrize(
    "over",
    [
        {"image_storage": "disabled"},
        {"firebase_storage_bucket": None},
        # Emulador do Storage com o Firestore real: URLs locais iriam para o banco real.
        {"firebase_storage_emulator_host": "127.0.0.1:9199", "data_backend": "firestore"},
        # Storage real com dados efêmeros ou no emulador: objetos reais ficariam órfãos.
        {"data_backend": "memory"},
        {"data_backend": "firestore", "firestore_emulator_host": "127.0.0.1:8181"},
    ],
)
def test_invalid_storage_combinations_fail_closed(over: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", over.get("firestore_emulator_host", "") or "")
    with pytest.raises(StorageNotConfigured):
        check_storage_config(storage_settings(**over))
    assert FirebaseObjectStore(storage_settings(**over)).ready() is False


def test_real_storage_refuses_library_emulator_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STORAGE_EMULATOR_HOST", "http://127.0.0.1:9199")
    with pytest.raises(StorageNotConfigured):
        check_storage_config(storage_settings(data_backend="firestore"))


def test_valid_storage_modes() -> None:
    assert check_storage_config(storage_settings(firebase_storage_emulator_host="127.0.0.1:9199")) == "emulator"
    assert check_storage_config(storage_settings(data_backend="firestore")) == "real"


def test_public_urls_point_to_firebase_download_endpoint() -> None:
    real = FirebaseObjectStore(storage_settings(data_backend="firestore"))
    assert real.public_url("products/p1/images/x.webp", "tok") == (
        "https://firebasestorage.googleapis.com/v0/b/demo-test.firebasestorage.app/o/products%2Fp1%2Fimages%2Fx.webp?alt=media&token=tok"
    )
    emu = FirebaseObjectStore(storage_settings(firebase_storage_emulator_host="127.0.0.1:9199"))
    assert emu.public_url("products/p1/images/x.webp", "tok").startswith("http://127.0.0.1:9199/v0/b/")


@pytest.mark.parametrize("env", ["staging", "production"])
def test_deployed_environments_refuse_storage_emulator_and_missing_bucket(env: str) -> None:
    from pydantic import ValidationError

    deployed = {
        "app_env": env,
        "data_backend": "firestore",
        "firebase_project_id": "real",
        "cors_origins": "https://loja.example",
    }
    with pytest.raises(ValidationError, match="FIREBASE_STORAGE_EMULATOR_HOST"):
        make_settings(
            **deployed,
            image_storage="firebase",
            firebase_storage_bucket="real.firebasestorage.app",
            firebase_storage_emulator_host="127.0.0.1:9199",
        )
    with pytest.raises(ValidationError, match="FIREBASE_STORAGE_BUCKET"):
        make_settings(**deployed, image_storage="firebase")
    assert make_settings(**deployed).image_storage is ImageStorage.DISABLED


@pytest.mark.parametrize("bucket", ["gs://b", "b/x", "B", "a"])
def test_bucket_name_is_validated(bucket: str) -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        make_settings(firebase_storage_bucket=bucket)


def test_health_reports_storage_emulator() -> None:
    settings = storage_settings(firebase_storage_emulator_host="127.0.0.1:9199")
    with build_client(settings) as c:
        assert c.get("/health").json()["dependencies"]["storage"]["status"] == "emulator"


def test_firestore_codec_keeps_image_path_and_reads_legacy_documents() -> None:
    from app.repositories import firestore_codec as codec

    p = product("p1", image_url="https://x/y", image_path=f"products/p1/images/{'a' * 32}.webp")
    doc = codec.product_to_doc(p)
    assert codec.product_from_doc("p1", doc) == p
    del doc["image_path"]  # produto gravado antes da TASK 07A
    assert codec.product_from_doc("p1", doc).image_path == ""


def test_cleanup_script_refuses_unconfigured_storage_and_unconfirmed_apply(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from scripts import storage_cleanup

    monkeypatch.setenv("IMAGE_STORAGE", "disabled")
    assert storage_cleanup.main([]) == 2
    monkeypatch.setenv("IMAGE_STORAGE", "firebase")
    monkeypatch.setenv("FIREBASE_PROJECT_ID", "demo-test")
    monkeypatch.setenv("FIREBASE_STORAGE_BUCKET", "demo-test.firebasestorage.app")
    monkeypatch.setenv("FIREBASE_STORAGE_EMULATOR_HOST", "127.0.0.1:9")
    assert storage_cleanup.main(["--apply", "--confirm-bucket", "outro-bucket"]) == 2
    assert "Nada foi excluído" in capsys.readouterr().out
