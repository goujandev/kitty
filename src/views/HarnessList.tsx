import { rescan, useHarnessState } from "../stores/harnessStore";
import { HarnessCard } from "./HarnessCard";

export function HarnessList(): React.ReactElement {
  const { phase, scan, error } = useHarnessState();
  const scanning = phase === "scanning";

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Agents</h1>
          <p className="page__subtitle">{summary(phase, scan, error)}</p>
        </div>
        <button
          type="button"
          className="button"
          disabled={scanning}
          onClick={() => {
            void rescan();
          }}
        >
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </header>

      {error && (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      )}

      {scan ? (
        <div className="grid">
          {scan.harnesses.map((status) => (
            <HarnessCard key={status.id} status={status} />
          ))}
        </div>
      ) : (
        <div className="grid">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}
    </div>
  );
}

function summary(
  phase: ReturnType<typeof useHarnessState>["phase"],
  scan: ReturnType<typeof useHarnessState>["scan"],
  error: string | null,
): string {
  if (phase === "scanning" && !scan) return "Looking for installed agents…";
  if (error) return "The last scan did not finish.";
  if (!scan) return "Nothing scanned yet.";

  const ready = scan.harnesses.filter((h) => h.ready).length;
  const total = scan.harnesses.length;
  const where = `${scan.pathDirs} PATH ${scan.pathDirs === 1 ? "entry" : "entries"}`;

  if (ready === total) {
    return `All ${total} ready. Searched ${where} in ${scan.durationMs} ms.`;
  }
  return `${ready} of ${total} ready. Searched ${where} in ${scan.durationMs} ms.`;
}

function SkeletonCard(): React.ReactElement {
  return (
    <div className="card card--skeleton" aria-hidden="true">
      <div className="skeleton skeleton--title" />
      <div className="skeleton skeleton--line" />
      <div className="skeleton skeleton--line skeleton--short" />
    </div>
  );
}
