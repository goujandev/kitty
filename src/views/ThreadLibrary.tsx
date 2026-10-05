import { useMemo, useState } from "react";

import { useThreadIndex } from "../hooks/useThreadIndex";
import { useChat } from "../stores/chatStore";
import { Icon } from "./Icon";

type Filter = "all" | "working" | "claude" | "codex";
const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All threads" },
  { id: "working", label: "Working" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];

export function ThreadLibrary({ onOpenSession, onNewThread }: {
  onOpenSession: (projectId: string, sessionId: string) => void;
  onNewThread: () => void;
}): React.ReactElement {
  const { threads, loading, error, refresh } = useThreadIndex();
  const { running } = useChat();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return threads.filter(({ session, project }) => {
      if (filter === "working" && !(session.id in running)) return false;
      if ((filter === "claude" || filter === "codex") && session.harness !== filter) return false;
      const searchable = `${session.title ?? ""} ${project.name} ${session.model ?? ""} ${session.harness}`.toLocaleLowerCase();
      return !needle || searchable.includes(needle);
    }).sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  }, [threads, query, filter, running]);

  return <main className="thread-library">
    <header className="thread-library__head">
      <div><h1>Threads</h1><p>Your conversations, across every project.</p></div>
      <button type="button" className="thread-library__new" onClick={onNewThread}>
        <Icon name="plus" size={15} />New thread
      </button>
    </header>
    <div className="thread-library__toolbar">
      <label className="thread-library__search"><Icon name="search" size={16} />
        <input aria-label="Filter threads by title, project, or model" placeholder="Search by title, project, or model…"
          value={query} onChange={(event) => setQuery(event.target.value)} />
        {query && <button type="button" className="ws-icon-button" title="Clear search" aria-label="Clear search"
          onClick={() => setQuery("")}><Icon name="close" size={13} /></button>}
      </label>
      <div className="thread-filters" role="group" aria-label="Filter threads">
        {filters.map((option) => <button type="button" key={option.id}
          className={`thread-filter${filter === option.id ? " is-active" : ""}`}
          aria-pressed={filter === option.id} onClick={() => setFilter(option.id)}>{option.label}</button>)}
      </div>
    </div>
    {error && <div className="ws-error" role="alert">{error} <button type="button" onClick={() => { void refresh(); }}>Try again</button></div>}
    <div className="thread-library__count">{loading ? "Loading threads…" : `${shown.length} ${shown.length === 1 ? "thread" : "threads"}`}</div>
    <ul className="thread-library__list">
      {shown.map(({ session, project }) => {
        const working = session.id in running;
        return <li key={session.id} className="thread-card">
          <button type="button" className="thread-card__open" disabled={!project.exists}
            onClick={() => onOpenSession(project.id, session.id)}>
            <div className="thread-card__mark"><Icon name={project.root ? "code" : "message"} size={18} /></div>
            <div className="thread-card__body"><span className="thread-card__title">{session.title ?? "Untitled thread"}</span>
              <span className="thread-card__meta">{project.name} · {session.model ?? (session.harness === "claude" ? "Claude" : "Codex")}{!project.exists ? " · Folder unavailable" : ""}</span>
            </div>
            <div className="thread-card__aside">
              <span className={`thread-card__state${working ? " is-working" : ""}`}>{working ? "Working" : "Ready"}</span>
              <time dateTime={new Date(session.updatedAt).toISOString()} title={new Date(session.updatedAt).toLocaleString()}>{relativeDate(session.updatedAt)}</time>
            </div>
          </button>
        </li>;
      })}
    </ul>
    {!loading && shown.length === 0 && <div className="thread-library__empty">
      <Icon name="threads" size={28} />
      <h2>{threads.length === 0 ? "Start your first thread" : "No matching threads"}</h2>
      <p>{threads.length === 0 ? "Choose a project or ask a question to get started." : filter === "working" && !query ? "No threads are working right now." : "Try a different search or filter."}</p>
      {threads.length === 0 ? <button type="button" className="thread-library__new" onClick={onNewThread}>New thread</button>
        : <button type="button" className="thread-filter" onClick={() => { setQuery(""); setFilter("all"); }}>Show all threads</button>}
    </div>}
  </main>;
}

function relativeDate(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
