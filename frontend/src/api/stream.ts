// SSE consumed via fetch() + ReadableStream (NOT EventSource — we need a POST
// body and the auth cookie). Plus the delimiter state machine that routes the
// streamed text into four section buffers + a codes block.

import { readCookie } from "./client";

export type GenEvent =
  | { type: "meta"; prior_encounter_count: number }
  | { type: "tool"; name: string }
  | { type: "delta"; text: string }
  | { type: "insufficient" }
  | { type: "done" }
  | { type: "error"; message: string; detail?: string };

export interface GenerateBody {
  transcript: string;
  template_id?: number | null;
}

export async function streamGeneration(
  encounterId: number,
  body: GenerateBody,
  onEvent: (e: GenEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const csrf = readCookie("scribe_csrf");
  const res = await fetch(`/api/encounters/${encounterId}/generate`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    body: JSON.stringify(body),
    signal,
  });

  if (res.status === 401) return onEvent({ type: "error", message: "unauthorized" });
  if (res.status === 403) return onEvent({ type: "error", message: "forbidden" });
  if (!res.ok || !res.body) return onEvent({ type: "error", message: `http_${res.status}` });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (frame.startsWith("data:")) {
        try {
          onEvent(JSON.parse(frame.slice(5).trim()) as GenEvent);
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}

// --- Delimiter parser -------------------------------------------------------

const OPEN = {
  subjective: "‹SUBJECTIVE›",
  objective: "‹OBJECTIVE›",
  assessment: "‹ASSESSMENT›",
  plan: "‹PLAN›",
} as const;
const CLOSE = {
  subjective: "‹/SUBJECTIVE›",
  objective: "‹/OBJECTIVE›",
  assessment: "‹/ASSESSMENT›",
  plan: "‹/PLAN›",
} as const;
const CODES_OPEN = "‹CODES›";
const CODES_CLOSE = "‹/CODES›";
const INSUFFICIENT = "‹INSUFFICIENT_CONTENT›";

const ALL_SENTINELS = [
  ...Object.values(OPEN),
  ...Object.values(CLOSE),
  CODES_OPEN,
  CODES_CLOSE,
];

export interface ParsedCode {
  code: string;
  description: string;
  is_primary: boolean;
}

export interface ParsedNote {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  codes: ParsedCode[];
  insufficient: boolean;
  parsedAny: boolean; // at least one delimiter recognized
  raw: string;
}

function nextSentinelIndex(raw: string, from: number): number {
  let min = -1;
  for (const s of ALL_SENTINELS) {
    const i = raw.indexOf(s, from);
    if (i >= 0 && (min === -1 || i < min)) min = i;
  }
  return min;
}

function extractSection(raw: string, open: string, close: string): string | null {
  const i = raw.indexOf(open);
  if (i < 0) return null;
  const start = i + open.length;
  let end = raw.indexOf(close, start);
  if (end < 0) {
    // Open but not yet closed (still streaming): read up to the next sentinel.
    end = nextSentinelIndex(raw, start);
  }
  return (end < 0 ? raw.slice(start) : raw.slice(start, end)).trim();
}

function parseCodes(raw: string): ParsedCode[] {
  const i = raw.indexOf(CODES_OPEN);
  if (i < 0) return [];
  const start = i + CODES_OPEN.length;
  let end = raw.indexOf(CODES_CLOSE, start);
  if (end < 0) end = raw.length;
  const block = raw.slice(start, end);
  const codes: ParsedCode[] = [];
  for (const line of block.split("\n")) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length >= 2 && parts[0]) {
      codes.push({
        code: parts[0],
        description: parts[1] ?? "",
        is_primary: (parts[2] ?? "").toLowerCase() === "primary",
      });
    }
  }
  return codes;
}

export function parseSoap(raw: string): ParsedNote {
  if (raw.includes(INSUFFICIENT)) {
    return {
      subjective: "", objective: "", assessment: "", plan: "",
      codes: [], insufficient: true, parsedAny: true, raw,
    };
  }
  const subjective = extractSection(raw, OPEN.subjective, CLOSE.subjective);
  const objective = extractSection(raw, OPEN.objective, CLOSE.objective);
  const assessment = extractSection(raw, OPEN.assessment, CLOSE.assessment);
  const plan = extractSection(raw, OPEN.plan, CLOSE.plan);
  const codes = parseCodes(raw);
  const parsedAny =
    subjective !== null || objective !== null || assessment !== null ||
    plan !== null || codes.length > 0;
  return {
    subjective: subjective ?? "",
    objective: objective ?? "",
    assessment: assessment ?? "",
    plan: plan ?? "",
    codes,
    insufficient: false,
    parsedAny,
    raw,
  };
}
