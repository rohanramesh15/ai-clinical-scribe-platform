import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { api } from "@/api/client";
import type { IcdSearchResult } from "@/api/types";
import { Input } from "@/components/ui/input";

interface Props {
  onAppend: (r: IcdSearchResult) => void;
  disabled?: boolean;
}

// Standalone ICD-10 semantic search. Plain-English -> ranked grounded codes.
// Clicking a result appends it to the Assessment as a provider_added diagnosis.
export function IcdSearchPanel({ onAppend, disabled }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<IcdSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timer.current = window.setTimeout(async () => {
      try {
        setResults(await api.icdSearch(query, 10));
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [q]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="relative px-3 pt-3">
        <Search className="pointer-events-none absolute left-5 top-[1.15rem] h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search ICD-10 (e.g. low back pain)…"
          className="h-8 pl-7 text-xs"
          disabled={disabled}
        />
      </div>
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && q.trim().length >= 2 && results.length === 0 && (
          <p className="px-3 py-3 text-xs text-muted-foreground">No matches.</p>
        )}
        <ul className="divide-y divide-border">
          {results.map((r) => (
            <li key={r.code}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onAppend(r)}
                className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                <span className="w-20 shrink-0 font-mono text-xs font-semibold">{r.code}</span>
                <span className="flex-1 truncate text-xs" title={r.description}>
                  {r.description}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {r.score.toFixed(2)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
