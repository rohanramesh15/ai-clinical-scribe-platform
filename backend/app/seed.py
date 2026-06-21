"""Idempotent database seed.

Run:  python -m app.seed

Inserts (skipping anything already present, so re-running is safe):
  - 3 providers + 1 admin. Passwords are NOT hardcoded: each is taken from
    $SEED_DEMO_PASSWORD if set, otherwise randomly generated, and printed ONCE
    to the console. Nothing plaintext is written to source or committed.
  - 300+ real ICD-10 codes, each embedded once with local MiniLM.
  - 3 templates with visibly different system prompts (new-patient eval,
    orthopedic follow-up, urgent care) so template choice changes AI output.
"""
from __future__ import annotations

import asyncio
import os
import secrets as pysecrets

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .data.icd10_seed import ICD10_CODES
from .db import build_engine, build_sessionmaker
from .embeddings import embed_texts
from .models import Icd10Code, Provider, Role, Template, TemplateStatus
from .secrets import load_runtime_secrets
from .security import hash_password

# Demo accounts. Passwords are injected at runtime (env or random), never here.
# Normal TLD (email-validator rejects reserved domains like .test/.example).
DEMO_PROVIDERS = [
    ("dr.reed@northclinic.com", Role.provider),
    ("dr.okafor@northclinic.com", Role.provider),
    ("dr.santos@northclinic.com", Role.provider),
    ("admin@northclinic.com", Role.admin),
]

TEMPLATES = [
    {
        "name": "New Patient Evaluation",
        "encounter_type": "new_patient",
        "system_prompt": (
            "This is a NEW PATIENT comprehensive evaluation. Produce a thorough, "
            "structured note. In Subjective, capture a full HPI (onset, location, "
            "duration, character, aggravating/relieving factors, associated symptoms), "
            "a complete past medical/surgical history, medications, allergies, family "
            "history, social history, and a focused review of systems. In Objective, "
            "include a complete set of vitals and a head-to-toe exam by system. In "
            "Assessment, enumerate a prioritized problem list, each problem with its "
            "own reasoning. In Plan, give per-problem workup, treatment, patient "
            "education, and explicit follow-up. Favor completeness over brevity."
        ),
    },
    {
        "name": "Orthopedic Follow-up",
        "encounter_type": "ortho_followup",
        "system_prompt": (
            "This is an ORTHOPEDIC FOLLOW-UP visit. Be focused and musculoskeletal. "
            "In Subjective, emphasize interval change since the last visit: pain "
            "trajectory (0-10), functional status, adherence to PT/home exercise, "
            "medication response, and any new mechanical symptoms (locking, giving "
            "way, instability). In Objective, document a targeted MSK exam of the "
            "affected joint: inspection, palpation, range of motion (with degrees), "
            "strength grading, special/provocative tests, neurovascular status, and "
            "relevant imaging findings. In Assessment, state the orthopedic diagnosis "
            "and current status (improving/plateaued/worsening). In Plan, address "
            "activity modification, PT progression, injections or bracing, imaging, "
            "and surgical candidacy if relevant. Keep non-MSK content minimal."
        ),
    },
    {
        "name": "Urgent Care Visit",
        "encounter_type": "urgent_care",
        "system_prompt": (
            "This is an URGENT CARE visit. Be concise and disposition-oriented. In "
            "Subjective, capture a tight HPI focused on the presenting complaint plus "
            "pertinent positives and negatives and any red-flag screening. In "
            "Objective, record vitals and a focused exam of the relevant system(s) "
            "only. In Assessment, give the most likely diagnosis and the key "
            "can't-miss differentials you considered. In Plan, be explicit about "
            "immediate treatment, any point-of-care testing, clear return/ED "
            "precautions, and disposition (discharge home vs transfer). Prioritize "
            "ruling out emergencies over exhaustive documentation."
        ),
    },
]


async def _seed_providers(session: AsyncSession) -> dict[str, int]:
    ids: dict[str, int] = {}
    created: list[tuple[str, str]] = []
    for email, role in DEMO_PROVIDERS:
        existing = (
            await session.execute(
                select(Provider).where(Provider.email == email)
            )
        ).scalar_one_or_none()
        if existing:
            ids[email] = existing.id
            continue
        password = os.environ.get("SEED_DEMO_PASSWORD") or pysecrets.token_urlsafe(9)
        provider = Provider(
            email=email, password_hash=hash_password(password), role=role
        )
        session.add(provider)
        await session.flush()
        ids[email] = provider.id
        created.append((email, password))

    if created:
        print("\n=== DEMO CREDENTIALS (shown once — do not commit) ===")
        for email, pw in created:
            print(f"  {email:28s}  {pw}")
        print("=====================================================\n")
    else:
        print("Providers already seeded (no new credentials generated).")
    return ids


async def _seed_templates(session: AsyncSession, admin_id: int) -> None:
    existing_names = set(
        (await session.execute(select(Template.name))).scalars().all()
    )
    n = 0
    for t in TEMPLATES:
        if t["name"] in existing_names:
            continue
        session.add(
            Template(
                name=t["name"],
                encounter_type=t["encounter_type"],
                system_prompt=t["system_prompt"],
                status=TemplateStatus.active,
                created_by=admin_id,
            )
        )
        n += 1
    print(f"Templates: {n} inserted, {len(existing_names)} already present.")


async def _seed_icd10(session: AsyncSession) -> None:
    settings = get_settings()
    existing_codes = set(
        (await session.execute(select(Icd10Code.code))).scalars().all()
    )
    todo = [(c, d) for c, d in ICD10_CODES if c not in existing_codes]
    if not todo:
        print(f"ICD-10: all {len(ICD10_CODES)} codes already present.")
        return

    print(f"ICD-10: embedding {len(todo)} codes with {settings.embedding_model} ...")
    # Embed the description (what the provider's query semantically matches on).
    vectors = embed_texts([d for _, d in todo])
    for (code, desc), vec in zip(todo, vectors):
        session.add(
            Icd10Code(
                code=code,
                description=desc,
                embedding=vec,
                embedding_model=settings.embedding_model,
            )
        )
    print(f"ICD-10: {len(todo)} codes inserted.")


async def main() -> None:
    settings = get_settings()
    secrets = load_runtime_secrets(settings)
    engine = build_engine(secrets.database_url, settings)
    sessionmaker = build_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            async with session.begin():
                provider_ids = await _seed_providers(session)
                admin_id = provider_ids["admin@northclinic.com"]
                await _seed_templates(session, admin_id)
                await _seed_icd10(session)
        print("Seed complete.")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
