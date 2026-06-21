"""Admin dashboard endpoints (all behind require_admin).

Admin queries deliberately OMIT the provider-isolation filter — that is what
lets an admin see across all providers. Every MUTATION writes an audit_log row
in the same transaction (reads do not).
"""
from __future__ import annotations

import secrets as pysecrets
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import revoke_all_for_provider
from ..deps import get_session, require_admin
from ..models import (
    Encounter,
    NoteVersion,
    Patient,
    Provider,
    Role,
    Template,
    TemplateStatus,
)
from ..schemas import (
    AddProviderRequest,
    AddProviderResponse,
    AdminEncounterListItem,
    AdminEncounterView,
    DeactivateProviderResponse,
    PatientOut,
    ProviderRosterItem,
    TemplateCreateRequest,
    TemplateOut,
    TemplateUpdateRequest,
    VersionListItem,
)
from ..security import hash_password
from ..services.audit import write_audit
from .encounters import _version_detail  # builds VersionDetail (no ownership check)

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _roster_item(p: Provider) -> ProviderRosterItem:
    return ProviderRosterItem(
        id=p.id, email=p.email, role=p.role.value, active=p.active, created_at=p.created_at
    )


def _template_out(t: Template) -> TemplateOut:
    return TemplateOut(
        id=t.id, name=t.name, encounter_type=t.encounter_type,
        system_prompt=t.system_prompt, status=t.status.value,
        created_at=t.created_at, updated_at=t.updated_at,
    )


# --- Encounters (read-only; no audit) --------------------------------------

@router.get("/encounters", response_model=list[AdminEncounterListItem])
async def admin_list_encounters(
    provider_id: int | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    _admin: Provider = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> list[AdminEncounterListItem]:
    stmt = (
        select(Encounter, Provider.email, Patient, NoteVersion.version_no)
        .join(Provider, Provider.id == Encounter.provider_id)
        .join(Patient, Patient.id == Encounter.patient_id)
        .outerjoin(NoteVersion, NoteVersion.id == Encounter.current_note_version_id)
        .order_by(Encounter.created_at.desc())
    )
    if provider_id is not None:
        stmt = stmt.where(Encounter.provider_id == provider_id)
    if date_from is not None:
        stmt = stmt.where(
            Encounter.created_at >= datetime.combine(date_from, datetime.min.time(), tzinfo=timezone.utc)
        )
    if date_to is not None:
        # inclusive end-of-day
        stmt = stmt.where(
            Encounter.created_at < datetime.combine(date_to, datetime.min.time(), tzinfo=timezone.utc) + timedelta(days=1)
        )

    rows = (await db.execute(stmt)).all()
    return [
        AdminEncounterListItem(
            id=enc.id,
            public_id=str(enc.public_id),
            provider_email=email,
            patient_name=f"{pat.last_name}, {pat.first_name}",
            patient_dob=pat.dob,
            status=enc.status.value,
            current_version_no=vno,
            created_at=enc.created_at,
            updated_at=enc.updated_at,
        )
        for enc, email, pat, vno in rows
    ]


@router.get("/encounters/{encounter_id}", response_model=AdminEncounterView)
async def admin_encounter_detail(
    encounter_id: int,
    _admin: Provider = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> AdminEncounterView:
    row = (
        await db.execute(
            select(Encounter, Provider.email, Patient)
            .join(Provider, Provider.id == Encounter.provider_id)
            .join(Patient, Patient.id == Encounter.patient_id)
            .where(Encounter.id == encounter_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="encounter_not_found")
    enc, provider_email, patient = row

    current_version = None
    if enc.current_note_version_id is not None:
        nv = (
            await db.execute(
                select(NoteVersion).where(NoteVersion.id == enc.current_note_version_id)
            )
        ).scalar_one()
        current_version = await _version_detail(db, nv)

    vrows = (
        await db.execute(
            select(NoteVersion.id, NoteVersion.version_no, Provider.email, NoteVersion.created_at, func.count())
            .join(Provider, Provider.id == NoteVersion.created_by)
            .where(NoteVersion.encounter_id == encounter_id)
            .group_by(NoteVersion.id, Provider.email)
            .order_by(NoteVersion.version_no.desc())
        )
    ).all()
    # Note: count() above counts the grouped row set; diagnosis counts aren't
    # needed for the admin drill-down, so report 0 to keep this query cheap.
    versions = [
        VersionListItem(id=i, version_no=v, created_by_email=e, created_at=c, diagnosis_count=0)
        for i, v, e, c, _ in vrows
    ]

    return AdminEncounterView(
        id=enc.id,
        public_id=str(enc.public_id),
        provider_email=provider_email,
        patient=PatientOut(
            id=patient.id, public_id=str(patient.public_id),
            first_name=patient.first_name, last_name=patient.last_name, dob=patient.dob,
        ),
        status=enc.status.value,
        created_at=enc.created_at,
        current_version=current_version,
        versions=versions,
    )


# --- Providers (mutations audited) -----------------------------------------

@router.get("/providers", response_model=list[ProviderRosterItem])
async def admin_list_providers(
    _admin: Provider = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> list[ProviderRosterItem]:
    rows = (await db.execute(select(Provider).order_by(Provider.id))).scalars().all()
    return [_roster_item(p) for p in rows]


@router.post("/providers", response_model=AddProviderResponse, status_code=201)
async def admin_add_provider(
    body: AddProviderRequest,
    admin: Provider = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> AddProviderResponse:
    existing = (
        await db.execute(
            select(Provider.id).where(func.lower(Provider.email) == body.email.lower())
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail="email_exists")

    temp_password = pysecrets.token_urlsafe(9)
    provider = Provider(
        email=body.email,
        password_hash=hash_password(temp_password),
        role=Role(body.role),
    )
    db.add(provider)
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(status_code=409, detail="email_exists")

    await write_audit(
        db, actor_provider_id=admin.id, action="provider.add",
        entity_type="provider", entity_id=provider.id, extra={"email": body.email, "role": body.role},
    )
    await db.commit()
    return AddProviderResponse(provider=_roster_item(provider), temp_password=temp_password)


@router.post("/providers/{provider_id}/deactivate", response_model=DeactivateProviderResponse)
async def admin_deactivate_provider(
    provider_id: int,
    admin: Provider = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> DeactivateProviderResponse:
    if provider_id == admin.id:
        raise HTTPException(status_code=400, detail="cannot_deactivate_self")
    provider = (
        await db.execute(select(Provider).where(Provider.id == provider_id))
    ).scalar_one_or_none()
    if provider is None:
        raise HTTPException(status_code=404, detail="provider_not_found")

    provider.active = False
    revoked = await revoke_all_for_provider(db, provider_id)  # instant logout
    await write_audit(
        db, actor_provider_id=admin.id, action="provider.deactivate",
        entity_type="provider", entity_id=provider_id, extra={"revoked_sessions": revoked},
    )
    await db.commit()
    await db.refresh(provider)
    return DeactivateProviderResponse(provider=_roster_item(provider), revoked_sessions=revoked)


@router.post("/providers/{provider_id}/activate", response_model=ProviderRosterItem)
async def admin_activate_provider(
    provider_id: int,
    admin: Provider = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> ProviderRosterItem:
    provider = (
        await db.execute(select(Provider).where(Provider.id == provider_id))
    ).scalar_one_or_none()
    if provider is None:
        raise HTTPException(status_code=404, detail="provider_not_found")
    provider.active = True
    await write_audit(
        db, actor_provider_id=admin.id, action="provider.activate",
        entity_type="provider", entity_id=provider_id,
    )
    await db.commit()
    await db.refresh(provider)
    return _roster_item(provider)


# --- Templates (mutations audited; "delete" == archive) --------------------

@router.get("/templates", response_model=list[TemplateOut])
async def admin_list_templates(
    _admin: Provider = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> list[TemplateOut]:
    rows = (await db.execute(select(Template).order_by(Template.id))).scalars().all()
    return [_template_out(t) for t in rows]


@router.post("/templates", response_model=TemplateOut, status_code=201)
async def admin_create_template(
    body: TemplateCreateRequest,
    admin: Provider = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> TemplateOut:
    tmpl = Template(
        name=body.name, encounter_type=body.encounter_type,
        system_prompt=body.system_prompt, status=TemplateStatus.active,
        created_by=admin.id,
    )
    db.add(tmpl)
    await db.flush()
    await write_audit(
        db, actor_provider_id=admin.id, action="template.create",
        entity_type="template", entity_id=tmpl.id, extra={"name": body.name},
    )
    await db.commit()
    await db.refresh(tmpl)
    return _template_out(tmpl)


@router.patch("/templates/{template_id}", response_model=TemplateOut)
async def admin_update_template(
    template_id: int,
    body: TemplateUpdateRequest,
    admin: Provider = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> TemplateOut:
    tmpl = (
        await db.execute(select(Template).where(Template.id == template_id))
    ).scalar_one_or_none()
    if tmpl is None:
        raise HTTPException(status_code=404, detail="template_not_found")

    fields = body.model_dump(exclude_unset=True)
    if "name" in fields and body.name is not None:
        tmpl.name = body.name
    if "encounter_type" in fields and body.encounter_type is not None:
        tmpl.encounter_type = body.encounter_type
    if "system_prompt" in fields and body.system_prompt is not None:
        tmpl.system_prompt = body.system_prompt

    await write_audit(
        db, actor_provider_id=admin.id, action="template.update",
        entity_type="template", entity_id=template_id, extra={"fields": list(fields.keys())},
    )
    await db.flush()
    await db.refresh(tmpl)
    detail = _template_out(tmpl)
    await db.commit()
    return detail


@router.post("/templates/{template_id}/archive", response_model=TemplateOut)
async def admin_archive_template(
    template_id: int,
    admin: Provider = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> TemplateOut:
    tmpl = (
        await db.execute(select(Template).where(Template.id == template_id))
    ).scalar_one_or_none()
    if tmpl is None:
        raise HTTPException(status_code=404, detail="template_not_found")
    # "Delete" == archive: vanishes from provider dropdowns, row + FKs survive.
    tmpl.status = TemplateStatus.archived
    await write_audit(
        db, actor_provider_id=admin.id, action="template.archive",
        entity_type="template", entity_id=template_id,
    )
    await db.flush()
    await db.refresh(tmpl)
    detail = _template_out(tmpl)
    await db.commit()
    return detail
