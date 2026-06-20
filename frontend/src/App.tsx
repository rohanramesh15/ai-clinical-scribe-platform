import { useEffect, useState } from "react";

// M0 placeholder screen: proves the toolchain builds and the SPA can reach the
// backend through the same-origin /api proxy. Replaced by the real router +
// screens (Login, Encounter list, Note workspace, Admin) in M8.
export default function App() {
  const [health, setHealth] = useState<string>("checking…");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setHealth(d.status ?? "unknown"))
      .catch(() => setHealth("unreachable"));
  }, []);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="border border-clinical-border bg-clinical-surface px-8 py-6">
        <h1 className="text-lg font-semibold text-clinical-ink">
          Clinical Scribe
        </h1>
        <p className="mt-1 text-clinical-muted">
          Scaffold online. API health:{" "}
          <span className="font-mono text-clinical-primary">{health}</span>
        </p>
      </div>
    </div>
  );
}
