import { useId, type CSSProperties } from "react";
import { Activity, ArrowUp, Check, ChevronDown, ChevronRight, Clock, Code, Folder, FolderPlus, House, LockOpen, MessageSquare, Mic, MoreHorizontal, PanelLeft, PanelRight, Plus, PanelLeftClose, RefreshCw, Search, Settings, SlidersVertical, Sparkles, SquarePen, X } from "lucide-react";

const icons = { home: House, search: Search, panel: PanelLeft, panelClose: PanelLeftClose, folder: Folder, folderPlus: FolderPlus, squarePen: SquarePen, chevron: ChevronRight, chevronDown: ChevronDown, settings: Settings, arrow: ArrowUp, close: X, check: Check, message: MessageSquare, code: Code, sparkles: Sparkles, activity: Activity, more: MoreHorizontal, clock: Clock, refresh: RefreshCw, lockOpen: LockOpen, sliders: SlidersVertical, plus: Plus, panelRight: PanelRight, mic: Mic } as const;
export type IconName = keyof typeof icons;

export function Icon({ name, size = 16, style }: { name: IconName; size?: number; style?: CSSProperties }): React.ReactElement {
  const Glyph = icons[name];
  return <Glyph size={size} strokeWidth={2} aria-hidden="true" style={style} />;
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
