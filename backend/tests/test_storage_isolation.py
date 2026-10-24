"""Isolamento entre projetos no Cloud Storage (TASK 07B.1, P1 da auditoria da TASK 07A).

Antes da correção, `FIREBASE_PROJECT_ID=mundo-das-patas---dev` com `FIREBASE_STORAGE_BUCKET=other-project.appspot.com`
era aceito como Storage real. Agora só o bucket padrão do próprio projeto passa, e credenciais de outro
projeto são recusadas — antes de criar o cliente, de ler o produto ou de abrir transação.

Sem rede: o `FirebaseObjectStore` real recebe um bucket espião que registra qualquer acesso.
"""

import json
import logging
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.storage import StorageNotConfigured, check_storage_config
from app.main import create_app
from app.repositories.base import Repositories
from app.repositories.memory import MemoryState
from app.storage.firebase import FirebaseObjectStore
from app.storage.memory import MemoryObjectStore
from tests.conftest import ADMIN, category, default_verifier, make_settings, product
from tests.test_images import JPEG

DEV = "mundo-das-patas---dev"
DEV_BUCKET = f"{DEV}.firebasestorage.app"
SECRET = "SEGREDO-NAO-PODE-VAZAR"


def service_account(project: str) -> str:
    return json.dumps(
        {
            "type": "service_account",
            "project_id": project,
            "client_email": f"x@{project}.iam.gserviceaccount.com",
            "private_key": SECRET,
        }
    )


def real(**over: Any) -> Any:
    """Storage real do projeto Dev (Firestore real); nada aqui abre conexão."""
    base: dict[str, Any] = {
        "data_backend": "firestore",
        "firebase_project_id": DEV,
        "admin_allowed_uids": "admin-uid-1",
        "image_storage": "firebase",
        "firebase_storage_bucket": DEV_BUCKET,
    }
    return make_settings(**(base | over))


def refused(settings: Any) -> bool:
    try:
        check_storage_config(settings)
    except StorageNotConfigured:
        return True
    return False


# --------------------------------------------------------------------- 1–4: nome do bucket


def test_dev_default_bucket_is_accepted() -> None:
    assert check_storage_config(real()) == "real"


@pytest.mark.parametrize(
    "bucket",
    [
        "other-project.appspot.com",  # reprodução do P1
        "other-project.firebasestorage.app",
        f"{DEV}.appspot.com",  # legado: o projeto não tem, e não é aceito silenciosamente
        f"x{DEV}.firebasestorage.app",
        f"{DEV}.firebasestorage.app.evil",
        f"{DEV}-fotos",
    ],
)
def test_bucket_of_another_project_or_legacy_is_refused(bucket: str, caplog: pytest.LogCaptureFixture) -> None:
    settings = real(firebase_storage_bucket=bucket)
    assert refused(settings)
    assert FirebaseObjectStore(settings).ready() is False
    assert "bucket padrão" in caplog.text


def test_empty_bucket_is_refused_with_real_storage() -> None:
    assert refused(real(firebase_storage_bucket=None))
    assert refused(real(firebase_storage_bucket="   "))


# --------------------------------------------------------------------- 5–7: credenciais


def test_explicit_service_account_of_the_project_is_accepted() -> None:
    assert check_storage_config(real(firebase_service_account_json=service_account(DEV))) == "real"


@pytest.mark.parametrize(
    "raw",
    [
        service_account("other-project"),
        json.dumps({"type": "service_account", "client_email": "x@y", "private_key": SECRET}),  # sem project_id
        json.dumps({"type": "authorized_user", "quota_project_id": DEV, "refresh_token": SECRET}),
        "{não é json " + SECRET,
    ],
    ids=["outro-projeto", "sem-project_id", "authorized_user", "json-invalido"],
)
def test_explicit_credential_of_another_project_is_refused(raw: str, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    assert refused(real(firebase_service_account_json=raw))
    assert SECRET not in caplog.text


def write_adc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, info: dict[str, Any] | str) -> None:
    path = tmp_path / "adc.json"
    path.write_text(info if isinstance(info, str) else json.dumps(info), encoding="utf-8")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(path))


@pytest.mark.parametrize("quota", [None, DEV, "other-project"])
def test_adc_authorized_user_is_accepted_and_quota_project_is_not_trusted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, quota: str | None
) -> None:
    """ADC do gcloud não identifica o dono: aceito sem confiar em `quota_project_id` (nem para aceitar, nem para recusar)."""
    info: dict[str, Any] = {"type": "authorized_user", "client_id": "c", "client_secret": SECRET, "refresh_token": SECRET}
    if quota:
        info["quota_project_id"] = quota
    write_adc(tmp_path, monkeypatch, info)
    assert check_storage_config(real()) == "real"


def test_adc_without_file_is_accepted() -> None:
    # Arquivo padrão do gcloud (authorized_user): mesmo comportamento; a posse é conferida na ativação.
    assert check_storage_config(real()) == "real"


def test_adc_service_account_file_must_match_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    write_adc(tmp_path, monkeypatch, json.loads(service_account(DEV)))
    assert check_storage_config(real()) == "real"
    write_adc(tmp_path, monkeypatch, json.loads(service_account("other-project")))
    assert refused(real())
    write_adc(tmp_path, monkeypatch, "{corrompido " + SECRET)
    assert refused(real())
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(tmp_path / "nao-existe.json"))
    assert refused(real())
    assert SECRET not in caplog.text


# --------------------------------------------------------------------- 8–9: nenhuma operação no bucket errado


class SpyBucket:
    """Bucket falso: registra qualquer acesso (o bucket errado não pode ser tocado)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def __call__(self) -> "SpyBucket":
        self.calls.append(("bucket", ""))
        return self

    def blob(self, path: str) -> "SpyBlob":
        return SpyBlob(self, path)


class SpyBlob:
    def __init__(self, bucket: SpyBucket, path: str) -> None:
        self.bucket, self.name = bucket, path
        self.cache_control: str | None = None
        self.metadata: dict[str, str] | None = None

    def upload_from_string(self, data: bytes, **_: Any) -> None:
        self.bucket.calls.append(("upload", self.name))

    def delete(self, **_: Any) -> None:
        self.bucket.calls.append(("delete", self.name))


@pytest.fixture
def seeded(state: MemoryState) -> MemoryState:
    state.categories["racoes"] = category("racoes", "Rações")
    image = f"products/p1/images/{'a' * 32}.webp"
    state.products["p1"] = product("p1", image_url="https://x/foto.webp", image_path=image)
    state.products["p2"] = product("p2")
    return state


def api(settings: Any, repos: Repositories, spy: SpyBucket) -> TestClient:
    app = create_app(settings, repos, object_store=FirebaseObjectStore(settings, bucket=spy))
    from app.api.dependencies import get_token_verifier

    app.dependency_overrides[get_token_verifier] = default_verifier
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def wrong(repos: Repositories, seeded: MemoryState) -> Iterator[tuple[TestClient, SpyBucket]]:
    spy = SpyBucket()
    with api(real(firebase_storage_bucket="other-project.appspot.com"), repos, spy) as c:
        yield c, spy


def test_upload_with_wrong_bucket_creates_nothing(wrong: tuple[TestClient, SpyBucket], seeded: MemoryState) -> None:
    c, spy = wrong
    before = dict(seeded.products)
    for pid in ("p1", "p2"):
        r = c.put(f"/api/v1/admin/products/{pid}/image", content=JPEG, headers={**ADMIN, "Content-Type": "image/jpeg"})
        assert r.status_code == 503 and r.json()["error"]["code"] == "storage_unavailable"
    assert spy.calls == []
    assert seeded.products == before
    assert c.get("/api/v1/admin/images/config", headers=ADMIN).json()["available"] is False
    assert c.get("/health").json()["dependencies"]["storage"]["status"] == "not_configured"


def test_remove_with_wrong_bucket_deletes_nothing_and_keeps_firestore(
    wrong: tuple[TestClient, SpyBucket], seeded: MemoryState
) -> None:
    c, spy = wrong
    before = seeded.products["p1"]
    r = c.delete("/api/v1/admin/products/p1/image", headers=ADMIN)
    assert r.status_code == 503 and r.json()["error"]["code"] == "storage_unavailable"
    assert spy.calls == []
    assert seeded.products["p1"] == before  # foto não foi desvinculada


def test_store_checks_configuration_before_every_operation() -> None:
    """Mesmo chamado direto (sem o serviço), o store não chega ao bucket com configuração recusada."""
    spy = SpyBucket()
    store = FirebaseObjectStore(real(firebase_storage_bucket="other-project.appspot.com"), bucket=spy)
    for op in (
        lambda: store.put("products/p1/images/x.webp", b"x", content_type="image/webp", cache_control="", metadata={}),
        lambda: store.delete("products/p1/images/x.webp"),
        lambda: store.list("products/"),
    ):
        with pytest.raises(StorageNotConfigured):
            op()
    assert spy.calls == []


def test_control_correct_bucket_reaches_the_bucket(repos: Repositories, seeded: MemoryState) -> None:
    """Controle positivo: com o bucket certo, o mesmo caminho chega ao bucket (a recusa acima não é acidental)."""
    spy = SpyBucket()
    with api(real(), repos, spy) as c:
        r = c.put("/api/v1/admin/products/p2/image", content=JPEG, headers={**ADMIN, "Content-Type": "image/jpeg"})
        assert r.status_code == 200
        assert r.json()["imageUrl"].startswith(f"https://firebasestorage.googleapis.com/v0/b/{DEV_BUCKET}/o/products%2Fp2%2F")
        assert c.delete("/api/v1/admin/products/p1/image", headers=ADMIN).status_code == 200
    ops = [op for op, _ in spy.calls if op != "bucket"]
    assert ops == ["upload", "delete"]
    assert seeded.products["p1"].image_path == ""


# --------------------------------------------------------------------- 10: script de limpeza


@pytest.fixture
def cleanup_env(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    from scripts import storage_cleanup

    built: dict[str, Any] = {"store": 0}
    store = MemoryObjectStore()

    def build_store(_: Any) -> MemoryObjectStore:
        built["store"] += 1
        return store

    monkeypatch.setattr(storage_cleanup, "build_object_store", build_store)
    from app.repositories.memory import create_memory_repositories

    monkeypatch.setattr(storage_cleanup, "build_repositories", lambda _: create_memory_repositories())
    for key, value in {
        "IMAGE_STORAGE": "firebase",
        "DATA_BACKEND": "firestore",
        "FIREBASE_PROJECT_ID": DEV,
        "FIREBASE_STORAGE_BUCKET": DEV_BUCKET,
    }.items():
        monkeypatch.setenv(key, value)
    return built


@pytest.mark.parametrize("bucket", ["other-project.appspot.com", f"{DEV}.appspot.com"])
def test_cleanup_script_refuses_wrong_bucket_even_when_confirmed(
    cleanup_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], bucket: str
) -> None:
    from scripts import storage_cleanup

    monkeypatch.setenv("FIREBASE_STORAGE_BUCKET", bucket)
    assert storage_cleanup.main([]) == 2
    assert storage_cleanup.main(["--apply", "--confirm-bucket", bucket]) == 2
    assert cleanup_env["store"] == 0  # nenhum cliente de Storage criado
    assert "Nada foi feito" in capsys.readouterr().out


def test_cleanup_script_refuses_credential_of_another_project(
    cleanup_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from scripts import storage_cleanup

    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_JSON", service_account("other-project"))
    assert storage_cleanup.main(["--apply", "--confirm-bucket", DEV_BUCKET]) == 2
    assert cleanup_env["store"] == 0
    assert SECRET not in capsys.readouterr().out


def test_cleanup_script_control_correct_configuration_runs_dry(
    cleanup_env: dict[str, Any], capsys: pytest.CaptureFixture[str]
) -> None:
    from scripts import storage_cleanup

    assert storage_cleanup.main([]) == 0
    assert cleanup_env["store"] == 1
    out = capsys.readouterr().out
    assert DEV_BUCKET in out and "Seriam excluídos: 0" in out


# --------------------------------------------------------------------- 11: emulador


def test_emulator_uses_the_default_bucket_of_the_demo_project() -> None:
    emu = {"firebase_project_id": "demo-test", "firebase_storage_emulator_host": "127.0.0.1:9199", "image_storage": "firebase"}
    assert check_storage_config(make_settings(**emu, firebase_storage_bucket="demo-test.firebasestorage.app")) == "emulator"
    assert refused(make_settings(**emu, firebase_storage_bucket="demo-test.appspot.com"))
    assert refused(make_settings(**emu, firebase_storage_bucket=DEV_BUCKET))  # bucket real com projeto de emulação


# --------------------------------------------------------------------- 12: ambientes publicados


DEPLOYED = {
    "app_env": "production",
    "data_backend": "firestore",
    "firebase_project_id": DEV,
    "cors_origins": "https://loja.example",
}


@pytest.mark.parametrize("env", ["staging", "production"])
@pytest.mark.parametrize(
    ("over", "message"),
    [
        ({"image_storage": "firebase", "firebase_storage_bucket": "other-project.appspot.com"}, "bucket padrão"),
        ({"image_storage": "firebase", "firebase_storage_bucket": f"{DEV}.appspot.com"}, "bucket padrão"),
        ({"firebase_service_account_json": service_account("other-project")}, "outro projeto"),
    ],
)
def test_deployed_environment_refuses_to_start(env: str, over: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message) as exc:
        make_settings(**(DEPLOYED | {"app_env": env} | over))
    assert SECRET not in str(exc.value)


def test_deployed_environment_accepts_consistent_configuration() -> None:
    s = make_settings(
        **DEPLOYED,
        image_storage="firebase",
        firebase_storage_bucket=DEV_BUCKET,
        firebase_service_account_json=service_account(DEV),
    )
    assert check_storage_config(s) == "real"
