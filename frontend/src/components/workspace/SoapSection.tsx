import { useEffect, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Props {
  title: string;
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
  streaming?: boolean;
  /** True when generation finished/failed but this section has no content. */
  missing?: boolean;
}

const REVEAL_TICK_MS = 35;

// Splits into alternating word / whitespace tokens (whitespace kept so
// newlines and spacing survive exactly) — only word tokens get an
// entrance animation.
function tokenize(text: string): { text: string; word: boolean }[] {
  return text
    .split(/(\s+)/)
    .filter((t) => t.length > 0)
    .map((t) => ({ text: t, word: !/^\s+$/.test(t) }));
}

// One headed, independently-editable SOAP section. Headings are rendered FROM
// the field — never parsed back out of a blob. Height tracks content (auto-
// grow textarea) rather than filling a fixed grid cell, since sections are
// now stacked vertically and each should take only as much room as its text.
export function SoapSection({ title, value, onChange, editable, streaming, missing }: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  // Paced word-by-word reveal while streaming, so fast/bursty SSE chunks
  // still read as text being written rather than dumped in all at once.
  // `revealedLength` chases `value` (via valueRef, so the interval always
  // sees the latest chunk) at a steady per-word cadence, catching up faster
  // if a big burst puts it far behind.
  const [revealedLength, setRevealedLength] = useState(0);

  useEffect(() => {
    if (!streaming) return;
    setRevealedLength(0);
    const id = window.setInterval(() => {
      setRevealedLength((prev) => {
        const full = valueRef.current;
        if (prev >= full.length) return prev;
        const remaining = full.slice(prev);
        const backlog = remaining.length;
        const minChars = backlog > 200 ? Math.ceil(backlog / 6) : 1;
        let take = 0;
        while (take < minChars && prev + take < full.length) {
          const m = full.slice(prev + take).match(/^\s*\S+\s*/);
          take += m && m[0].length > 0 ? m[0].length : full.length - (prev + take);
        }
        return Math.min(prev + take, full.length);
      });
    }, REVEAL_TICK_MS);
    return () => window.clearInterval(id);
  }, [streaming]);

  return (
    <div className="flex flex-col rounded-md border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {missing && !streaming && (
          <span className="text-[10px] font-medium text-warning">not generated</span>
        )}
      </div>
      {streaming ? (
        <div className="min-h-[80px] whitespace-pre-wrap px-3 py-2 font-normal leading-relaxed">
          {tokenize(value.slice(0, revealedLength)).map((tok, i) =>
            tok.word ? (
              <span key={i} className="inline-block animate-fade-up">{tok.text}</span>
            ) : (
              <span key={i}>{tok.text}</span>
            ),
          )}
          <span className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse bg-primary align-text-bottom" />
        </div>
      ) : (
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={!editable}
          placeholder={editable ? `${title}…` : ""}
          rows={1}
          className={cn(
            "min-h-[80px] resize-none overflow-hidden rounded-none border-0 bg-transparent font-normal leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0",
            missing && "bg-warning/5",
          )}
        />
      )}
    </div>
  );
}
