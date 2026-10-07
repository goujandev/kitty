import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { groupActivity, formatElapsed, savedContextNote, summarizeSteps, workedFor, type DisplayBlock, type Steps, type TurnEnd, type TurnTiming } from "./activity";

import { toolMeta, type Block, type HarnessId, type ToolStatus } from "../ipc/bindings";
import { Markdown, openLinksExternally } from "./Markdown";
import { blockFiles, blockPictures, fileSize, Pictures } from "./Pictures";
import { Icon } from "./Icon";
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
}: {
  blocks: Block[];
  busy: boolean;
  /** Which agent is speaking, for its mark. */
  harness: HarnessId | null;
  /** What to call it. The model and its effort, not the harness. */
  agentName: string;
  timings: Record<number, TurnTiming>;
}): React.ReactElement {
  const blocks = useMemo(() => groupActivity(rawBlocks, busy, timings), [rawBlocks, busy, timings]);
  // While a turn runs, a message that is the newest row is the one being
  // written to. It stays plain text until it finishes; see Markdown.tsx for
  // why. Only the newest row: once the agent has moved on to a step, the
  // message above it is finished and keeps its formatting.
  const streamingSeq = useMemo(() => {
    const last = blocks.at(-1);
    return busy && last?.kind === "assistant" ? last.seq : null;
  }, [blocks, busy]);

  // Which replies carry the attribution line underneath them: the last thing
  // the agent actually said before the turn went back to you. Tool rows that
  // trail a reply are part of the same answer, so they do not get their own.
  // A running turn has not gone back to you yet, so none of its updates is
  // signed until it ends.
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
    if (last !== null && !busy) seqs.add(last);
    return seqs;
  }, [blocks, busy]);

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
  }, [scroller, blocks, total, viewport, measured, busy]);

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
              signed={signed.has(block.seq)}
              harness={harness}
              agentName={agentName}
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
    <div className={`row msg msg--${block.steps ? "steps" : block.turnEnd ? "turn-end" : block.kind}`} style={{ top }} ref={node} data-block-seq={block.seq}>
      {block.steps ? <StepsGroup steps={block.steps} /> : block.turnEnd ? <TurnEndLine end={block.turnEnd} /> : <Body block={block} streaming={streaming} />}
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

/**
 * Tool calls and thinking between two messages, as one line.
 *
 * Open while it is the newest thing in a running turn, so each step appears as
 * it happens; folded to a summary once the agent moves on, and openable again.
 */
function StepsGroup({ steps }: { steps: Steps }): React.ReactElement {
  const [expanded, setExpanded] = useState(steps.live);
  useEffect(() => setExpanded(steps.live), [steps.live]);
  const latest = [...steps.blocks].reverse().find(block => block.kind === "tool");
  const failed = steps.blocks.filter(block => block.kind === "tool" && toolMeta(block).status === "failed").length;
  return <div className={`steps${steps.live ? " steps--live" : ""}`}>
    <button className="steps__toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className="steps__chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      <span className="steps__summary">{summarizeSteps(steps.blocks)}</span>
      {failed > 0 && <span className="steps__failed">{failed} failed</span>}
      {!expanded && latest && <span className="steps__latest">{latest.text}</span>}
    </button>
    {expanded && <div className="steps__list">
      {steps.blocks.map(block => <div key={block.seq} className={`msg msg--${block.kind}`}>
        <Body block={block} streaming={steps.live && block.kind === "reasoning"} />
      </div>)}
    </div>}
  </div>;
}

/** How a finished turn went, said once under it. */
function TurnEndLine({ end }: { end: TurnEnd }): React.ReactElement {
  const outcome = end.timing?.outcome;
  const label = outcome === "failed" ? "Failed" : outcome === "stopped" ? "Stopped" : "Worked";
  const elapsed = workedFor(end.timing?.endedAt !== undefined ? end.timing : undefined, Date.now());
  return <div className={`turn-end turn-end--${outcome ?? "worked"}`}>
    <span className="turn-end__mark" aria-hidden="true">{outcome === "failed" ? "✕" : outcome === "stopped" ? "–" : "✓"}</span>
    <span>{label}{elapsed !== null ? ` for ${formatElapsed(elapsed)}` : ""}</span>
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
  // would silently reformat what they wrote. What they attached sits above
  // the words, the way it was laid out in the box.
  if (block.kind === "user") {
    const pictures = blockPictures(block);
    const files = blockFiles(block);
    return (
      <div className="msg__user">
        {(pictures.length > 0 || files.length > 0) && <div className="msg__attachments">
          <Pictures paths={pictures} />
          {files.length > 0 && <ul className="file-chips" aria-label="Attached documents">
            {files.map(file => <li key={file.path} className="file-chip" title={file.name}>
              <Icon name="file" size={15} /><span className="file-chip__name">{file.name}</span><span className="file-chip__size">{fileSize(file.size)}</span>
            </li>)}
          </ul>}
        </div>}
        {block.text && <div className="msg__text">{block.text}</div>}
      </div>
    );
  }
  const plain = streaming;

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
