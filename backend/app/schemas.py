"""Pydantic request/response schemas. Grows per milestone."""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1)


class ProviderOut(BaseModel):
    id: int
    email: str
    role: str
    active: bool


class MeResponse(BaseModel):
    provider: ProviderOut
    csrf_token: str


# --- Encounters / drafts (M3) ---

class PatientOut(BaseModel):
    id: int
    public_id: str
    first_name: str
    last_name: str
    dob: date


class CreateEncounterRequest(BaseModel):
    first_name: str = Field(min_length=1, max_length=120)
    last_name: str = Field(min_length=1, max_length=120)
    dob: date
    template_id: int | None = None


class EncounterPatch(BaseModel):
    """Debounced autosave payload. All fields optional — partial update."""
    transcript: str | None = None
    working_note: dict | None = None
    template_id: int | None = None


class EncounterListItem(BaseModel):
    id: int
    public_id: str
    patient_name: str
    patient_dob: date
    status: str
    has_working_note: bool
    created_at: datetime
    updated_at: datetime


class GenerateRequest(BaseModel):
    """Generation uses the latest transcript/template (may not be autosaved yet)."""
    transcript: str | None = None
    template_id: int | None = None


class EncounterDetail(BaseModel):
    id: int
    public_id: str
    patient: PatientOut
    provider_id: int
    template_id: int | None
    status: str
    transcript: str | None
    working_note: dict | None
    current_note_version_id: int | None
    current_version_no: int | None
    prior_encounter_count: int  # finalized encounters for this patient (badge)
    created_at: datetime
    updated_at: datetime


# --- Versions / save (M5) ---

class DiagnosisIn(BaseModel):
    code: str
    is_primary: bool = False
    source: Literal["ai_suggested", "provider_added"] = "ai_suggested"


class SaveVersionRequest(BaseModel):
    subjective: str = ""
    objective: str = ""
    assessment: str = ""
    plan: str = ""
    codes: list[DiagnosisIn] = Field(default_factory=list)
    # Optimistic concurrency: the version this edit was based on (0 for a brand
    # new note). Save is rejected if a newer version exists.
    based_on_version_no: int = 0
    model_name: str | None = None
    system_prompt_snapshot: str | None = None


class DiagnosisOut(BaseModel):
    code: str
    description: str
    is_primary: bool
    source: str


class VersionDetail(BaseModel):
    id: int
    version_no: int
    subjective: str
    objective: str
    assessment: str
    plan: str
    created_by_email: str
    created_at: datetime
    diagnoses: list[DiagnosisOut]


class SaveVersionResponse(BaseModel):
    version: VersionDetail
    dropped_codes: list[str]  # codes that didn't match the catalog (omitted)


class VersionListItem(BaseModel):
    id: int
    version_no: int
    created_by_email: str
    created_at: datetime
    diagnosis_count: int


# --- ICD-10 search widget (M6) ---

class IcdSearchResult(BaseModel):
    code: str
    description: str
    score: float  # 1 - cosine_distance (1.0 = closest)

