import { useEffect, useRef, useState } from "react";

/**
 * A chip that opens a small menu above itself.
 *
 * Everything in the composer's toolbar behaves this way, so the dismissal
 * rules — click elsewhere, or press Escape — are written once rather than
 * re-implemented per control and drifting apart.
 */
export function Popover({
  label,
  title,
  disabled,
  narrow,
  onOpen,
  children,
}: {
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
  /** Sized to its contents and hung from the right edge, for short menus. */
  narrow?: boolean;
  /** Fired when the menu opens, for anything worth fetching lazily. */
  onOpen?: () => void;
  /** Given a way to close, so choosing something can dismiss the menu. */
  children: (close: () => void) => React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="pop" ref={root}>
      <button
        type="button"
        className="chip"
        title={title}
        disabled={disabled}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onOpen?.();
        }}
      >
        {label}
        <span className="chip__chevron" aria-hidden="true">
          ⌄
        </span>
      </button>

      {open && (
        <div
          className={`pop__menu ${narrow ? "pop__menu--narrow" : ""}`}
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
