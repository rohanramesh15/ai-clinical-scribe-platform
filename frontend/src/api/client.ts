// Typed API client. Same-origin (nginx proxies /api), cookies sent automatically.
// Unsafe methods echo the CSRF cookie in the X-CSRF-Token header (double-submit).

import type {
  AddProviderResponse,
  AdminEncounterListItem,
  AdminEncounterView,
  EncounterDetail,
  EncounterListItem,
  IcdSearchResult,
  MeResponse,
  ProviderRosterItem,
  RedFlag,
  SaveVersionResponse,
  StagedCode,
  TemplateOut,
  TemplateSummary,
  VersionDetail,
  VersionListItem,
  WorkingNote,
} from "./types";

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(`API ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

export function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp("(^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[2]) : null;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (UNSAFE.has(method)) {
    const csrf = readCookie("scribe_csrf");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  const res = await fetch(path, {
    method,
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.detail ?? data);
  return data as T;
}

export const api = {
  // auth
  login: (email: string, password: string) =>
    request<MeResponse>("POST", "/api/auth/login", { email, password }),
  logout: () => request<void>("POST", "/api/auth/logout"),
  me: () => request<MeResponse>("GET", "/api/auth/me"),

  // encounters / drafts
  listEncounters: () => request<EncounterListItem[]>("GET", "/api/encounters"),
  createEncounter: (first_name: string, last_name: string, dob: string, template_id?: number | null) =>
    request<EncounterDetail>("POST", "/api/encounters", { first_name, last_name, dob, template_id }),
  getEncounter: (id: number) => request<EncounterDetail>("GET", `/api/encounters/${id}`),
  autosave: (id: number, patch: { transcript?: string; working_note?: WorkingNote; template_id?: number | null }) =>
    request<EncounterDetail>("PATCH", `/api/encounters/${id}`, patch),

  // versions
  saveVersion: (
    id: number,
    payload: {
      subjective: string;
      objective: string;
      assessment: string;
      plan: string;
      codes: StagedCode[];
      based_on_version_no: number;
      model_name?: string | null;
      system_prompt_snapshot?: string | null;
    },
  ) => request<SaveVersionResponse>("POST", `/api/encounters/${id}/versions`, payload),
  listVersions: (id: number) => request<VersionListItem[]>("GET", `/api/encounters/${id}/versions`),
  getVersion: (id: number, no: number) =>
    request<VersionDetail>("GET", `/api/encounters/${id}/versions/${no}`),

  // icd search
  icdSearch: (q: string, limit = 10) =>
    request<IcdSearchResult[]>("GET", `/api/icd10/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  // red-flag scan (pioneer)
  scanRedFlags: (id: number, transcript: string) =>
    request<{ flags: RedFlag[] }>("POST", `/api/encounters/${id}/redflags`, { transcript }),

  // templates (provider dropdown)
  listTemplates: () => request<TemplateSummary[]>("GET", "/api/templates"),

  // admin
  adminEncounters: (params: { provider_id?: number; date_from?: string; date_to?: string }) => {
    const qs = new URLSearchParams();
    if (params.provider_id) qs.set("provider_id", String(params.provider_id));
    if (params.date_from) qs.set("date_from", params.date_from);
    if (params.date_to) qs.set("date_to", params.date_to);
    const q = qs.toString();
    return request<AdminEncounterListItem[]>("GET", `/api/admin/encounters${q ? "?" + q : ""}`);
  },
  adminEncounterDetail: (id: number) =>
    request<AdminEncounterView>("GET", `/api/admin/encounters/${id}`),
  adminProviders: () => request<ProviderRosterItem[]>("GET", "/api/admin/providers"),
  adminAddProvider: (email: string, role: "provider" | "admin") =>
    request<AddProviderResponse>("POST", "/api/admin/providers", { email, role }),
  adminDeactivate: (id: number) =>
    request<{ provider: ProviderRosterItem; revoked_sessions: number }>(
      "POST", `/api/admin/providers/${id}/deactivate`),
  adminActivate: (id: number) =>
    request<ProviderRosterItem>("POST", `/api/admin/providers/${id}/activate`),
  adminTemplates: () => request<TemplateOut[]>("GET", "/api/admin/templates"),
  adminCreateTemplate: (name: string, encounter_type: string, system_prompt: string) =>
    request<TemplateOut>("POST", "/api/admin/templates", { name, encounter_type, system_prompt }),
  adminUpdateTemplate: (
    id: number,
    patch: { name?: string; encounter_type?: string; system_prompt?: string },
  ) => request<TemplateOut>("PATCH", `/api/admin/templates/${id}`, patch),
  adminArchiveTemplate: (id: number) =>
    request<TemplateOut>("POST", `/api/admin/templates/${id}/archive`),
};

export type { VersionDetail };
