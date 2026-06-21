"""Live-template contract: an admin's template changes reach a provider without
a page refresh.

The brief requires that if an admin updates templates while a provider has the
workspace open, the provider's next generation uses the change — no refresh.

Two halves make that true:
  * the active template's *body* is read FRESH from RDS at generation time
    (routers/encounters.py), so an edit applies on the very next generation; and
  * the provider's template *dropdown* is re-fetched whenever it opens
    (frontend Workspace.tsx `onOpenChange`), so newly created / renamed /
    archived templates appear immediately.

This test pins the server-side half that the frontend re-fetch relies on: each
GET /api/templates returns current data with no server-side caching. The frontend
re-fetch (verified via `tsc --noEmit`/`vite build`) is what actually re-asks.

Run: pytest tests/test_templates_live.py  (docker Postgres up + seed run)
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from _helpers import ADMIN, PROVIDER, csrf, login_capture, restore
from app.main import app


def test_admin_template_changes_reach_provider_without_refresh():
    with TestClient(app) as client:  # one lifespan / one event loop
        _, provider = login_capture(client, PROVIDER)
        acsrf, admin = login_capture(client, ADMIN)

        # Baseline: the provider's active-template list (the dropdown's source).
        restore(client, provider)
        before_ids = {t["id"] for t in client.get("/api/templates").json()}

        # Admin creates a brand-new template mid-session.
        restore(client, admin)
        name = f"Live Test {uuid.uuid4().hex[:8]}"
        r = client.post(
            "/api/admin/templates",
            json={
                "name": name,
                "encounter_type": "live_test",
                "system_prompt": "You are a terse test template.",
            },
            headers=csrf(acsrf),
        )
        assert r.status_code == 201, r.text
        tmpl_id = r.json()["id"]

        # Provider re-queries (what the dropdown does on open) and sees it at once.
        restore(client, provider)
        after_ids = {t["id"] for t in client.get("/api/templates").json()}
        assert tmpl_id not in before_ids
        assert tmpl_id in after_ids

        # A rename is reflected on the very next fetch — no caching, no refresh.
        restore(client, admin)
        r = client.patch(
            f"/api/admin/templates/{tmpl_id}",
            json={"name": f"{name} (renamed)"},
            headers=csrf(acsrf),
        )
        assert r.status_code == 200, r.text
        restore(client, provider)
        names = {t["id"]: t["name"] for t in client.get("/api/templates").json()}
        assert names[tmpl_id] == f"{name} (renamed)"

        # Archiving ("delete") removes it from the provider's active dropdown,
        # also immediately. The row survives for FK integrity (active-only filter).
        restore(client, admin)
        r = client.post(f"/api/admin/templates/{tmpl_id}/archive", headers=csrf(acsrf))
        assert r.status_code == 200, r.text
        restore(client, provider)
        final_ids = {t["id"] for t in client.get("/api/templates").json()}
        assert tmpl_id not in final_ids
