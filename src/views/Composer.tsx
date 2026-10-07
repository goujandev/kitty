import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";
import { dictationCancel, dictationFinish, dictationStart, dictationStatus } from "../ipc/commands";
import { DictationController } from "../dictationController";
import { DictationWaveform } from "./DictationWaveform";
import "../dictation.css";

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
  const [draft, setDraft] = useState(() => ({ key: storageKey, text: drafts.get(storageKey) ?? "" }));
  const text = draft.key === storageKey ? draft.text : drafts.get(storageKey) ?? "";
  const box = useRef<HTMLTextAreaElement>(null);
  const statusId = useId();
  const mounted = useRef(false);
  const latest = useRef({ storageKey, busy, disabled, onSend });
  latest.current = { storageKey, busy, disabled, onSend };
  const [dictation] = useState(() => new DictationController({
    status: dictationStatus,
    start: dictationStart,
    finish: dictationFinish,
    cancel: dictationCancel,
    id: () => crypto.randomUUID(),
    current: (origin) => mounted.current && latest.current.storageKey === origin.key && !latest.current.busy && !latest.current.disabled,
    result: (origin, value, caret, send) => {
      if (value) drafts.set(origin.key, value); else drafts.delete(origin.key);
      setDraft({ key: origin.key, text: value });
      if (send) {
        latest.current.onSend(value.trimEnd());
        drafts.delete(origin.key);
        setDraft({ key: origin.key, text: "" });
      } else {
        requestAnimationFrame(() => {
          if (!mounted.current || latest.current.storageKey !== origin.key) return;
          box.current?.focus();
          box.current?.setSelectionRange(caret, caret);
        });
      }
    },
  }));
  const speech = useSyncExternalStore(dictation.subscribe, dictation.getSnapshot, dictation.getSnapshot);
  const dictating = speech.phase === "preparing" || speech.phase === "recording" || speech.phase === "transcribing";
  const speechStatus = speech.phase === "preparing"
    ? `Preparing dictation${speech.progress === null ? "" : ` · ${Math.round(Math.max(0, Math.min(1, speech.progress)) * 100)}%`}`
    : speech.phase === "recording" ? "Recording" : "Transcribing";
  const microphoneLabel = speech.phase === "recording" ? "Stop dictation and keep text" : dictating ? speechStatus : "Dictate";
  useEffect(() => {
    mounted.current = true;
    void dictation.poll();
    return () => { mounted.current = false; dictation.cancel(); };
  }, [dictation, storageKey]);
  useEffect(() => {
    if (busy || disabled) dictation.cancel();
  }, [busy, disabled, dictation]);
  useEffect(() => {
    if (!dictating) return;
    const timer = window.setInterval(() => void dictation.poll(), speech.phase === "recording" ? 100 : 350);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      dictation.cancel();
      box.current?.focus();
    };
    window.addEventListener("keydown", escape);
    return () => { window.clearInterval(timer); window.removeEventListener("keydown", escape); };
  }, [dictating, dictation, speech.phase]);
  const updateText = useCallback((value: string) => {
    if (value) drafts.set(storageKey, value); else drafts.delete(storageKey);
    setDraft({ key: storageKey, text: value });
  }, [storageKey]);
  useEffect(() => {
    if (!suggestion || consumedSuggestions.get(storageKey) === suggestion.id) return;
    dictation.cancel();
    consumedSuggestions.set(storageKey, suggestion.id);
    updateText(suggestion.text);
    box.current?.focus();
  }, [suggestion, storageKey, updateText, dictation]);

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
    if (busy || disabled) return;
    if (speech.phase === "recording") { void dictation.finish(true); return; }
    if (dictating) return;
    const trimmed = text.trimEnd();
    if (!trimmed) return;
    onSend(trimmed);
    updateText("");
  }, [busy, disabled, dictating, dictation, speech.phase, onSend, text, updateText]);

  const microphone = () => {
    if (busy || disabled) return;
    if (speech.phase === "recording") { void dictation.finish(); return; }
    if (dictating) return;
    const node = box.current;
    void dictation.start({ key: storageKey, text, start: node?.selectionStart ?? text.length, end: node?.selectionEnd ?? text.length });
  };

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
          readOnly={dictating}
          aria-describedby={dictating || speech.error ? statusId : undefined}
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
        {dictating && <span className="dictation-status--hidden" id={statusId} role="status">{speechStatus}</span>}
        {speech.error && <div className="dictation-status" id={statusId} role="alert">
          <span>{speech.error}</span>
          <button type="button" className="dictation-status__cancel" onClick={() => dictation.cancel()}>Dismiss</button>
        </div>}
        <div className={`composer__tools ${dictating ? "composer__tools--dictating" : ""}`} data-chat-composer-footer="true">
          <div className="composer__choices">{tools}</div>
          {dictating && <>
            <button
              type="button"
              className="dictation-discard"
              title="Discard dictation (Esc)"
              aria-label="Discard dictation"
              onClick={() => { dictation.cancel(); box.current?.focus(); }}
            >
              <Icon name="close" size={15} />
            </button>
            <DictationWaveform levels={speech.phase === "recording" ? speech.waveform : []} />
          </>}
          <button
            type="button"
            className={`dictation-mic ${dictating ? "dictation-mic--active" : ""}`}
            title={dictating ? microphoneLabel : "Dictate"}
            aria-label={microphoneLabel}
            aria-busy={speech.phase === "preparing" || speech.phase === "transcribing"}
            disabled={disabled || busy || speech.phase === "preparing" || speech.phase === "transcribing"}
            onClick={microphone}
          >
            {speech.phase === "recording" ? <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg> : dictating ? <span className="spinner dictation-mic__spinner" aria-hidden="true" /> : <Icon name="mic" size={17} />}
          </button>
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
              disabled={disabled || speech.phase === "preparing" || speech.phase === "transcribing" || (!text.trim() && speech.phase !== "recording")}
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
