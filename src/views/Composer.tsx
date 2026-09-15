import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The input.
 *
 * Enter sends, Shift+Enter makes a newline, Escape stops a running turn. The
 * box grows with its content up to a cap, then scrolls.
 */
export function Composer({
  busy,
  disabled,
  onSend,
  onCancel,
}: {
  busy: boolean;
  disabled: boolean;
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
      <textarea
        ref={box}
        className="composer__box"
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={disabled ? "Open a project first" : "Ask the agent something"}
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
      <div className="composer__actions">
        <span className="composer__hint">
          {busy ? "Esc to stop" : "Enter to send, Shift+Enter for a new line"}
        </span>
        {busy ? (
          <button type="button" className="button button--stop" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="button"
            disabled={disabled || !text.trim()}
            onClick={submit}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
