import { useEffect, useState } from "react";
import { Clock, GitCompare, Loader2 } from "lucide-react";
import { api } from "@/api/client";
import type { VersionDetail, VersionListItem } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { diffWords } from "@/lib/diff";
import { cn } from "@/lib/utils";

const SECTION_KEYS = ["subjective", "objective", "assessment", "plan"] as const;

function DiffText({ before, after }: { before: string; after: string }) {
  return (
    <p className="whitespace-pre-wrap text-xs leading-relaxed">
      {diffWords(before, after).map((part, i) =>
        part.added ? (
          <span key={i} className="rounded-sm bg-success/15 text-[hsl(var(--success))]">{part.value}</span>
        ) : part.removed ? (
          <span key={i} className="rounded-sm bg-destructive/10 text-destructive line-through">{part.value}</span>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </p>
  );
}

interface Props {
  encounterId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  refreshKey: number;
  currentVersionNo: number | null;
}

function fmt(ts: string) {
  return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function VersionDrawer({ encounterId, open, onOpenChange, refreshKey, currentVersionNo }: Props) {
  const [list, setList] = useState<VersionListItem[] | null>(null);
  const [selected, setSelected] = useState<VersionDetail | null>(null);
  const [prev, setPrev] = useState<VersionDetail | null>(null);
  const [diffOn, setDiffOn] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setDiffOn(false);
    setPrev(null);
    api.listVersions(encounterId).then(setList).catch(() => setList([]));
  }, [open, encounterId, refreshKey]);

  async function view(no: number) {
    setLoadingDetail(true);
    setDiffOn(false);
    setPrev(null);
    try {
      setSelected(await api.getVersion(encounterId, no));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function toggleDiff() {
    if (!selected) return;
    if (diffOn) { setDiffOn(false); return; }
    if (!prev && selected.version_no > 1) {
      setPrev(await api.getVersion(encounterId, selected.version_no - 1));
    }
    setDiffOn(true);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="text-sm">Version history</SheetTitle>
        </SheetHeader>

        <div className="flex min-h-0 flex-1">
          {/* version list */}
          <div className="w-44 shrink-0 overflow-y-auto border-r border-border">
            {list === null && (
              <div className="flex justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {list?.length === 0 && (
              <p className="px-3 py-4 text-xs text-muted-foreground">No versions yet.</p>
            )}
            <ul>
              {list?.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => view(v.version_no)}
                    className={cn(
                      "w-full border-b border-border px-3 py-2 text-left hover:bg-accent",
                      selected?.version_no === v.version_no && "bg-accent",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">v{v.version_no}</span>
                      {v.version_no === currentVersionNo && (
                        <Badge variant="outline" className="text-[9px] uppercase">current</Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Clock className="h-2.5 w-2.5" />
                      {fmt(v.created_at)}
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {v.created_by_email}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* selected version content */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {loadingDetail && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {!loadingDetail && !selected && (
              <p className="text-xs text-muted-foreground">Select a version to view.</p>
            )}
            {selected && (
              <div className="space-y-3">
                {selected.version_no > 1 && (
                  <Button
                    variant={diffOn ? "default" : "outline"}
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={toggleDiff}
                  >
                    <GitCompare className="h-3.5 w-3.5" />
                    {diffOn ? `Showing changes vs v${selected.version_no - 1}` : `Show changes vs v${selected.version_no - 1}`}
                  </Button>
                )}
                {SECTION_KEYS.map((k) => (
                  <div key={k}>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {k}
                    </div>
                    {diffOn && prev ? (
                      <DiffText before={prev[k]} after={selected[k]} />
                    ) : (
                      <p className="whitespace-pre-wrap text-xs leading-relaxed">
                        {selected[k] || <span className="text-muted-foreground">—</span>}
                      </p>
                    )}
                  </div>
                ))}
                {selected.diagnoses.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Diagnoses
                    </div>
                    <ul className="mt-1 space-y-1">
                      {selected.diagnoses.map((d) => (
                        <li key={d.code} className="flex gap-2 text-xs">
                          <span className="w-20 font-mono font-semibold">{d.code}</span>
                          <span className="flex-1">{d.description}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <Button variant="outline" size="sm" className="mt-2" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
