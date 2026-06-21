// TypeScript mirrors of the backend Pydantic schemas.

export type Role = "provider" | "admin";

export interface Provider {
  id: number;
  email: string;
  role: Role;
  active: boolean;
}

export interface MeResponse {
  provider: Provider;
  csrf_token: string;
}

export interface PatientOut {
  id: number;
  public_id: string;
  first_name: string;
  last_name: string;
  dob: string;
}

export interface EncounterListItem {
  id: number;
  public_id: string;
  patient_name: string;
  patient_dob: string;
  status: "draft" | "finalized";
  has_working_note: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkingNote {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  codes: StagedCode[];
  based_on_version_no?: number;
}

export interface EncounterDetail {
  id: number;
  public_id: string;
  patient: PatientOut;
  provider_id: number;
  template_id: number | null;
  status: "draft" | "finalized";
  transcript: string | null;
  working_note: WorkingNote | null;
  current_note_version_id: number | null;
  current_version_no: number | null;
  prior_encounter_count: number;
  created_at: string;
  updated_at: string;
}

export interface StagedCode {
  code: string;
  description: string;
  is_primary: boolean;
  source: "ai_suggested" | "provider_added";
}

export interface DiagnosisOut {
  code: string;
  description: string;
  is_primary: boolean;
  source: string;
}

export interface VersionDetail {
  id: number;
  version_no: number;
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  created_by_email: string;
  created_at: string;
  diagnoses: DiagnosisOut[];
}

export interface VersionListItem {
  id: number;
  version_no: number;
  created_by_email: string;
  created_at: string;
  diagnosis_count: number;
}

export interface SaveVersionResponse {
  version: VersionDetail;
  dropped_codes: string[];
}

export interface IcdSearchResult {
  code: string;
  description: string;
  score: number;
}

export interface TemplateSummary {
  id: number;
  name: string;
  encounter_type: string;
}

export interface TemplateOut {
  id: number;
  name: string;
  encounter_type: string;
  system_prompt: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

export interface ProviderRosterItem {
  id: number;
  email: string;
  role: Role;
  active: boolean;
  created_at: string;
}

export interface AddProviderResponse {
  provider: ProviderRosterItem;
  temp_password: string;
}

export interface AdminEncounterListItem {
  id: number;
  public_id: string;
  provider_email: string;
  patient_name: string;
  patient_dob: string;
  status: string;
  current_version_no: number | null;
  created_at: string;
  updated_at: string;
}

export interface AdminEncounterView {
  id: number;
  public_id: string;
  provider_email: string;
  patient: PatientOut;
  status: string;
  created_at: string;
  current_version: VersionDetail | null;
  versions: VersionListItem[];
}
