import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle, ArrowLeft, FileText, History, Loader2, Save, Sparkles, UserCheck,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError, api } from "@/api/client";
import type { EncounterDetail, IcdSearchResult, StagedCode } from "@/api/types";
import { parseSoap, streamGeneration, type GenEvent } from "@/api/stream";
import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CodesPanel } from "@/components/workspace/CodesPanel";
import { IcdSearchPanel } from "@/components/workspace/IcdSearchPanel";
import { ReauthDialog } from "@/components/workspace/ReauthDialog";
import { SoapSection } from "@/components/workspace/SoapSection";
import { VersionDrawer } from "@/components/workspace/VersionDrawer";
import type { TemplateSummary } from "@/api/types";

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
  const { handleAuthError } = useAuth();

  const [enc, setEnc] = useState<EncounterDetail | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [transcript, setTranscript] = useState("");
  const [sections, setSections] = useState<Sections>(EMPTY);
  const [codes, setCodes] = useState<StagedCode[]>([]);
  const [rawFallback, setRawFallback] = useState<string | null>(null);

  const [status, setStatus] = useState<GenStatus>("idle");
  const [tool, setTool] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [priorCount, setPriorCount] = useState<number | null>(null);

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

  // --- Load encounter + templates --------------------------------------------
  useEffect(() => {
    let active = true;
    Promise.all([api.getEncounter(encId), api.listTemplates()])
      .then(([detail, tmpls]) => {
        if (!active) return;
        setEnc(detail);
        setTemplates(tmpls);
        setTemplateId(detail.template_id);
        setTranscript(detail.transcript ?? "");
        setPriorCount(detail.prior_encounter_count);
        setEncStatus(detail.status);
        setCurrentVersionNo(detail.current_version_no);
        setBasedOn(detail.current_version_no ?? 0);

        if (detail.status === "finalized" && detail.current_version_no) {
          // Land directly on the saved note (not the draft working_note).
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
          // Restore in-progress draft exactly.
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

  // --- Debounced autosave (transcript + working_note) to RDS -----------------
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
      if (!p.parsedAny && rawRef.current.trim()) {
        // Malformed output: show raw text rather than blank panes.
        setRawFallback(rawRef.current);
      }
      setStatus("done");
    } else if (e.type === "error") {
      setTool(null);
      if (e.message === "unauthorized") { pendingSave.current = false; setReauthOpen(true); setStatus("interrupted"); }
      else { setStatus("interrupted"); setGenError(e.detail || "Generation was interrupted."); }
    }
  }, []);

  const generate = useCallback(async () => {
    if (!transcript.trim()) { toast.warning("Enter a transcript or observations first."); return; }
    await persist();
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

  // --- ICD widget append (-> Assessment + provider_added code) ---------------
  const appendCode = useCallback((r: IcdSearchResult) => {
    setCodes((prev) =>
      prev.some((c) => c.code === r.code)
        ? prev
        : [...prev, { code: r.code, description: r.description, is_primary: false, source: "provider_added" }],
    );
    setSections((s) => ({
      ...s,
      assessment: s.assessment + (s.assessment && !s.assessment.endsWith("\n") ? "\n" : "") + `${r.code} — ${r.description}`,
    }));
    toast.success(`Added ${r.code}`);
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
  const patient = enc?.patient;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {/* Workspace toolbar */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-2">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => navigate("/")}>
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">
                {patient ? `${patient.last_name}, ${patient.first_name}` : "…"}
              </span>
              {patient && (
                <span className="font-mono text-xs text-muted-foreground">DOB {patient.dob}</span>
              )}
              <Badge
                variant="outline"
                className={encStatus === "finalized" ? "border-success/40 text-success" : "border-warning/40 text-warning"}
              >
                {encStatus}
              </Badge>
              {priorCount !== null && priorCount > 0 && (
                <Badge variant="outline" className="gap-1 border-primary/30 text-primary">
                  <UserCheck className="h-3 w-3" />
                  {priorCount} prior encounter{priorCount > 1 ? "s" : ""}
                </Badge>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setDrawerOpen(true)}>
            <History className="h-3.5 w-3.5" />
            History{currentVersionNo ? ` (v${currentVersionNo})` : ""}
          </Button>
          <Button size="sm" className="h-8 gap-1.5" disabled={saving || status === "streaming" || !hasContent} onClick={doSave}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save version
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

      {/* Three-pane: input | SOAP | docked codes+ICD */}
      <div className="grid min-h-0 flex-1 grid-cols-[340px_1fr_330px] divide-x divide-border">
        {/* INPUT */}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Template</label>
            <Select
              value={templateId ? String(templateId) : undefined}
              onValueChange={(v) => setTemplateId(Number(v))}
              disabled={status === "streaming"}
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select an encounter type…" /></SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)} className="text-xs">{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Transcript or observations
            </label>
            <Textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Paste the encounter transcript or type clinical observations…"
              className="min-h-[280px] flex-1 resize-none text-xs leading-relaxed"
              disabled={status === "streaming"}
            />
          </div>

          <Button onClick={generate} disabled={status === "streaming"} className="gap-1.5">
            {status === "streaming" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {status === "streaming" ? "Generating…" : "Generate note"}
          </Button>

          {status === "streaming" && tool && (
            <p className="flex items-center gap-1.5 text-xs text-primary">
              <Loader2 className="h-3 w-3 animate-spin" />
              {TOOL_LABEL[tool] ?? tool}
            </p>
          )}
        </div>

        {/* SOAP */}
        <div className="min-h-0 overflow-y-auto bg-muted/20 p-4">
          {status === "insufficient" ? (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-sm rounded-md border border-warning/40 bg-warning/5 p-6 text-center">
                <AlertTriangle className="mx-auto h-6 w-6 text-warning" />
                <h3 className="mt-2 text-sm font-semibold">No clinical content detected</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  The input doesn’t contain clinical observations. Add details and generate again — no note was fabricated.
                </p>
              </div>
            </div>
          ) : rawFallback ? (
            <div className="rounded-md border border-warning/40 bg-warning/5 p-4">
              <p className="mb-2 text-xs font-medium text-warning">
                Couldn’t split the response into sections — showing the full text, please review.
              </p>
              <pre className="whitespace-pre-wrap text-xs leading-relaxed">{rawFallback}</pre>
            </div>
          ) : (
            <>
              {status === "interrupted" && (
                <div className="mb-3 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <span className="flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Generation interrupted — note is incomplete. {genError}
                  </span>
                  <Button size="sm" variant="outline" className="h-6 text-xs" onClick={generate}>Retry</Button>
                </div>
              )}
              {status === "idle" && !hasContent && (
                <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                  <FileText className="h-4 w-4 opacity-50" />
                  Enter a transcript and generate a note, or type the SOAP sections directly below.
                </div>
              )}
              {/* Panes always render (except insufficient / malformed) so a
                  provider can type directly or review streamed content. */}
              <div className="grid grid-cols-2 gap-3">
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

        {/* DOCKED: codes + ICD search */}
        <div className="flex min-h-0 flex-col divide-y divide-border overflow-hidden">
          <div className="flex min-h-0 flex-[3] flex-col overflow-hidden">
            <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Diagnoses (ICD-10)
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <CodesPanel
                codes={codes}
                editable={editable}
                onTogglePrimary={(code) =>
                  setCodes((prev) => prev.map((c) => (c.code === code ? { ...c, is_primary: !c.is_primary } : c)))
                }
                onRemove={(code) => setCodes((prev) => prev.filter((c) => c.code !== code))}
              />
            </div>
          </div>
          <div className="flex min-h-0 flex-[4] flex-col overflow-hidden">
            <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              ICD-10 search
            </div>
            <IcdSearchPanel onAppend={appendCode} disabled={status === "streaming"} />
          </div>
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
