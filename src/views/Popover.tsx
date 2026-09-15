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
  icon,
  below,
  trigger,
  onOpen,
  children,
}: {
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
  /** Sized to its contents and hung from the right edge, for short menus. */
  narrow?: boolean;
  /** A square button with no chevron, for a glyph that is its own label. */
  icon?: boolean;
  /** Classes for the button, when it is not one of the composer's chips. */
  trigger?: string;
  /** Opens downwards. The default is upwards, for the chips in the composer. */
  below?: boolean;
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
        className={trigger ?? `chip ${icon ? "chip--icon" : ""}`}
        title={title}
        disabled={disabled}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onOpen?.();
        }}
      >
        {label}
        {!icon && <Chevron />}
      </button>

      {open && (
        <div
          className={[
            "pop__menu",
            narrow ? "pop__menu--narrow" : "",
            below ? "pop__menu--below" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/**
 * The mark on anything that opens a menu.
 *
 * Drawn rather than typed. The chevron characters -- U+2304 and friends -- are
 * missing from most faces, so each one arrived from a different fallback font
 * at a different weight and sitting off the baseline.
 */
export function Chevron(): React.ReactElement {
  return (
    <svg
      className="chip__chevron"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <path
        d="M2.6 4.1 5 6.5l2.4-2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
