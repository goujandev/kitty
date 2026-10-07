import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

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
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 300 });
  // Floating controls must escape the tiled transcript's clipping boundary.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const anchor = root.current?.getBoundingClientRect();
      const surface = menu.current;
      if (!anchor || !surface) return;
      const roomAbove = Math.max(0, anchor.top - 16);
      const roomBelow = Math.max(0, window.innerHeight - anchor.bottom - 16);
      const down = below ? roomBelow >= Math.min(surface.scrollHeight, roomAbove) : roomAbove < Math.min(surface.scrollHeight, roomBelow);
      const maxHeight = Math.max(0, Math.min(window.innerHeight * .6, down ? roomBelow : roomAbove));
      const height = Math.min(surface.scrollHeight + 2, maxHeight);
      const desiredLeft = narrow ? anchor.right - surface.offsetWidth : anchor.left;
      setPosition({
        left: Math.max(8, Math.min(desiredLeft, window.innerWidth - surface.offsetWidth - 8)),
        top: down ? anchor.bottom + 8 : Math.max(8, anchor.top - height - 8),
        maxHeight,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (root.current) observer.observe(root.current);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [open, below, narrow]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); root.current?.querySelector("button")?.focus(); }
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
        aria-expanded={open}
        aria-haspopup="menu"
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

      {open && createPortal(
        <div
          ref={menu}
          style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}
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
        </div>,
        document.body,
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
  return <ChevronDown className="chip__chevron" size={12} aria-hidden="true" />;
}
