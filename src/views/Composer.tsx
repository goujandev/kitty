import { useCallback, useEffect, useRef, useState } from "react";

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
  onSend,
  onCancel,
}: {
  busy: boolean;
  disabled: boolean;
  /** What the empty box says when it cannot be typed into. */
  placeholder?: string;
  /** Controls shown along the bottom of the box. */
  tools?: React.ReactNode;
  onSend: (text: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

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
    setText("");
  }, [busy, disabled, onSend, text]);

  return (
    <div className="composer">
      <div className={`composer__box ${disabled ? "composer__box--off" : ""}`}>
        <textarea
          ref={box}
          className="composer__input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={
            disabled
              ? placeholder ?? "Not ready yet"
              : "Ask anything, Enter to send"
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
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

        <div className="composer__tools">
          {tools}
          <span className="composer__gap" />
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
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path
                  d="M7 12V2.6M7 2.6 3 6.6M7 2.6l4 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
