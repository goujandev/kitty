import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * A small menu at the pointer, for right-clicking a row.
 *
 * In a portal rather than inside the row, because a rail scrolls and clips its
 * own contents: a menu parented to the row it belongs to would be cut off at
 * the rail's edge, which is exactly where it wants to open.
 */
export function RowMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  useEffect(() => {
    const away = () => onClose();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    // Attached a tick late, and deliberately.
    //
    // The right-click that opens this menu is still being dispatched when the
    // effect runs: React flushes a discrete event's render synchronously, so a
    // listener added here can be reached by the very event that caused it and
    // the menu closes in the same breath it opened. Waiting for the current
    // event to finish is the whole fix.
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", away);
      document.addEventListener("contextmenu", away);
      window.addEventListener("resize", away);
    }, 0);

    document.addEventListener("keydown", escape);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", away);
      document.removeEventListener("contextmenu", away);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", away);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="rowmenu"
      role="menu"
      // Kept inside the window: opening near the bottom or right edge would
      // otherwise put half of it off screen with no way to scroll to it.
      style={{
        left: Math.min(x, window.innerWidth - 180),
        top: Math.min(y, window.innerHeight - 60),
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}
