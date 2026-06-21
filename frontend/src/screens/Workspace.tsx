import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  AlertOctagon, AlertTriangle, ArrowLeft, ChevronDown, ChevronUp, History, Loader2, Save, Sparkles, UserCheck,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError, api } from "@/api/client";
import type { EncounterDetail, IcdSearchResult, RedFlag, StagedCode } from "@/api/types";
import { parseSoap, streamGeneration, type GenEvent } from "@/api/stream";
import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IcdSearchBar } from "@/components/workspace/IcdSearchBar";
import { ReauthDialog } from "@/components/workspace/ReauthDialog";
import { SoapSection } from "@/components/workspace/SoapSection";
import { VersionDrawer } from "@/components/workspace/VersionDrawer";

type GenStatus = "idle" | "streaming" | "done" | "insufficient" | "interrupted" | "error";
type Sections = { subjective: string; objective: string; assessment: string; plan: string };
const EMPTY: Sections = { subjective: "", objective: "", assessment: "", plan: "" };
const KEYS = ["subjective", "objective", "assessment", "plan"] as const;
const TITLES: Record<keyof Sections, string> = {
  subjective: "Subjective", objective: "Objective", assessment: "Assessment", plan: "Plan",
};
const TOOL_LABEL: Record<string, string> = {
  get_patient_history: "Retrieving patient history…",
  search_icd10: "Searching ICD-10 catalog…",
};

export default function Workspace() {
  const { id } = useParams();
  const encId = Number(id);
  const navigate = useNavigate();
  const location = useLocation();
  const { handleAuthError } = useAuth();

  const [enc, setEnc] = useState<EncounterDetail | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [transcript, setTranscript] = useState("");
  const [sections, setSections] = useState<Sections>(EMPTY);
  const [codes, setCodes] = useState<StagedCode[]>([]);
  const [rawFallback, setRawFallback] = useState<string | null>(null);

  const [status, setStatus] = useState<GenStatus>("idle");
  const [tool, setTool] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [priorCount, setPriorCount] = useState<number | null>(null);
  const [redFlags, setRedFlags] = useState<RedFlag[] | null>(null);
  const [scanningFlags, setScanningFlags] = useState(false);
  const [redFlagsOpen, setRedFlagsOpen] = useState(true);

  const [basedOn, setBasedOn] = useState(0);
  const [currentVersionNo, setCurrentVersionNo] = useState<number | null>(null);
  const [encStatus, setEncStatus] = useState<"draft" | "finalized">("draft");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<number | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [versionRefresh, setVersionRefresh] = useState(0);

  const rawRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const pendingSave = useRef(false);
  const loaded = useRef(false);
  const autoGenStarted = useRef(false);

  // --- Load encounter --------------------------------------------------------
  useEffect(() => {
    let active = true;
    api.getEncounter(encId)
      .then((detail) => {
        if (!active) return;
        setEnc(detail);
        setTemplateId(detail.template_id);
        setTranscript(detail.transcript ?? "");
        setPriorCount(detail.prior_encounter_count);
        setEncStatus(detail.status);
        setCurrentVersionNo(detail.current_version_no);
        setBasedOn(detail.current_version_no ?? 0);

        if (detail.status === "finalized" && detail.current_version_no) {
          api.getVersion(encId, detail.current_version_no).then((v) => {
            if (!active) return;
            setSections({ subjective: v.subjective, objective: v.objective, assessment: v.assessment, plan: v.plan });
            setCodes(v.diagnoses.map((d) => ({
              code: d.code, description: d.description, is_primary: d.is_primary,
              source: d.source as StagedCode["source"],
            })));
            setStatus("done");
            loaded.current = true;
          });
        } else if (detail.working_note) {
          const w = detail.working_note;
          setSections({
            subjective: w.subjective ?? "", objective: w.objective ?? "",
            assessment: w.assessment ?? "", plan: w.plan ?? "",
          });
          setCodes(w.codes ?? []);
          if ((w.subjective || w.objective || w.assessment || w.plan)) setStatus("done");
          loaded.current = true;
        } else {
          loaded.current = true;
        }
      })
      .catch((e) => {
        handleAuthError(e);
        toast.error("Could not load encounter.");
      });
    return () => { active = false; };
  }, [encId, handleAuthError]);

  // --- Debounced autosave (working_note) to RDS ------------------------------
  const persist = useCallback(async () => {
    try {
      await api.autosave(encId, {
        transcript,
        template_id: templateId,
        working_note: { ...sections, codes, based_on_version_no: basedOn },
      });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) handleAuthError(e);
    }
  }, [encId, transcript, templateId, sections, codes, basedOn, handleAuthError]);

  useEffect(() => {
    if (!loaded.current || status === "streaming") return;
    const t = window.setTimeout(persist, 800);
    return () => window.clearTimeout(t);
  }, [persist, status]);

  // --- Streaming generation --------------------------------------------------
  const onEvent = useCallback((e: GenEvent) => {
    if (e.type === "meta") setPriorCount(e.prior_encounter_count);
    else if (e.type === "tool") setTool(e.name);
    else if (e.type === "delta") {
      rawRef.current += e.text;
      const p = parseSoap(rawRef.current);
      if (p.insufficient) { setStatus("insufficient"); return; }
      setSections({ subjective: p.subjective, objective: p.objective, assessment: p.assessment, plan: p.plan });
      setCodes(p.codes.map((c) => ({ ...c, source: "ai_suggested" as const })));
    } else if (e.type === "insufficient") {
      setStatus("insufficient");
    } else if (e.type === "done") {
      setTool(null);
      const p = parseSoap(rawRef.current);
      if (p.insufficient) { setStatus("insufficient"); return; }
      if (!p.parsedAny && rawRef.current.trim()) setRawFallback(rawRef.current);
      setStatus("done");
    } else if (e.type === "error") {
      setTool(null);
      if (e.message === "unauthorized") { pendingSave.current = false; setReauthOpen(true); setStatus("interrupted"); }
      else { setStatus("interrupted"); setGenError(e.detail || "Generation was interrupted."); }
    }
  }, []);

  const generate = useCallback(async () => {
    if (!transcript.trim()) { toast.warning("This encounter has no transcript — add one first."); return; }
    await persist();
    // Red-flag pre-scan (pioneer): runs in parallel, never blocks generation.
    setRedFlags(null);
    setScanningFlags(true);
    setRedFlagsOpen(true);
    api.scanRedFlags(encId, transcript)
      .then((r) => setRedFlags(r.flags))
      .catch(() => setRedFlags([]))
      .finally(() => setScanningFlags(false));
    rawRef.current = "";
    setSections(EMPTY); setCodes([]); setRawFallback(null); setGenError(null);
    setStatus("streaming"); setTool(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamGeneration(encId, { transcript, template_id: templateId }, onEvent, ctrl.signal);
    } catch (err) {
      if (!ctrl.signal.aborted) { setStatus("interrupted"); setGenError("Connection lost during generation."); }
    }
  }, [encId, transcript, templateId, onEvent, persist]);

  // --- Auto-generate when arriving from the intake page ----------------------
  useEffect(() => {
    if (autoGenStarted.current) return;
    if (!loaded.current) return;
    if ((location.state as { autoGenerate?: boolean } | null)?.autoGenerate !== true) return;
    if (!transcript.trim() || status === "streaming") return;
    autoGenStarted.current = true;
    // Clear the history-state flag so a refresh doesn't re-generate.
    window.history.replaceState({ ...window.history.state, usr: null }, "");
    generate();
  }, [location.state, transcript, status, generate]);

  // --- ICD widget append (-> Assessment + provider_added code) ---------------
  const appendCode = useCallback((r: IcdSearchResult) => {
    setCodes((prev) =>
      prev.some((c) => c.code === r.code)
        ? prev
        : [...prev, { code: r.code, description: r.description, is_primary: false, source: "provider_added" }],
    );
    setSections((s) => ({
      ...s,
      assessment: s.assessment + (s.assessment && !s.assessment.endsWith("\n") ? "\n" : "") + `${r.description} (${r.code})`,
    }));
    toast.success(`Added ${r.code} to Assessment section`);
  }, []);

  // --- Save (immutable version) ----------------------------------------------
  const doSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await api.saveVersion(encId, {
        subjective: sections.subjective, objective: sections.objective,
        assessment: sections.assessment, plan: sections.plan,
        codes, based_on_version_no: basedOn, model_name: "gemini-3.5-flash",
      });
      toast.success(`Saved version ${res.version.version_no}`);
      if (res.dropped_codes.length) {
        toast.warning(`${res.dropped_codes.length} unverified code(s) omitted: ${res.dropped_codes.join(", ")}`);
      }
      setBasedOn(res.version.version_no);
      setCurrentVersionNo(res.version.version_no);
      setEncStatus("finalized");
      setStatus("done");
      setConflict(null);
      setVersionRefresh((k) => k + 1);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        pendingSave.current = true;
        setReauthOpen(true);
      } else if (err instanceof ApiError && err.status === 403) {
        handleAuthError(err);
      } else if (err instanceof ApiError && err.status === 409) {
        const d = err.detail as { latest_version_no: number };
        setConflict(d.latest_version_no);
      } else {
        toast.error("Save failed.");
      }
    } finally {
      setSaving(false);
    }
  }, [encId, sections, codes, basedOn, handleAuthError]);

  const loadLatest = useCallback(async () => {
    if (!currentVersionNo && !conflict) return;
    const latest = conflict ?? currentVersionNo!;
    const v = await api.getVersion(encId, latest);
    setSections({ subjective: v.subjective, objective: v.objective, assessment: v.assessment, plan: v.plan });
    setCodes(v.diagnoses.map((d) => ({
      code: d.code, description: d.description, is_primary: d.is_primary, source: d.source as StagedCode["source"],
    })));
    setBasedOn(latest);
    setCurrentVersionNo(latest);
    setConflict(null);
    toast.message(`Loaded latest (v${latest}).`);
  }, [encId, conflict, currentVersionNo]);

  const editable = status !== "streaming";
  const hasContent = KEYS.some((k) => sections[k].trim()) || !!rawFallback;
  const autoPending = (location.state as { autoGenerate?: boolean } | null)?.autoGenerate === true;
  const patient = enc?.patient;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {/* Workspace toolbar: patient | ICD-10 search | actions */}
      <div className="flex items-center gap-4 border-b border-border bg-card px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">
              {patient ? `${patient.last_name}, ${patient.first_name}` : "…"}
            </span>
            {patient && <span className="shrink-0 font-mono text-xs text-muted-foreground">DOB {patient.dob}</span>}
            <Badge
              variant="outline"
              className={encStatus === "finalized" ? "border-success/40 text-success" : "border-warning/40 text-warning"}
            >
              {encStatus}
            </Badge>
            {priorCount !== null && priorCount > 0 && (
              <Badge variant="outline" className="shrink-0 gap-1 border-primary/30 text-primary">
                <UserCheck className="h-3 w-3" />
                {priorCount} prior
              </Badge>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mx-auto max-w-md">
            <IcdSearchBar onAppend={appendCode} disabled={status === "streaming"} />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setDrawerOpen(true)}>
            <History className="h-3.5 w-3.5" />
            History{currentVersionNo ? ` (v${currentVersionNo})` : ""}
          </Button>
          <Button size="sm" className="h-8 gap-1.5" disabled={saving || status === "streaming" || !hasContent} onClick={doSave}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={() => navigate("/")}>
            Back to home
          </Button>
        </div>
      </div>

      {conflict !== null && (
        <div className="flex items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            This note changed since you opened it (v{conflict} now exists). Review the latest before saving.
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-6 text-xs" onClick={loadLatest}>Load latest</Button>
            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setConflict(null)}>Dismiss</Button>
          </div>
        </div>
      )}

      {status === "streaming" && tool && (
        <div className="flex items-center gap-1.5 border-b border-border bg-primary/5 px-4 py-1.5 text-xs text-primary">
          <Loader2 className="h-3 w-3 animate-spin" />
          {TOOL_LABEL[tool] ?? tool}
        </div>
      )}

      {/* Body: red flags + four SOAP boxes, centered with side margins */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted/20">
        <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-3 p-4">
        {(scanningFlags || (redFlags && redFlags.length > 0)) && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <button
              type="button"
              onClick={() => setRedFlagsOpen((o) => !o)}
              className="flex w-full items-center gap-1.5 text-xs font-semibold text-destructive"
            >
              <AlertOctagon className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">
                {scanningFlags
                  ? "Scanning for clinical red flags…"
                  : `${redFlags!.length} clinical red flag${redFlags!.length > 1 ? "s" : ""} detected — review before finalizing`}
              </span>
              {!scanningFlags && redFlags && redFlags.length > 0 && (
                redFlagsOpen ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />
              )}
            </button>
            {redFlagsOpen && redFlags && redFlags.length > 0 && (
              <ul className="mt-2 space-y-1">
                {redFlags.map((f, i) => (
                  <li key={i} className="flex gap-2 text-xs">
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${f.severity === "high" ? "bg-destructive" : "bg-warning"}`} />
                    <span>
                      <span className="font-medium">{f.flag}.</span>{" "}
                      <span className="text-muted-foreground">{f.rationale}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {status === "insufficient" ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="max-w-sm rounded-md border border-warning/40 bg-warning/5 p-6 text-center">
              <AlertTriangle className="mx-auto h-6 w-6 text-warning" />
              <h3 className="mt-2 text-sm font-semibold">No clinical content detected</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                The input doesn’t contain clinical observations — no note was fabricated.
              </p>
              <Button size="sm" variant="outline" className="mt-3 gap-1.5"
                onClick={() => navigate(`/encounters/${encId}/intake`)}>
                <ArrowLeft className="h-3.5 w-3.5" /> Edit transcript
              </Button>
            </div>
          </div>
        ) : rawFallback ? (
          <div className="rounded-md border border-warning/40 bg-warning/5 p-4">
            <p className="mb-2 text-xs font-medium text-warning">
              Couldn’t split the response into sections — showing the full text, please review.
            </p>
            <pre className="whitespace-pre-wrap text-xs leading-relaxed">{rawFallback}</pre>
          </div>
        ) : !hasContent && status !== "streaming" && !autoPending ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="max-w-sm rounded-md border border-border bg-card p-6 text-center">
              <Sparkles className="mx-auto h-6 w-6 text-muted-foreground" />
              <h3 className="mt-2 text-sm font-semibold">No note yet</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Set the template and transcript, then generate the SOAP note.
              </p>
              <Button size="sm" className="mt-3 gap-1.5" onClick={() => navigate(`/encounters/${encId}/intake`)}>
                <Sparkles className="h-3.5 w-3.5" /> Set up &amp; generate
              </Button>
            </div>
          </div>
        ) : (
          <>
            {status === "interrupted" && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Generation interrupted — note is incomplete. {genError}
                </span>
                <Button size="sm" variant="outline" className="h-6 text-xs" onClick={generate}>Retry</Button>
              </div>
            )}
            <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-4">
              {KEYS.map((k) => (
                <SoapSection
                  key={k}
                  title={TITLES[k]}
                  value={sections[k]}
                  onChange={(v) => setSections((s) => ({ ...s, [k]: v }))}
                  editable={editable}
                  streaming={status === "streaming"}
                  missing={status === "interrupted" && !sections[k].trim()}
                />
              ))}
            </div>
          </>
        )}
        </div>
      </div>

      <VersionDrawer
        encounterId={encId}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        refreshKey={versionRefresh}
        currentVersionNo={currentVersionNo}
      />
      <ReauthDialog
        open={reauthOpen}
        onReauthed={() => {
          setReauthOpen(false);
          if (pendingSave.current) { pendingSave.current = false; doSave(); }
        }}
      />
    </main>
  );
}
