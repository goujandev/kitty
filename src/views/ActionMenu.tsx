import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeMenu, typeahead } from "../stores/sidebarModel";
import { Icon } from "./Icon";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Shown beside the label, e.g. "F2". */
  shortcut?: string;
  /** Permanent or hard to undo: drawn in the danger colour, kept last. */
  danger?: boolean;
  /** Starts a new group, drawn with a line above. */
  separatorBefore?: boolean;
}

export interface ActionMenuHandle {
  /** Opens at the pointer, for a right-click on the row. */
  openAt: (x: number, y: number, returnTo?: HTMLElement | null) => void;
  /** Opens under the "⋯" button, e.g. from Shift+F10 on the row. */
  open: (returnTo?: HTMLElement | null) => void;
}

type Placement = { kind: "button" } | { kind: "point"; x: number; y: number };

/**
 * The "⋯" actions menu on a project or chat row.
 *
 * A WAI-ARIA menu button: Enter, Space or ArrowDown opens it on the first item,
 * ArrowUp on the last; arrows, Home, End and first letters move; Escape or Tab
 * closes it and returns focus to where it came from. It renders into the body
 * so a narrow sidebar cannot clip it, and stops every pointer event at its edge
 * so choosing an item never also selects or drags the row underneath.
 */
export function ActionMenu({ label, items, className = "", ref }: {
  label: string;
  items: MenuItem[];
  className?: string;
  ref?: React.Ref<ActionMenuHandle>;
}): React.ReactElement {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const menuId = useId();
  const triggerId = useId();

  const show = useCallback((next: Placement, first: number, back?: HTMLElement | null) => {
    returnTo.current = back ?? trigger.current;
    setPosition(null);
    setActive(first);
    setPlacement(next);
  }, []);

  const close = useCallback((restore = true) => {
    setPlacement(null);
    if (restore) {
      const target = returnTo.current?.isConnected ? returnTo.current : trigger.current;
      target?.focus();
    }
  }, []);

  useImperativeHandle(ref, () => ({
    openAt: (x, y, back) => show({ kind: "point", x, y }, 0, back),
    open: back => show({ kind: "button" }, 0, back),
  }), [show]);

  // Measured once it exists, so it opens where it fits rather than off-screen.
  useLayoutEffect(() => {
    if (!placement || !menu.current) return;
    const size = { width: menu.current.offsetWidth, height: menu.current.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const anchor = placement.kind === "point"
      ? { x: placement.x, y: placement.y }
      : (() => { const r = trigger.current!.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })();
    setPosition(placeMenu(size, viewport, anchor));
  }, [placement]);

  useEffect(() => {
    if (!placement || !position) return;
    menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[active]?.focus();
  }, [placement, position, active]);

  useEffect(() => {
    if (!placement) return undefined;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      close(false);
    };
    const dismiss = () => close(false);
    // Leaving the app closes the menu, as a native one would. Moving focus
    // within the webview -- which assistive technology can do in a way that
    // briefly blurs the window -- does not.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const blurred = () => { pending = setTimeout(() => { if (!document.hasFocus()) close(false); }, 150); };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", blurred);
    return () => {
      clearTimeout(pending);
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", blurred);
    };
  }, [placement, close]);

  const choose = (item: MenuItem) => {
    // Focus goes back first, so an action that moves it on -- a rename field,
    // a confirmation -- is the last word.
    close();
    item.onSelect();
  };

  const onMenuKey = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    const last = items.length - 1;
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); setActive(index => (index >= last ? 0 : index + 1)); return;
      case "ArrowUp": event.preventDefault(); setActive(index => (index <= 0 ? last : index - 1)); return;
      case "Home": event.preventDefault(); setActive(0); return;
      case "End": event.preventDefault(); setActive(last); return;
      case "Escape": event.preventDefault(); close(); return;
      case "Tab": event.preventDefault(); close(); return;
      case "Enter": case " ": {
        event.preventDefault();
        // The item that has focus, however it got there -- arrows, pointer, or
        // an assistive technology moving focus directly.
        const focusedIndex = [...(menu.current?.querySelectorAll('[role="menuitem"]') ?? [])].indexOf(document.activeElement as Element);
        const item = items[focusedIndex >= 0 ? focusedIndex : active];
        if (item) choose(item);
        return;
      }
      default:
        if (event.key.length === 1 && /\S/.test(event.key)) {
          setActive(index => typeahead(items.map(item => item.label), index, event.key));
        }
    }
  };

  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  return <>
    <button
      ref={trigger}
      id={triggerId}
      type="button"
      className={`ws-row-more ${className}`}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={placement !== null}
      aria-controls={placement ? menuId : undefined}
      draggable={false}
      onPointerDown={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
      onClick={event => {
        event.stopPropagation();
        if (placement) close(); else show({ kind: "button" }, 0);
      }}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          show({ kind: "button" }, event.key === "ArrowUp" ? items.length - 1 : 0);
        }
      }}
    >
      <Icon name="more" size={16} />
    </button>
    {placement && createPortal(
      <div
        ref={menu}
        id={menuId}
        role="menu"
        aria-labelledby={triggerId}
        className="action-menu"
        style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: "hidden" }}
        onKeyDown={onMenuKey}
        onPointerDown={stop}
        onMouseDown={stop}
        onClick={stop}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      >
        {items.map((item, index) => <div key={item.label} role="none">
          {item.separatorBefore && <div role="separator" className="action-menu__separator" />}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`action-menu__item${item.danger ? " action-menu__item--danger" : ""}`}
            onMouseEnter={() => setActive(index)}
            onFocus={() => { if (active !== index) setActive(index); }}
            onClick={() => choose(item)}
          >
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        </div>)}
      </div>,
      document.body,
    )}
  </>;
}
