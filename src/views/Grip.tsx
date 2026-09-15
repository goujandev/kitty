import type { DragResize } from "../hooks/useDragResize";

/**
 * The edge you drag to resize a rail.
 *
 * Wider than the line it sits on, and straddling it, because a one-pixel
 * target is one you hunt for. It draws nothing until you are on it: a divider
 * that is always visible as a control is a divider competing with the content
 * either side of it.
 */
export function Grip({
  resize,
  label,
}: {
  resize: DragResize;
  label: string;
}): React.ReactElement {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={resize.width}
      className={`grip ${resize.dragging ? "grip--dragging" : ""}`}
      title="Drag to resize. Double-click to reset."
      onPointerDown={resize.onPointerDown}
      onDoubleClick={resize.onDoubleClick}
    />
  );
}
