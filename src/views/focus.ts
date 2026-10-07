/**
 * Moving keyboard focus after something changes what is on screen.
 *
 * Each waits two frames: one for React to commit the change, one for layout,
 * so the element being focused is the one now showing.
 */

function later(run: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(run));
}

/** Puts the cursor in the message box, ready to type. */
export function focusComposer(): void {
  later(() => document.querySelector<HTMLTextAreaElement>(".composer__input:not(:disabled)")?.focus());
}

/** Focuses a chat's row in the sidebar, or the message box if it is not shown. */
export function focusChatRow(sessionId: string | null): void {
  later(() => {
    const row = sessionId
      ? document.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(sessionId)}"] .ws-chat__open`)
      : document.querySelector<HTMLElement>(".ws-chat--draft .ws-chat__open");
    if (row) row.focus();
    else document.querySelector<HTMLTextAreaElement>(".composer__input:not(:disabled)")?.focus();
  });
}

/** Focuses a project's row in the sidebar. */
export function focusProjectRow(projectId: string): void {
  later(() => document.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(projectId)}"] .ws-project__open`)?.focus());
}

/** Focuses the first control in the project chooser shown when none is open. */
export function focusChooser(): void {
  later(() => document.querySelector<HTMLElement>(".project-chooser button")?.focus());
}
