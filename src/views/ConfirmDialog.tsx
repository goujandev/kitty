import { useEffect, useId, useRef, useState } from "react";

/**
 * A modal question before something permanent.
 *
 * Cancel holds the focus, so Enter on its own never destroys anything; the
 * destructive button names exactly what it does. Escape cancels unless the
 * action is already under way.
 */
export function ConfirmDialog({ title, children, confirmLabel, workingLabel, onConfirm, onCancel }: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  workingLabel: string;
  /** Resolves when done; the dialog closes itself through the parent. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}): React.ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [working, setWorking] = useState(false);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    cancel.current?.focus();
    return () => { if (node?.open) node.close(); };
  }, []);

  return <dialog
    ref={dialog}
    className="confirm-dialog"
    aria-labelledby={titleId}
    aria-describedby={bodyId}
    onCancel={event => { event.preventDefault(); if (!working) onCancel(); }}
    onKeyDown={event => event.stopPropagation()}
  >
    <h2 id={titleId} className="confirm-dialog__title">{title}</h2>
    <div id={bodyId} className="confirm-dialog__body">{children}</div>
    <div className="confirm-dialog__actions">
      <button ref={cancel} type="button" className="button" disabled={working} onClick={onCancel}>Cancel</button>
      <button
        type="button"
        className="button button--danger"
        disabled={working}
        onClick={() => {
          setWorking(true);
          void onConfirm().finally(() => setWorking(false));
        }}
      >{working ? workingLabel : confirmLabel}</button>
    </div>
  </dialog>;
}
