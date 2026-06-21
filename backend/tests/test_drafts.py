"""Draft-persistence edge cases (the two non-happy paths that were untested).

1. Cross-device draft restore: a draft saved in one session is restored, exactly,
   after logging in again (a fresh session = a different browser/device) —
   proving drafts live in RDS, not the browser, and that provider isolation still
   holds across devices.

2. Admin deactivates a provider who has a draft open: the provider's live session
   is instantly revoked (403 account_deactivated), an in-flight autosave/save is
   rejected (no silent data loss), the draft is preserved in RDS, and it is
   recovered intact after the account is reactivated.

All work runs through one TestClient (see _helpers); identities are swapped via
captured cookies, since the server-side session is what distinguishes them.

Run: pytest tests/test_drafts.py  (docker Postgres up + seed run)
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from _helpers import ADMIN, OTHER_PROVIDER, PROVIDER, csrf, login_capture, restore
from app.main import app

DRAFT_TRANSCRIPT = "Pt reports 3 days of productive cough and low-grade fever."
DRAFT_NOTE = {
    "subjective": "3 days productive cough, subjective fever.",
    "objective": "",
    "assessment": "",
    "plan": "",
    "codes": [],
}


def _patient() -> dict:
    return {"first_name": "Draft", "last_name": "Restore", "dob": "1981-07-03"}


def _start_draft(client, token: str) -> int:
    """Create an encounter and autosave an in-progress draft; return its id."""
    r = client.post("/api/encounters", json=_patient(), headers=csrf(token))
    assert r.status_code == 201, r.text
    enc_id = r.json()["id"]
    r = client.patch(
        f"/api/encounters/{enc_id}",
        json={"transcript": DRAFT_TRANSCRIPT, "working_note": DRAFT_NOTE},
        headers=csrf(token),
    )
    assert r.status_code == 200, r.text
    return enc_id


def test_cross_device_draft_restore():
    with TestClient(app) as client:  # one lifespan / one event loop
        # Device A: provider starts an encounter and autosaves a draft.
        token_a, _ = login_capture(client, PROVIDER)
        enc_id = _start_draft(client, token_a)

        # Device B: a fresh login = a new server session, like another browser.
        login_capture(client, PROVIDER)
        body = client.get(f"/api/encounters/{enc_id}").json()
        assert body["status"] == "draft"
        assert body["transcript"] == DRAFT_TRANSCRIPT
        assert body["working_note"] == DRAFT_NOTE  # restored exactly, from RDS

        # Isolation still holds across devices: a different provider can't read it.
        login_capture(client, OTHER_PROVIDER)
        assert client.get(f"/api/encounters/{enc_id}").status_code == 404


def test_deactivation_with_open_draft_revokes_access_and_preserves_draft():
    new_email = f"deact-{uuid.uuid4().hex[:8]}@northclinic.com"

    with TestClient(app) as client:  # one lifespan / one event loop
        acsrf, admin = login_capture(client, ADMIN)

        # Admin provisions a fresh provider (avoids mutating the seed accounts).
        r = client.post(
            "/api/admin/providers",
            json={"email": new_email, "role": "provider"},
            headers=csrf(acsrf),
        )
        assert r.status_code == 201, r.text
        new_id = r.json()["provider"]["id"]
        temp_password = r.json()["temp_password"]

        # That provider logs in (workspace "open") and saves an in-progress draft.
        ptoken, provider = login_capture(client, new_email, temp_password)
        enc_id = _start_draft(client, ptoken)

        # Admin deactivates the provider mid-session; all its sessions are revoked.
        restore(client, admin)
        r = client.post(f"/api/admin/providers/{new_id}/deactivate", headers=csrf(acsrf))
        assert r.status_code == 200, r.text
        assert r.json()["revoked_sessions"] >= 1

        # Back to the provider's still-open session: reads 403, and an autosave that
        # would otherwise overwrite the draft is rejected too — no silent data loss.
        restore(client, provider)
        r = client.get(f"/api/encounters/{enc_id}")
        assert r.status_code == 403
        assert r.json()["detail"] == "account_deactivated"
        r = client.patch(
            f"/api/encounters/{enc_id}",
            json={"transcript": "clobber", "working_note": {}},
            headers=csrf(ptoken),
        )
        assert r.status_code == 403

        # The draft was preserved. Reactivate; a fresh login restores it intact.
        restore(client, admin)
        r = client.post(f"/api/admin/providers/{new_id}/activate", headers=csrf(acsrf))
        assert r.status_code == 200, r.text

        login_capture(client, new_email, temp_password)
        body = client.get(f"/api/encounters/{enc_id}").json()
        assert body["transcript"] == DRAFT_TRANSCRIPT
        assert body["working_note"] == DRAFT_NOTE
