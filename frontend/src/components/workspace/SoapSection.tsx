import { useEffect, useRef } from "react";
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

// One headed, independently-editable SOAP section. Headings are rendered FROM
// the field — never parsed back out of a blob. Height tracks content (auto-
// grow textarea) rather than filling a fixed grid cell, since sections are
// now stacked vertically and each should take only as much room as its text.
export function SoapSection({ title, value, onChange, editable, streaming, missing }: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <div className="flex flex-col rounded-md border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {streaming && (
          <span className="flex items-center gap-1 text-[10px] text-primary">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            writing
          </span>
        )}
        {missing && !streaming && (
          <span className="text-[10px] font-medium text-warning">not generated</span>
        )}
      </div>
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={!editable}
        placeholder={editable ? `${title}…` : ""}
        rows={1}
        className={cn(
          "min-h-[80px] resize-none overflow-hidden rounded-none border-0 bg-transparent font-normal leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0",
          missing && !streaming && "bg-warning/5",
        )}
      />
    </div>
  );
}
