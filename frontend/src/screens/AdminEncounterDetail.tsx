import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { api } from "@/api/client";
import type { AdminEncounterView } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function fmt(ts: string) {
  return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function AdminEncounterDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<AdminEncounterView | null>(null);

  useEffect(() => {
    api.adminEncounterDetail(Number(id)).then(setView).catch(() => setView(null));
  }, [id]);

  if (!view) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  const v = view.current_version;
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-6">
      <Button variant="ghost" size="sm" className="mb-3 gap-1.5" onClick={() => navigate("/admin")}>
        <ArrowLeft className="h-3.5 w-3.5" />Back
      </Button>

      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg font-semibold">
          {view.patient.last_name}, {view.patient.first_name}
        </h1>
        <span className="font-mono text-xs text-muted-foreground">DOB {view.patient.dob}</span>
        <Badge variant="outline">{view.status}</Badge>
        <span className="font-mono text-xs text-muted-foreground">{view.provider_email}</span>
      </div>

      <div className="grid grid-cols-[1fr_220px] gap-4">
        {/* Current note (read-only) */}
        <div className="space-y-3">
          {!v && <p className="text-sm text-muted-foreground">No finalized note for this encounter.</p>}
          {v && (["subjective", "objective", "assessment", "plan"] as const).map((k) => (
            <div key={k} className="rounded-md border border-border bg-card">
              <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {k}
              </div>
              <p className="whitespace-pre-wrap px-3 py-2 text-xs leading-relaxed">
                {v[k] || <span className="text-muted-foreground">—</span>}
              </p>
            </div>
          ))}
          {v && v.diagnoses.length > 0 && (
            <div className="rounded-md border border-border bg-card">
              <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Diagnoses
              </div>
              <ul className="divide-y divide-border">
                {v.diagnoses.map((d) => (
                  <li key={d.code} className="flex items-center gap-2 px-3 py-2 text-xs">
                    <span className="w-20 font-mono font-semibold">{d.code}</span>
                    <span className="flex-1">{d.description}</span>
                    <Badge variant="outline" className="text-[9px] uppercase">
                      {d.source === "ai_suggested" ? "AI" : "added"}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Version history (read-only) */}
        <div className="rounded-md border border-border bg-card">
          <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Versions
          </div>
          <ul className="divide-y divide-border">
            {view.versions.map((ver) => (
              <li key={ver.id} className="px-3 py-2">
                <div className="text-xs font-semibold">v{ver.version_no}</div>
                <div className="text-[10px] text-muted-foreground">{fmt(ver.created_at)}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">{ver.created_by_email}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  );
}
