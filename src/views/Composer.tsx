import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

// Drafts stay in memory while the reader moves between projects.
const drafts = new Map<string, string>();
const consumedSuggestions = new Map<string, number>();

/**
 * The input.
 *
 * Enter sends, Shift+Enter makes a newline, Escape stops a running turn. The
 * box grows with its content up to a cap, then scrolls.
 *
 * The model and effort chips sit inside the box rather than above it, because
 * they are part of the same decision as what you are about to type: which
 * agent, thinking how hard, answering this. `tools` is a slot rather than
 * props so the composer stays unaware of what a model even is.
 */
export function Composer({
  busy,
  disabled,
  placeholder,
  tools,
  context,
  onSend,
  onCancel,
  suggestion,
  storageKey,
  label = "Message",
}: {
  busy: boolean;
  disabled: boolean;
  /** What the empty box says when it cannot be typed into. */
  placeholder?: string;
  /** Controls shown along the bottom of the box. */
  tools?: React.ReactNode;
  /** Working folder and usage, in the source composer's attached lower strip. */
  context?: React.ReactNode;
  onSend: (text: string) => void;
  onCancel: () => void;
  suggestion?: { text: string; id: number } | null;
  storageKey: string;
  label?: string;
}): React.ReactElement {
  const [text, setText] = useState(() => drafts.get(storageKey) ?? "");
  const box = useRef<HTMLTextAreaElement>(null);
  const updateText = useCallback((value: string) => {
    if (value) drafts.set(storageKey, value); else drafts.delete(storageKey);
    setText(value);
  }, [storageKey]);
  useEffect(() => {
    if (!suggestion || consumedSuggestions.get(storageKey) === suggestion.id) return;
    consumedSuggestions.set(storageKey, suggestion.id);
    updateText(suggestion.text);
    box.current?.focus();
  }, [suggestion, storageKey, updateText]);

  // Opening a session should leave you ready to type. Anything else makes the
  // first interaction a hunt for the input.
  useEffect(() => {
    if (!disabled) box.current?.focus();
  }, [disabled]);

  // Grow to fit, up to a third of the window.
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    node.style.height = "auto";
    // `scrollHeight` excludes the border, and the box is border-box, so
    // without adding it back the textarea is one pixel short and grows a
    // scrollbar it does not need.
    const border = node.offsetHeight - node.clientHeight;
    const wanted = node.scrollHeight + border;
    node.style.height = `${Math.min(wanted, window.innerHeight / 3)}px`;
  }, [text]);

  const submit = useCallback(() => {
    const trimmed = text.trimEnd();
    if (!trimmed || busy || disabled) return;
    onSend(trimmed);
    updateText("");
  }, [busy, disabled, onSend, text, updateText]);

  return (
    <div className="composer">
      {context && <div className="composer__context" data-slot="composer-context">{context}</div>}
      <div className={`composer__box ${disabled ? "composer__box--off" : ""}`} data-slot="composer-host">
        <div className="composer__body" data-chat-composer-body="true">
        <textarea
          ref={box}
          className="composer__input"
          rows={1}
          aria-label={label}
          value={text}
          disabled={disabled}
          placeholder={
            disabled
              ? placeholder ?? "Not ready yet"
              : "Ask anything"
          }
          onChange={(event) => updateText(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
              return;
            }
            if (event.key === "Escape" && busy) {
              event.preventDefault();
              onCancel();
            }
          }}
        />

        </div>
        <div className="composer__tools" data-chat-composer-footer="true">
          <div className="composer__choices">{tools}</div>
          {busy ? (
            <button
              type="button"
              className="composer__send composer__send--stop"
              title="Stop (Esc)"
              aria-label="Stop"
              onClick={onCancel}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="2.5" y="2.5" width="7" height="7" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="composer__send"
              title="Send (Enter)"
              aria-label="Send"
              disabled={disabled || !text.trim()}
              onClick={submit}
            >
              <Icon name="arrow" size={16} />
            </button>
          )}

        </div>
      </div>
    </div>
  );
}
