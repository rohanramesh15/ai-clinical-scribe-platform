// Minimal word-level diff (LCS) for the version-diff pioneer feature.
// Tokenizes on whitespace boundaries (keeping the whitespace) so spacing is
// preserved, then backtracks an LCS table into added/removed/unchanged parts.

export interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

export function diffWords(oldStr: string, newStr: string): DiffPart[] {
  const a = tokenize(oldStr);
  const b = tokenize(newStr);
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (value: string, kind: "added" | "removed" | "same") => {
    const last = parts[parts.length - 1];
    if (last && ((kind === "added" && last.added) || (kind === "removed" && last.removed) ||
      (kind === "same" && !last.added && !last.removed))) {
      last.value += value;
    } else {
      parts.push({ value, added: kind === "added" || undefined, removed: kind === "removed" || undefined });
    }
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(a[i], "same"); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(a[i], "removed"); i++; }
    else { push(b[j], "added"); j++; }
  }
  while (i < n) { push(a[i], "removed"); i++; }
  while (j < m) { push(b[j], "added"); j++; }
  return parts;
}
