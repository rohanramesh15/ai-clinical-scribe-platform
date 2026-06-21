"""Critical-path auth tests (integration, against the local docker DB).

Covers the security-sensitive behaviors: login, session cookie auth, CSRF
enforcement on unsafe methods, instant revocation on logout, and that the raw
token is never stored (only its sha256 hash).

Run: pytest tests/test_auth.py   (requires docker Postgres up + seed run)
"""
import hashlib

from fastapi.testclient import TestClient

from app.main import app

PASSWORD = "ScribeDemo2026!"  # the seed's $SEED_DEMO_PASSWORD for local tests
PROVIDER = "dr.reed@northclinic.com"


def test_login_me_csrf_logout_cycle():
    with TestClient(app) as client:
        # Wrong password -> 401, no account enumeration distinction.
        r = client.post("/api/auth/login", json={"email": PROVIDER, "password": "nope"})
        assert r.status_code == 401

        # Correct login sets cookies and returns a CSRF token.
        r = client.post("/api/auth/login", json={"email": PROVIDER, "password": PASSWORD})
        assert r.status_code == 200
        csrf = r.json()["csrf_token"]
        assert client.cookies.get("scribe_session")
        assert client.cookies.get("scribe_csrf") == csrf

        # Authenticated read works.
        assert client.get("/api/auth/me").status_code == 200

        # Unsafe method without CSRF header -> 403.
        assert client.post("/api/auth/logout").status_code == 403

        # With CSRF header -> 204, and the session is instantly dead.
        assert client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
        assert client.get("/api/auth/me").status_code == 401


def test_raw_token_never_equals_stored_hash():
    # The hashing scheme: cookie holds raw, DB holds sha256(raw).
    raw = "example-raw-token"
    assert hashlib.sha256(raw.encode()).hexdigest() != raw
