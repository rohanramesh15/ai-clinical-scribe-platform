import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { api } from "@/api/client";
import type { IcdSearchResult } from "@/api/types";
import { Input } from "@/components/ui/input";

interface Props {
  onAppend: (r: IcdSearchResult) => void;
  disabled?: boolean;
}

// Compact ICD-10 semantic search for the workspace toolbar. Plain-English ->
// ranked grounded codes shown in a dropdown; clicking one appends it to the
// Assessment as a provider_added diagnosis.
export function IcdSearchBar({ onAppend, disabled }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<IcdSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

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

  // Close the dropdown on an outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const showDropdown = open && q.trim().length >= 2;

  return (
    <div ref={boxRef} className="relative w-full">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search ICD-10 codes by symptom or condition"
        className="h-8 pl-7 text-xs"
        disabled={disabled}
      />
      {showDropdown && (
        <div className="absolute left-0 right-0 top-9 z-50 max-h-80 overflow-y-auto rounded-md border border-border bg-card shadow-md">
          {loading && (
            <div className="flex justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && results.length === 0 && (
            <p className="px-3 py-3 text-xs text-muted-foreground">No matches.</p>
          )}
          <ul className="divide-y divide-border">
            {results.map((r) => (
              <li key={r.code}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => { onAppend(r); setQ(""); setResults([]); setOpen(false); }}
                  className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent disabled:opacity-50"
                >
                  <span title="Add to Assessment" className="shrink-0">
                    <Plus className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary" />
                  </span>
                  <span className="w-20 shrink-0 font-mono text-xs font-semibold">{r.code}</span>
                  <span className="flex-1 truncate text-xs" title={r.description}>{r.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
