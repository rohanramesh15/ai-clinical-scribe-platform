"""SQLAlchemy 2.0 ORM models — the nine tables of the clinical scribe schema.

Design notes the reviewer will ask about:
- Two immutability lifecycles: `encounters.working_note` (draft, overwrite-in-place)
  vs `note_versions` (finalized, append-only). They are deliberately separate
  tables, not one mechanism.
- `encounters.current_note_version_id` <-> `note_versions.encounter_id` is a
  circular FK; the former is created via ALTER after both tables exist
  (use_alter) and is nullable (a draft has no finalized version yet).
- Codes are stored structurally in `note_version_diagnoses` (FK to a real
  `icd10_codes` row), never as free text inside the Assessment.
- Functional unique indexes (lower(email); lower(first)+lower(last)+dob) are
  defined in the migration, not as plain UniqueConstraints.
"""
from __future__ import annotations

import enum
from datetime import date, datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Identity,
    Integer,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


# --- Enums (created as native PG enum types in the first migration) ---
class Role(str, enum.Enum):
    provider = "provider"
    admin = "admin"


class EncounterStatus(str, enum.Enum):
    draft = "draft"
    finalized = "finalized"


class DiagnosisSource(str, enum.Enum):
    ai_suggested = "ai_suggested"
    provider_added = "provider_added"


class TemplateStatus(str, enum.Enum):
    active = "active"
    archived = "archived"


# Reusable column helpers
def _pk() -> Mapped[int]:
    return mapped_column(BigInteger, Identity(), primary_key=True)


def _created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def _updated_at() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class Provider(Base):
    __tablename__ = "providers"

    id: Mapped[int] = _pk()
    email: Mapped[str] = mapped_column(Text, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[Role] = mapped_column(
        SAEnum(Role, name="role_enum", create_type=False),
        nullable=False,
        default=Role.provider,
    )
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = _updated_at()
    # unique(lower(email)) -> functional index in migration


class Patient(Base):
    __tablename__ = "patients"

    id: Mapped[int] = _pk()
    public_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), server_default=func.gen_random_uuid(), nullable=False
    )
    first_name: Mapped[str] = mapped_column(Text, nullable=False)
    last_name: Mapped[str] = mapped_column(Text, nullable=False)
    dob: Mapped[date] = mapped_column(Date, nullable=False)
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = _updated_at()
    # PRODUCTION-UNSAFE per spec: unique(lower(first), lower(last), dob) means two
    # real people sharing name+DOB collide. Implemented because the brief mandates
    # matching patients on exactly (first, last, dob). A real system would use an
    # MRN. Functional unique index defined in the migration.


class Template(Base):
    __tablename__ = "templates"

    id: Mapped[int] = _pk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    encounter_type: Mapped[str] = mapped_column(Text, nullable=False)
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[TemplateStatus] = mapped_column(
        SAEnum(TemplateStatus, name="template_status", create_type=False),
        nullable=False,
        default=TemplateStatus.active,
    )
    created_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("providers.id"), nullable=False
    )
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = _updated_at()


class Icd10Code(Base):
    __tablename__ = "icd10_codes"

    id: Mapped[int] = _pk()
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    # 384-dim MiniLM embedding; HNSW (vector_cosine_ops) index in migration.
    embedding: Mapped[list[float]] = mapped_column(Vector(384), nullable=False)
    embedding_model: Mapped[str] = mapped_column(Text, nullable=False)


class Encounter(Base):
    __tablename__ = "encounters"

    id: Mapped[int] = _pk()
    public_id: Mapped[str] = mapped_column(
        UUID(as_uuid=True), server_default=func.gen_random_uuid(), nullable=False
    )
    patient_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("patients.id"), nullable=False
    )
    provider_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("providers.id"), nullable=False
    )
    template_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("templates.id"), nullable=True
    )
    status: Mapped[EncounterStatus] = mapped_column(
        SAEnum(EncounterStatus, name="encounter_status", create_type=False),
        nullable=False,
        default=EncounterStatus.draft,
    )
    transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Autosaved mid-edit draft (overwrite-in-place). Shape: {subjective, objective,
    # assessment, plan, codes:[...]} — mirrors the four panes + staged codes.
    working_note: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Latest finalized version pointer. Circular FK created via ALTER in migration.
    current_note_version_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("note_versions.id", use_alter=True, name="fk_enc_current_version"),
        nullable=True,
    )
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = _updated_at()  # bumped on autosave

    patient: Mapped[Patient] = relationship("Patient", lazy="raise")
    provider: Mapped[Provider] = relationship("Provider", lazy="raise")


class NoteVersion(Base):
    __tablename__ = "note_versions"

    id: Mapped[int] = _pk()
    encounter_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("encounters.id"), nullable=False
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    # Four separate fields — never one blob.
    subjective: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    objective: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    assessment: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    plan: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    # Provenance for the walkthrough / audit.
    model_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    system_prompt_snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("providers.id"), nullable=False
    )
    created_at: Mapped[datetime] = _created_at()
    # unique(encounter_id, version_no) in migration

    diagnoses: Mapped[list["NoteVersionDiagnosis"]] = relationship(
        "NoteVersionDiagnosis", lazy="raise", cascade="all, delete-orphan"
    )


class NoteVersionDiagnosis(Base):
    __tablename__ = "note_version_diagnoses"

    id: Mapped[int] = _pk()
    note_version_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("note_versions.id"), nullable=False
    )
    icd10_code_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("icd10_codes.id"), nullable=False
    )
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    source: Mapped[DiagnosisSource] = mapped_column(
        SAEnum(DiagnosisSource, name="diagnosis_source", create_type=False), nullable=False
    )
    created_at: Mapped[datetime] = _created_at()

    icd10_code: Mapped[Icd10Code] = relationship("Icd10Code", lazy="raise")


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = _pk()
    provider_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("providers.id"), nullable=False
    )
    # sha256 hex of the raw cookie token. Raw token never stored.
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = _created_at()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ip: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = _pk()
    actor_provider_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("providers.id"), nullable=False
    )
    action: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    extra: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[datetime] = _created_at()
