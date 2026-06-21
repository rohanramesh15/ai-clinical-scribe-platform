import { Star, X } from "lucide-react";
import type { StagedCode } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Props {
  codes: StagedCode[];
  editable: boolean;
  onTogglePrimary: (code: string) => void;
  onRemove: (code: string) => void;
}

// Grounded ICD-10 codes attached to the note. Tabular/monospace, source-tagged.
// AI-suggested vs provider-added are visually distinct for trust.
export function CodesPanel({ codes, editable, onTogglePrimary, onRemove }: Props) {
  if (codes.length === 0) {
    return (
      <p className="px-3 py-3 text-xs text-muted-foreground">
        No diagnoses yet. Generate a note or use ICD-10 search.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {codes.map((c) => (
        <li key={c.code} className="flex items-center gap-2 px-3 py-2">
          <button
            type="button"
            disabled={!editable}
            onClick={() => onTogglePrimary(c.code)}
            title={c.is_primary ? "Primary diagnosis" : "Mark primary"}
            className={cn(
              "shrink-0",
              c.is_primary ? "text-warning" : "text-muted-foreground/40",
              editable && "hover:text-warning",
            )}
          >
            <Star className={cn("h-3.5 w-3.5", c.is_primary && "fill-current")} />
          </button>
          <span className="w-20 shrink-0 font-mono text-xs font-semibold">{c.code}</span>
          <span className="flex-1 truncate text-xs text-foreground" title={c.description}>
            {c.description}
          </span>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 text-[9px] uppercase",
              c.source === "ai_suggested"
                ? "border-primary/30 text-primary"
                : "border-muted-foreground/30 text-muted-foreground",
            )}
          >
            {c.source === "ai_suggested" ? "AI" : "added"}
          </Badge>
          {editable && (
            <button
              type="button"
              onClick={() => onRemove(c.code)}
              className="shrink-0 text-muted-foreground/50 hover:text-destructive"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
