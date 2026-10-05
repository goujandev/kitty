import { useId, type CSSProperties } from "react";

const paths = {
  home: "M3 9l5-5 5 5M4.5 7.5V14h7V7.5M6.5 14v-4h3v4",
  search: "M11.3 11.3L14 14M12 7.5a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0",
  panel: "M2.5 3.5h11v9h-11zM6 3.5v9",
  plus: "M8 3v10M3 8h10",
  threads: "M3 3.5h10v8H8l-3 2v-2H3zM5.5 6.5h5M5.5 8.5h3",
  folder: "M2 4.5h4l1.5 1.5H14v7H2zM2 4.5v-1h4l1.5 1.5",
  chevron: "M6 4l4 4-4 4",
  chevronDown: "M4 6l4 4 4-4",
  settings: "M6.5 2.5h3l.5 2 1.5.8 2-.5 1.5 2.6-1.5 1.5v1.7l1.5 1.4-1.5 2.6-2-.5-1.5.8-.5 2h-3l-.5-2-1.5-.8-2 .5L1 12l1.5-1.4V8.9L1 7.4l1.5-2.6 2 .5L6 4.5zM10.5 9.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0",
  arrow: "M8 13V3M4 7l4-4 4 4",
  close: "M4 4l8 8M12 4l-8 8",
  check: "M3 8l3 3 7-7",
  message: "M3 3.5h10v8H7l-4 2z",
  code: "M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3l-2 10",
  sparkles: "M8 2l1.5 4.5L14 8l-4.5 1.5L8 14 6.5 9.5 2 8l4.5-1.5z",
  activity: "M1 8h3l2-5 4 10 2-5h3",
  more: "M3 8h.01M8 8h.01M13 8h.01",
  clock: "M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0M8 4.5V8l2.5 1.5",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, style }: { name: IconName; size?: number; style?: CSSProperties }): React.ReactElement {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}

/** Kitty's tilted, sleepy cat mascot, with a bold monochrome contour. */
export function KittyMark({ size = 24 }: { size?: number }): React.ReactElement {
  const maskId = useId();
  const outline = "M12 27L10 11Q9 7 13 9L25 17Q34 14 41 17L49 10Q52 8 52 12L51 27Q57 34 54 43C50 54 39 59 27 56C14 53 6 44 8 35Q9 30 12 27Z";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <mask id={maskId} x="0" y="0" width="64" height="64" maskUnits="userSpaceOnUse">
          <g transform="rotate(-10 32 32)" strokeLinecap="round" strokeLinejoin="round">
            <path d={outline} fill="white" stroke="white" strokeWidth="7" />
            <path d={outline} fill="white" stroke="black" strokeWidth="3" />
            <path d="M18 32Q22 28 27 31M36 30Q41 26 45 29M33 39Q32 44 28 42M33 39Q37 43 40 40M17 39L12 38M45 37L50 35" fill="none" stroke="black" strokeWidth="2.8" />
            <path d="M29.5 36.5Q33 35 36.5 36L33 40Z" fill="black" />
          </g>
        </mask>
      </defs>
      <rect width="64" height="64" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}
