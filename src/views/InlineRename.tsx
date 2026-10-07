import { useEffect, useId, useRef, useState } from "react";
import { checkName } from "../stores/sidebarModel";

/**
 * Renaming in place, for chats and projects alike.
 *
 * The current name arrives selected, so typing replaces it. Enter saves and
 * Escape cancels. Clicking away saves a valid change and quietly restores an
 * empty one -- an empty name is never saved. The parent decides where focus
 * goes afterwards.
 */
export function InlineRename({ initial, what, label, hint, className = "", onSave, onDone }: {
  initial: string;
  what: "chat" | "project";
  /** Accessible name of the field, e.g. "Rename chat". */
  label: string;
  /** One line under the field, e.g. that the folder keeps its name. */
  hint?: string;
  className?: string;
  /** Called with a valid, changed name. */
  onSave: (name: string) => void;
  /** Called once editing ends, saved or not. */
  onDone: () => void;
}): React.ReactElement {
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const hintId = useId();

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = (save: boolean, fromBlur = false) => {
    if (finished.current) return;
    const check = checkName(value, what);
    if (save && !check.ok) {
      if (fromBlur) { finished.current = true; onDone(); return; }
      setProblem(check.message);
      return;
    }
    finished.current = true;
    if (save && check.ok && check.value !== initial) onSave(check.value);
    onDone();
  };

  return <span className={`inline-rename ${className}`}>
    <input
      ref={input}
      className="inline-rename__input"
      aria-label={label}
      aria-invalid={problem !== null}
      aria-describedby={problem || hint ? hintId : undefined}
      value={value}
      maxLength={200}
      spellCheck={false}
      onChange={event => { setValue(event.target.value); setProblem(null); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Enter") { event.preventDefault(); finish(true); }
        if (event.key === "Escape") { event.preventDefault(); finish(false); }
      }}
      onBlur={() => finish(true, true)}
      onClick={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
      onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
    />
    {(problem || hint) && <span id={hintId} className={`inline-rename__hint${problem ? " is-error" : ""}`} role={problem ? "alert" : undefined}>{problem ?? hint}</span>}
  </span>;
}
