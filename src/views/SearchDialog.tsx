import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { clearSearch, search, useProjects } from "../stores/projectStore";
import { Icon } from "./Icon";

export function SearchDialog({ onClose, onOpenSession }: {
  onClose: () => void;
  onOpenSession: (projectId: string, sessionId: string) => void;
}): React.ReactElement {
  const { query, results, searching, error } = useProjects();
  const dialog = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    clearSearch();
    input.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
      ) ?? []);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      clearSearch();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => { setSelected(0); }, [results]);
  useEffect(() => {
    dialog.current?.querySelector(`#thread-search-hit-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const open = (index: number) => {
    const hit = results[index];
    if (!hit) return;
    onOpenSession(hit.projectId, hit.sessionId);
    onClose();
  };

  return createPortal(<div className="search-overlay" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="search-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label="Search every conversation">
      <header className="search-dialog__head"><Icon name="search" size={19} />
        <input ref={input} role="combobox" aria-label="Search every conversation" aria-autocomplete="list"
          aria-expanded={results.length > 0} aria-haspopup="listbox" placeholder="Search every conversation…" value={query}
          aria-controls="thread-search-results" aria-activedescendant={results[selected] ? `thread-search-hit-${selected}` : undefined}
          onChange={(event) => { void search(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && results.length) {
              event.preventDefault(); setSelected((current) => (current + 1) % results.length);
            } else if (event.key === "ArrowUp" && results.length) {
              event.preventDefault(); setSelected((current) => (current + results.length - 1) % results.length);
            } else if (event.key === "Enter") { event.preventDefault(); open(selected); }
          }} />
        <span className="search-dialog__key">Esc</span>
        <button type="button" className="ws-icon-button" title="Close search" aria-label="Close search" onClick={onClose}><Icon name="close" size={16} /></button>
      </header>
      <div className="search-dialog__body">
        {error && <p className="ws-error" role="alert">{error}</p>}
        {!query.trim() ? <p className="search-dialog__empty">Find a message from any project or chat.</p>
          : results.length === 0 ? <p className="search-dialog__empty" role="status">{searching ? "Searching…" : "No conversations matched."}</p>
          : <ul className="search-results" role="listbox" id="thread-search-results" aria-label="Matching conversations">
            {results.map((hit, index) => <li key={`${hit.sessionId}:${hit.seq}`} role="presentation">
              <button type="button" role="option" aria-selected={selected === index} id={`thread-search-hit-${index}`} className={`search-hit${selected === index ? " is-selected" : ""}`}
                onFocus={() => setSelected(index)} onClick={() => open(index)}>
                <span className="search-hit__title">{hit.title ?? "Untitled thread"}</span>
                <span className="search-hit__snippet">{hit.snippet}</span>
                <span className="search-hit__meta">{hit.projectName} · {hit.harness === "claude" ? "Claude" : "Codex"}</span>
              </button>
            </li>)}
          </ul>}
      </div>
      <footer className="search-dialog__foot"><span>Searches the full conversation history</span><span>↑ ↓ to select · Enter to open</span></footer>
    </section>
  </div>, document.body);
}
