import { useCallback, useState } from "react";

/**
 * Dragging rows of a list into a different order.
 *
 * The list is reordered as you drag, not on drop, so the gap under the pointer
 * is where the row will land. Dropping only decides when to stop and what to
 * save.
 *
 * Built on the browser's own drag events rather than pointer maths, because a
 * rail scrolls: holding a row against the top edge has to scroll the list, and
 * that is behaviour a hand-rolled version has to reimplement badly.
 */
export interface Reorder<T> {
  /** The list as it currently appears, including the row being dragged. */
  items: T[];
  /** The id of the row under the hand, or null. */
  dragging: string | null;
  rowProps: (id: string) => {
    draggable: true;
    onDragStart: (event: React.DragEvent) => void;
    onDragEnter: () => void;
    onDragOver: (event: React.DragEvent) => void;
    onDragEnd: () => void;
    onDrop: (event: React.DragEvent) => void;
  };
}

export function useReorder<T>(
  /** The list from the store, in its saved order. */
  source: T[],
  idOf: (item: T) => string,
  onCommit: (ids: string[]) => void,
): Reorder<T> {
  const [dragging, setDragging] = useState<string | null>(null);
  // Only set while a drag is live. Falling back to `source` the rest of the
  // time means a list that changed underneath us -- a new chat, a deleted
  // project -- is never shown from a stale copy.
  const [order, setOrder] = useState<string[] | null>(null);

  const items =
    order === null
      ? source
      : order
          .map((id) => source.find((item) => idOf(item) === id))
          .filter((item): item is T => item !== undefined);

  const move = useCallback(
    (from: string, to: string) => {
      setOrder((current) => {
        const ids = current ?? source.map(idOf);
        const at = ids.indexOf(from);
        const target = ids.indexOf(to);
        if (at < 0 || target < 0 || at === target) return ids;
        const next = [...ids];
        next.splice(at, 1);
        next.splice(target, 0, from);
        return next;
      });
    },
    [source, idOf],
  );

  const finish = useCallback(() => {
    setDragging(null);
    setOrder((current) => {
      // Nothing to save if the row was picked up and put back.
      if (current && current.join() !== source.map(idOf).join()) onCommit(current);
      return null;
    });
  }, [source, idOf, onCommit]);

  const rowProps = useCallback(
    (id: string) => ({
      draggable: true as const,
      onDragStart: (event: React.DragEvent) => {
        setDragging(id);
        event.dataTransfer.effectAllowed = "move";
        // Firefox refuses to start a drag without data on the transfer, and
        // setting it costs nothing anywhere else.
        event.dataTransfer.setData("text/plain", id);
      },
      onDragEnter: () => {
        if (dragging && dragging !== id) move(dragging, id);
      },
      onDragOver: (event: React.DragEvent) => {
        // Without this the browser refuses the drop and the row springs back.
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      },
      onDragEnd: finish,
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        finish();
      },
    }),
    [dragging, move, finish],
  );

  return { items, dragging, rowProps };
}
