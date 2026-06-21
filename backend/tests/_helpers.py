"""Shared helpers for the integration tests (login + CSRF over TestClient).

These tests run against the local docker Postgres with the seed loaded, exactly
like test_auth.py. The seed password is the local `$SEED_DEMO_PASSWORD`.

Everything runs through ONE TestClient (one ASGI lifespan, one event loop): the
async engine + asyncpg connections are bound to the lifespan's loop, so a second
TestClient would run requests on a different loop and fail. To model multiple
users / devices, capture each login's cookies with `login_capture` and swap the
active identity with `restore` — the server-side session is what actually
distinguishes them, not the client object.
"""
from __future__ import annotations

SEED_PASSWORD = "ScribeDemo2026!"  # local $SEED_DEMO_PASSWORD (see test_auth.py)

PROVIDER = "dr.reed@northclinic.com"
OTHER_PROVIDER = "dr.okafor@northclinic.com"
ADMIN = "admin@northclinic.com"


def login_capture(client, email: str, password: str = SEED_PASSWORD) -> tuple[str, dict]:
    """Log in; return (csrf_token, captured auth cookies for this identity).

    Clears the jar first so only this login's cookies are present — otherwise a
    domain-less cookie left by `restore` collides with the fresh domained one.
    """
    client.cookies.clear()
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["csrf_token"], dict(client.cookies)


def restore(client, cookies: dict) -> None:
    """Make `client` act as the identity whose cookies were captured earlier."""
    client.cookies.clear()
    for k, v in cookies.items():
        client.cookies.set(k, v)


def csrf(token: str) -> dict[str, str]:
    return {"X-CSRF-Token": token}
