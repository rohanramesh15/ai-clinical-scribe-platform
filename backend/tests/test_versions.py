"""Version save tests: append-only immutability, code grounding, concurrency."""
from fastapi.testclient import TestClient

from app.main import app

PASSWORD = "ScribeDemo2026!"
PROVIDER = "dr.reed@northclinic.com"


def _auth(client: TestClient) -> dict:
    client.post("/api/auth/login", json={"email": PROVIDER, "password": PASSWORD})
    return {"X-CSRF-Token": client.cookies.get("scribe_csrf")}


def test_versions_are_immutable_and_grounded():
    with TestClient(app) as client:
        h = _auth(client)
        eid = client.post(
            "/api/encounters", headers=h,
            json={"first_name": "Vera", "last_name": "Sims", "dob": "1955-02-02"},
        ).json()["id"]

        # v1: two real codes + one bogus (must be dropped, not written).
        r1 = client.post(
            f"/api/encounters/{eid}/versions", headers=h,
            json={
                "subjective": "orig-subj", "assessment": "orig-assess",
                "codes": [
                    {"code": "M54.16", "is_primary": True, "source": "ai_suggested"},
                    {"code": "NOTREAL.9", "source": "ai_suggested"},
                ],
                "based_on_version_no": 0,
            },
        ).json()
        assert r1["version"]["version_no"] == 1
        assert r1["dropped_codes"] == ["NOTREAL.9"]
        assert [d["code"] for d in r1["version"]["diagnoses"]] == ["M54.16"]

        # v2: edit. Prior version must remain intact.
        r2 = client.post(
            f"/api/encounters/{eid}/versions", headers=h,
            json={"subjective": "edited-subj", "assessment": "edited-assess",
                  "based_on_version_no": 1},
        )
        assert r2.status_code == 201
        assert r2.json()["version"]["version_no"] == 2

        v1 = client.get(f"/api/encounters/{eid}/versions/1", headers=h).json()
        assert v1["subjective"] == "orig-subj"  # NOT overwritten by v2
        assert v1["assessment"] == "orig-assess"

        # Stale edit (based on v1 while v2 exists) -> 409, nothing lost.
        conflict = client.post(
            f"/api/encounters/{eid}/versions", headers=h,
            json={"subjective": "x", "based_on_version_no": 1},
        )
        assert conflict.status_code == 409
        assert conflict.json()["detail"]["error"] == "stale_edit"

        # History lists both versions, newest first.
        versions = client.get(f"/api/encounters/{eid}/versions", headers=h).json()
        assert [v["version_no"] for v in versions] == [2, 1]
