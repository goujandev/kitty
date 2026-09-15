import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Dragging a pane wider or narrower.
 *
 * The width is written straight to the element during a drag rather than held
 * in state. A drag produces a pointer event per frame, and routing each one
 * through React means the pane is always a render behind the cursor -- which
 * you see as the edge lagging the mouse and then catching up. State is updated
 * once, when the drag ends, which is also the only point worth saving.
 *
 * Pointer capture rather than mouse events, so a fast drag that leaves the
 * handle keeps resizing instead of stopping wherever the cursor escaped.
 */
export interface DragResize {
  width: number;
  dragging: boolean;
  /** Put this on the pane being resized, not on the handle. */
  setPaneRef: (element: HTMLElement | null) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Double-clicking the handle puts the pane back to its default. */
  onDoubleClick: () => void;
}

export function useDragResize({
  min,
  max,
  defaultWidth,
  initial,
  onCommit,
}: {
  min: number;
  /** A function, because it usually depends on the window's current size. */
  max: () => number;
  defaultWidth: number;
  initial: number;
  onCommit?: (width: number) => void;
}): DragResize {
  // Read through refs inside the drag handlers, so a drag in progress uses the
  // current limits and callback without re-subscribing on every render.
  const minRef = useRef(min);
  minRef.current = min;
  const maxRef = useRef(max);
  maxRef.current = max;
  const defaultRef = useRef(defaultWidth);
  defaultRef.current = defaultWidth;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const clamp = useCallback(
    (value: number) =>
      Math.min(maxRef.current(), Math.max(minRef.current, Math.round(value))),
    [],
  );

  const [width, setWidth] = useState(() => clamp(initial));
  const [dragging, setDragging] = useState(false);
  const pane = useRef<HTMLElement | null>(null);
  const current = useRef(width);
  const stopDrag = useRef<(() => void) | null>(null);

  const apply = useCallback((next: number) => {
    current.current = next;
    if (pane.current) pane.current.style.width = `${next}px`;
  }, []);

  const setPaneRef = useCallback((element: HTMLElement | null) => {
    pane.current = element;
    if (element) element.style.width = `${current.current}px`;
  }, []);

  // The saved width arrives from the database after the first paint, so the
  // pane mounts at its default and is corrected here. Ignored mid-drag, where
  // the cursor is the authority.
  useEffect(() => {
    if (dragging) return;
    const next = clamp(initial);
    if (next === current.current) return;
    apply(next);
    setWidth(next);
  }, [initial, clamp, apply, dragging]);

  const commit = useCallback(
    (next: number) => {
      const value = clamp(next);
      apply(value);
      setWidth(value);
      onCommitRef.current?.(value);
    },
    [apply, clamp],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const { pointerId } = event;
      const startX = event.clientX;
      const startWidth = current.current;

      handle.setPointerCapture(pointerId);
      setDragging(true);
      // On the root, so the resize cursor survives crossing anything with a
      // cursor of its own -- a button mid-drag would otherwise flicker.
      document.documentElement.classList.add("is-resizing");

      const onMove = (moved: PointerEvent) => {
        if (moved.pointerId !== pointerId) return;
        apply(clamp(startWidth + (moved.clientX - startX)));
      };

      const stop = () => {
        if (stopDrag.current !== stop) return;
        stopDrag.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.documentElement.classList.remove("is-resizing");
        setDragging(false);
        try {
          handle.releasePointerCapture(pointerId);
        } catch {
          // Already released, which is not a problem worth reporting.
        }
        commit(current.current);
      };

      const onUp = (lifted: PointerEvent) => {
        if (lifted.pointerId === pointerId) stop();
      };

      stopDrag.current = stop;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [apply, clamp, commit],
  );

  // A drag interrupted by the pane unmounting would otherwise leave the
  // listeners and the resize cursor behind.
  useEffect(() => () => stopDrag.current?.(), []);

  const onDoubleClick = useCallback(() => {
    commit(defaultRef.current);
  }, [commit]);

  return { width, dragging, setPaneRef, onPointerDown, onDoubleClick };
}
