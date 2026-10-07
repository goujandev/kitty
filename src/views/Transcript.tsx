import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { groupActivity, formatElapsed, savedContextNote, type DisplayBlock, type Activity, type TurnTiming } from "./activity";

import { toolMeta, type Block, type HarnessId, type ToolStatus } from "../ipc/bindings";
import { Markdown, openLinksExternally } from "./Markdown";
import { blockPictures, Pictures } from "./Pictures";
import { Mark } from "./Marks";

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
/** Allow fractional-pixel rounding without leaving a visible gap. */
const STICK_THRESHOLD = 2;

export function Transcript({
  blocks: rawBlocks,
  busy,
  harness,
  agentName,
  timings,
  status,
  waiting,
}: {
  blocks: Block[];
  busy: boolean;
  /** Which agent is speaking, for its mark. */
  harness: HarnessId | null;
  /** What to call it. The model and its effort, not the harness. */
  agentName: string;
  timings: Record<number, TurnTiming>;
  status: string | null;
  waiting: boolean;
}): React.ReactElement {
  const blocks = useMemo(() => groupActivity(rawBlocks, busy, timings), [rawBlocks, busy, timings]);
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

  // Which replies carry the attribution line underneath them: the last thing
  // the agent actually said before the turn went back to you. Tool rows that
  // trail a reply are part of the same answer, so they do not get their own.
  const signed = useMemo(() => {
    const seqs = new Set<number>();
    let last: number | null = null;
    for (const block of blocks) {
      if (block.kind === "user") {
        if (last !== null) seqs.add(last);
        last = null;
      } else if (block.kind === "assistant") {
        last = block.seq;
      }
    }
    if (last !== null) seqs.add(last);
    return seqs;
  }, [blocks]);

  // Held in state, not a ref, because the observers below have to be set up
  // when the element appears rather than when this component mounts. The two
  // are not the same moment: a session opens with no blocks, which renders the
  // empty state instead of the scroller.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  /** The centred column the rows are laid out in, once there are any. */
  const [column, setColumn] = useState<HTMLDivElement | null>(null);
  const heights = useRef(new Map<number, number>());
  const stick = useRef(true);
  /** Width the remembered heights were measured at. */
  const width = useRef(0);

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
    // No `|| 1` fallback. A zero viewport means the measurement has not landed
    // yet, and quietly treating the window as one pixel tall is how a
    // virtualiser ends up rendering seven rows into an empty screen.
    const bottom = scrollTop + viewport;

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
    if (!scroller || scroller.clientHeight === 0) return;
    // Layout/virtual-row measurements also generate scroll events. They must
    // not turn following off: only deliberate reader input does that.
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_THRESHOLD) {
      stick.current = true;
    }
    setScrollTop(scroller.scrollTop);
  }, [scroller]);

  // How tall the window is, which decides how many rows are mounted. Measured
  // before paint: a viewport of zero would mount a single row.
  useLayoutEffect(() => {
    if (!scroller) return undefined;
    const remeasure = () => setViewport(scroller.clientHeight);
    remeasure();
    const observer = new ResizeObserver(remeasure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  // A narrower column wraps text, so every remembered height was taken at the
  // wrong width and has to be thrown away. Keeping them is what leaves rows
  // overlapping after a resize.
  //
  // The column is watched rather than the window: the two stop moving together
  // once the window is wider than `--column`, and clearing the cache on a
  // resize that changed no wrapping would throw away good measurements.
  useLayoutEffect(() => {
    if (!column) return undefined;

    const check = () => {
      if (column.clientWidth === 0) return;
      if (column.clientWidth === width.current) return;
      width.current = column.clientWidth;
      heights.current.clear();
      // Row observers can fire before the column observer. Read all mounted
      // rows now so clearing the cache does not discard their new heights.
      for (const row of column.querySelectorAll<HTMLElement>("[data-block-seq]")) {
        heights.current.set(Number(row.dataset.blockSeq), row.offsetHeight);
      }
      setMeasured((n) => n + 1);
    };

    check();
    const observer = new ResizeObserver(check);
    observer.observe(column);
    return () => observer.disconnect();
  }, [column]);

  // Follow the stream, but only while the reader has not scrolled away.
  useLayoutEffect(() => {
    if (!scroller || !stick.current) return;
    const follow = () => {
      if (!stick.current || scroller.clientHeight === 0) return;
      scroller.scrollTop = scroller.scrollHeight;
      setScrollTop(scroller.scrollTop);
    };
    follow();
    // Finish after the browser settles resized/virtualized rows, checking
    // reader intent again so a wheel gesture between frames wins.
    const frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [scroller, blocks, total, viewport, measured, busy, status, waiting]);

  const measure = useCallback((seq: number, height: number) => {
    if (height === 0) return;
    if (heights.current.get(seq) === height) return;
    heights.current.set(seq, height);
    setMeasured((n) => n + 1);
  }, []);

  // One element either way, so the ref is attached from the first render. An
  // empty transcript is the normal starting state of every session, and
  // swapping the scroller out for a different node left the observers above
  // with nothing to watch.
  return (
    <div
      className={`transcript${blocks.length === 0 ? " transcript--empty" : ""}`}
      ref={setScroller}
      onScroll={onScroll}
      style={{ overflowAnchor: "none" }}
      tabIndex={0}
      onWheel={event => {
        const pane = event.currentTarget;
        if (pane.scrollHeight - pane.clientHeight <= STICK_THRESHOLD) return;
        if (event.deltaY < 0 || (event.deltaY > 0 && pane.scrollHeight - pane.scrollTop - pane.clientHeight > STICK_THRESHOLD)) stick.current = false;
      }}
      onTouchMove={event => { if (event.currentTarget.scrollHeight > event.currentTarget.clientHeight + STICK_THRESHOLD) stick.current = false; }}
      onTouchEnd={event => { const pane = event.currentTarget; if (pane.scrollHeight - pane.scrollTop - pane.clientHeight <= STICK_THRESHOLD) stick.current = true; }}
      onPointerDown={event => {
        const pane = event.currentTarget;
        if (event.target === pane && event.clientX >= pane.getBoundingClientRect().right - 18) stick.current = false;
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const pane = event.currentTarget;
        if (pane.scrollHeight - pane.clientHeight <= STICK_THRESHOLD) return;
        if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) stick.current = false;
        else if (["ArrowDown", "PageDown", "End", " "].includes(event.key) && pane.scrollHeight - pane.scrollTop - pane.clientHeight > STICK_THRESHOLD) stick.current = false;
      }}
    >
      {blocks.length === 0 ? (
        <p className="muted">
          {busy ? "Waiting for the agent…" : "Say something to get started."}
        </p>
      ) : (
        <div
          className="transcript__spacer"
          ref={setColumn}
          style={{ height: total }}
        >
          {blocks.slice(first, last).map((block, index) => (
            <Row
              key={block.seq}
              block={block}
              top={offsets[first + index] ?? 0}
              streaming={block.seq === streamingSeq}
              signed={signed.has(block.seq) && block.seq !== streamingSeq}
              harness={harness}
              agentName={agentName}
              status={status}
              waiting={waiting}
              onMeasure={measure}
            />
          ))}
        </div>
      )}
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
  signed,
  harness,
  agentName,
  status,
  waiting,
  onMeasure,
}: {
  block: DisplayBlock;
  top: number;
  /** Still being written to, so render it as plain text. */
  streaming: boolean;
  /** Carries the attribution line: the last thing said before your turn. */
  signed: boolean;
  harness: HarnessId | null;
  agentName: string;
  status: string | null;
  waiting: boolean;
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

  return (
    <div className={`row msg msg--${block.kind}${block.activity ? " msg--activity" : ""}`} style={{ top }} ref={node} data-block-seq={block.seq}>
      {block.activity ? <ActivityGroup activity={block.activity} status={status} waiting={waiting} /> : <Body block={block} streaming={streaming} />}
      {signed && (
        // Who said it, stated after the fact rather than announced before it.
        // The answer is the thing worth reading; which model produced it is a
        // footnote you look for only when you want it.
        <div className="msg__sign">
          <Copy text={block.text} />
          {harness && <Mark harness={harness} size={13} />}
          <span className="msg__signname">{agentName}</span>
        </div>
      )}
    </div>
  );
});

function ActivityGroup({ activity, status, waiting }: { activity: Activity; status: string | null; waiting: boolean }): React.ReactElement {
  const [expanded, setExpanded] = useState(activity.active);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setExpanded(activity.active);
    if (!activity.active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activity.active]);
  const tools = activity.blocks.filter(block => block.kind === "tool");
  const current = [...tools].reverse().find(block => toolMeta(block).status === "running");
  const outcome = activity.timing?.outcome;
  const label = activity.active ? (waiting ? "Waiting for your approval" : "Working") : outcome === "failed" ? "Failed" : outcome === "stopped" ? "Stopped" : "Worked";
  const elapsed = activity.active ? now - activity.startedAt : activity.timing?.endedAt !== undefined ? activity.timing.endedAt - activity.startedAt : null;
  return <div className={`activity${activity.active ? " activity--active" : ""}`}>
    <button className="activity__toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {activity.active && !waiting && <span className="spinner" aria-hidden="true" />}
      <span>{label}{elapsed !== null ? `${activity.active ? " · " : " for "}${formatElapsed(elapsed)}` : ""}</span>
    </button>
    {activity.active && <div className="activity__status" role="status">{waiting ? "Resume by responding below." : status ?? current?.text ?? "Thinking…"}</div>}
    {expanded && activity.blocks.length > 0 && <div className="activity__history">{activity.blocks.map(block => <div key={block.seq} className={`msg msg--${block.kind}`}><Body block={block} streaming={activity.active && block.kind !== "tool"} /></div>)}</div>}
  </div>;
}

/** Copies a reply. The webview is a secure context, so this needs no host. */
function Copy({ text }: { text: string }): React.ReactElement {
  const [done, setDone] = useState(false);

  return (
    <button
      type="button"
      className="msg__copy"
      title={done ? "Copied" : "Copy this reply"}
      aria-label="Copy this reply"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          },
          () => undefined,
        );
      }}
    >
      {done ? (
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M2.5 7.5 5.6 10.6 11.5 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <rect
            x="4.9"
            y="1.9"
            width="7.2"
            height="7.2"
            rx="1.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M9.1 11.3v.8a1.6 1.6 0 0 1-1.6 1.6H3.5a1.6 1.6 0 0 1-1.6-1.6V6.5a1.6 1.6 0 0 1 1.6-1.6h.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}

/** What a block actually says. */
function Body({
  block,
  streaming,
}: {
  block: Block;
  streaming: boolean;
}): React.ReactElement {
  // Tool activity is a compact line, not prose. It is what the agent did, not
  // what it said, and giving it the same weight as a paragraph makes a
  // transcript unreadable.
  if (block.kind === "tool") {
    const { status, detail } = toolMeta(block);
    const note = savedContextNote(block.text, detail);
    if (note) return <span className="muted">{note}</span>;
    return (
      <div className={`tool tool--${status}`}>
        <span className="tool__mark" aria-hidden="true">
          {statusMark(status)}
        </span>
        <span className="tool__title">{block.text}</span>
        {detail && <span className="tool__detail">{detail}</span>}
      </div>
    );
  }

  // A user's own message is shown exactly as typed. Rendering it as markdown
  // would silently reformat what they wrote.
  const plain = streaming || block.kind === "user";

  return (
    <>
      {block.kind === "reasoning" && <div className="msg__label">thinking</div>}
      {plain ? (
        // `pre-wrap` is not a style choice. The whole point of the delta
        // handling underneath is that whitespace is content, and collapsing it
        // here would throw that away at the last step.
        //
        // It is also why the rendered branch below must not use this class:
        // with `pre-wrap` the newlines between HTML block tags become literal
        // blank lines, and every paragraph grows a gap under it.
        <div className="msg__text">{block.text}</div>
      ) : (
        <div onClick={openLinksExternally}>
          <Markdown text={block.text} />
        </div>
      )}
      <Pictures paths={blockPictures(block)} />
    </>
  );
}

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
