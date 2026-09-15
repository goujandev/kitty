import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { toolMeta, type Block, type ToolStatus } from "../ipc/bindings";
import { Markdown, openLinksExternally } from "./Markdown";

/**
 * The transcript, virtualised from its first commit (ADR-0006).
 *
 * Only the rows intersecting the viewport are mounted. Heights are measured as
 * rows appear and remembered, so scrolling past a long answer stays accurate
 * without measuring everything up front.
 *
 * Retrofitting this later is where an app like this goes to die: by the time
 * there are a dozen block types with their own layout, every one of them has
 * to learn to be measured. Doing it now costs one component.
 */

/** Height assumed for a row that has not been measured yet. */
const ESTIMATE = 76;
/** Rows rendered beyond the viewport, so scrolling does not flash. */
const OVERSCAN = 6;
/** How close to the bottom still counts as "following the stream". */
const STICK_THRESHOLD = 32;

export function Transcript({
  blocks,
  busy,
}: {
  blocks: Block[];
  busy: boolean;
}): React.ReactElement {
  // While a turn runs, the last agent block is the one being written to. It
  // stays plain text until it finishes; see Markdown.tsx for why.
  const streamingSeq = useMemo(() => {
    if (!busy) return null;
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i];
      if (block && (block.kind === "assistant" || block.kind === "reasoning")) {
        return block.seq;
      }
    }
    return null;
  }, [blocks, busy]);

  const scroller = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<number, number>());
  const stick = useRef(true);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  // Bumped when a measurement changes, to recompute offsets.
  const [measured, setMeasured] = useState(0);

  // Offsets are a prefix sum over known heights. Recomputed only when the
  // list or a measurement changes, never per scroll event.
  const { offsets, total } = useMemo(() => {
    const out = new Array<number>(blocks.length);
    let running = 0;
    for (const [index, block] of blocks.entries()) {
      out[index] = running;
      running += heights.current.get(block.seq) ?? ESTIMATE;
    }
    return { offsets: out, total: running };
  }, [blocks, measured]);

  const [first, last] = useMemo(() => {
    if (blocks.length === 0) return [0, 0];
    const top = scrollTop;
    const bottom = scrollTop + (viewport || 1);

    let start = offsets.findIndex((offset, index) => {
      const height = heights.current.get(blocks[index]!.seq) ?? ESTIMATE;
      return offset + height >= top;
    });
    if (start < 0) start = Math.max(0, blocks.length - 1);

    let end = start;
    while (end < blocks.length && (offsets[end] ?? 0) < bottom) end += 1;

    return [
      Math.max(0, start - OVERSCAN),
      Math.min(blocks.length, end + OVERSCAN),
    ];
  }, [blocks, offsets, scrollTop, viewport]);

  const onScroll = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    stick.current =
      node.scrollHeight - node.scrollTop - node.clientHeight <= STICK_THRESHOLD;
    setScrollTop(node.scrollTop);
  }, []);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return undefined;
    setViewport(node.clientHeight);
    const observer = new ResizeObserver(() => setViewport(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Follow the stream, but only while the reader has not scrolled away.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || !stick.current) return;
    node.scrollTop = node.scrollHeight;
    setScrollTop(node.scrollTop);
  }, [blocks, total]);

  const measure = useCallback((seq: number, height: number) => {
    if (heights.current.get(seq) === height) return;
    heights.current.set(seq, height);
    setMeasured((n) => n + 1);
  }, []);

  if (blocks.length === 0) {
    return (
      <div className="transcript transcript--empty">
        <p className="muted">
          {busy ? "Waiting for the agent…" : "Say something to get started."}
        </p>
      </div>
    );
  }

  return (
    <div className="transcript" ref={scroller} onScroll={onScroll}>
      <div className="transcript__spacer" style={{ height: total }}>
        {blocks.slice(first, last).map((block, index) => (
          <Row
            key={block.seq}
            block={block}
            top={offsets[first + index] ?? 0}
            streaming={block.seq === streamingSeq}
            onMeasure={measure}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One block.
 *
 * Memoised on the block object. A delta replaces exactly one block in the
 * store, so during streaming every other mounted row skips re-rendering.
 */
const Row = memo(function Row({
  block,
  top,
  streaming,
  onMeasure,
}: {
  block: Block;
  top: number;
  /** Still being written to, so render it as plain text. */
  streaming: boolean;
  onMeasure: (seq: number, height: number) => void;
}): React.ReactElement {
  const node = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return undefined;
    onMeasure(block.seq, element.offsetHeight);
    const observer = new ResizeObserver(() => {
      onMeasure(block.seq, element.offsetHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [block.seq, onMeasure]);

  // Tool activity is a compact line, not a bubble. It is what the agent did,
  // not what it said, and giving it the same weight as prose makes a
  // transcript unreadable.
  if (block.kind === "tool") {
    const { status, detail } = toolMeta(block);
    return (
      <div className="row" style={{ top }} ref={node}>
        <div className={`tool tool--${status}`}>
          <span className="tool__mark" aria-hidden="true">
            {statusMark(status)}
          </span>
          <span className="tool__title">{block.text}</span>
          {detail && <span className="tool__detail">{detail}</span>}
        </div>
      </div>
    );
  }

  // A user's own message is shown exactly as typed. Rendering it as markdown
  // would silently reformat what they wrote.
  const plain = streaming || block.kind === "user";

  return (
    <div className="row" style={{ top }} ref={node}>
      <div
        className={`bubble bubble--${block.kind}`}
        onClick={plain ? undefined : openLinksExternally}
      >
        {block.kind === "reasoning" && <div className="bubble__label">thinking</div>}
        {plain ? (
          // `pre-wrap` is not a style choice. The whole point of the delta
          // handling underneath is that whitespace is content, and collapsing
          // it here would throw that away at the last step.
          <div className="bubble__text">{block.text}</div>
        ) : (
          <Markdown text={block.text} />
        )}
      </div>
    </div>
  );
});

function statusMark(status: ToolStatus): string {
  switch (status) {
    case "running":
      return "·";
    case "ok":
      return "✓";
    case "failed":
      return "✕";
    case "denied":
      return "–";
    default:
      return "·";
  }
}
