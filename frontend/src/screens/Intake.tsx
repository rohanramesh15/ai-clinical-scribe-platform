import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Sparkles, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api } from "@/api/client";
import type { EncounterDetail, TemplateSummary } from "@/api/types";
import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

// Stage 2 of the encounter flow: choose a template and enter the transcript,
// then Generate. Generation itself runs in the workspace (stage 3), which we
// navigate to with an autoGenerate flag.
export default function Intake() {
  const { id } = useParams();
  const encId = Number(id);
  const navigate = useNavigate();
  const { handleAuthError } = useAuth();

  const [enc, setEnc] = useState<EncounterDetail | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [transcript, setTranscript] = useState("");
  const [priorCount, setPriorCount] = useState<number | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    let active = true;
    Promise.all([api.getEncounter(encId), api.listTemplates()])
      .then(([detail, tmpls]) => {
        if (!active) return;
        // If a real note already exists, skip intake and go straight to the
        // workspace. An empty working_note (e.g. saved after an "insufficient
        // content" generation) does NOT count — otherwise editing the transcript
        // would bounce straight back here.
        const w = detail.working_note;
        const hasNote =
          !!w && [w.subjective, w.objective, w.assessment, w.plan].some((s) => s.trim() !== "");
        if (detail.status === "finalized" || hasNote) {
          navigate(`/encounters/${encId}`, { replace: true });
          return;
        }
        setEnc(detail);
        setTemplates(tmpls);
        setTemplateId(detail.template_id);
        setTranscript(detail.transcript ?? "");
        setPriorCount(detail.prior_encounter_count);
        loaded.current = true;
      })
      .catch((e) => {
        handleAuthError(e);
        toast.error("Could not load encounter.");
      });
    return () => { active = false; };
  }, [encId, handleAuthError, navigate]);

  // Re-fetch on dropdown open so an admin's template change shows without refresh.
  const loadTemplates = useCallback(async () => {
    try {
      setTemplates(await api.listTemplates());
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) handleAuthError(e);
    }
  }, [handleAuthError]);

  // Debounced autosave (transcript + template) so a refresh restores the intake.
  const persist = useCallback(async () => {
    try {
      await api.autosave(encId, { transcript, template_id: templateId });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) handleAuthError(e);
    }
  }, [encId, transcript, templateId, handleAuthError]);

  useEffect(() => {
    if (!loaded.current) return;
    const t = window.setTimeout(persist, 800);
    return () => window.clearTimeout(t);
  }, [persist]);

  async function generate() {
    if (!transcript.trim()) {
      toast.warning("Enter a transcript or observations first.");
      return;
    }
    await persist(); // ensure the latest transcript + template are saved first
    navigate(`/encounters/${encId}`, { state: { autoGenerate: true } });
  }

  const patient = enc?.patient;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-6">
      <Button variant="ghost" size="sm" className="mb-3 h-7 w-fit gap-1 px-2" onClick={() => navigate("/")}>
        <ArrowLeft className="h-3.5 w-3.5" /> Encounters
      </Button>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold tracking-tight">
          {patient ? `${patient.last_name}, ${patient.first_name}` : "…"}
        </h1>
        {patient && <span className="font-mono text-xs text-muted-foreground">DOB {patient.dob}</span>}
        {priorCount !== null && priorCount > 0 && (
          <Badge variant="outline" className="gap-1 border-primary/30 text-primary">
            <UserCheck className="h-3 w-3" />
            {priorCount} prior encounter{priorCount > 1 ? "s" : ""}
          </Badge>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Template</label>
        <Select
          value={templateId ? String(templateId) : undefined}
          onValueChange={(v) => setTemplateId(Number(v))}
          onOpenChange={(o) => { if (o) void loadTemplates(); }}
        >
          <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select an encounter type…" /></SelectTrigger>
          <SelectContent>
            {templates.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                No templates available. You can still generate without one, or ask an admin to add a template.
              </div>
            ) : (
              templates.map((t) => (
                <SelectItem key={t.id} value={String(t.id)} className="text-xs">{t.name}</SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col space-y-1.5">
        <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Transcript or observations
        </label>
        <Textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Paste the encounter transcript or type clinical observations…"
          className="min-h-[320px] flex-1 resize-none text-sm leading-relaxed"
        />
      </div>

      <Button onClick={generate} disabled={!transcript.trim()} className="mt-4 w-fit gap-1.5">
        <Sparkles className="h-4 w-4" /> Generate note
      </Button>
    </main>
  );
}
