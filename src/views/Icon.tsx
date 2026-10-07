import pantheonIcon from "../assets/pantheon-icon.png";
import type { CSSProperties } from "react";
import { Activity, ArrowUp, Check, ChevronDown, ChevronRight, Clock, Code, FileText, Folder, FolderPlus, House, LockOpen, MessageSquare, Mic, MoreHorizontal, PanelLeft, PanelRight, Paperclip, Plus, PanelLeftClose, RefreshCw, Search, Settings, SlidersVertical, Sparkles, SquarePen, X } from "lucide-react";

const icons = { home: House, search: Search, panel: PanelLeft, panelClose: PanelLeftClose, folder: Folder, folderPlus: FolderPlus, squarePen: SquarePen, chevron: ChevronRight, chevronDown: ChevronDown, settings: Settings, arrow: ArrowUp, close: X, check: Check, message: MessageSquare, code: Code, sparkles: Sparkles, activity: Activity, more: MoreHorizontal, clock: Clock, refresh: RefreshCw, lockOpen: LockOpen, sliders: SlidersVertical, plus: Plus, panelRight: PanelRight, mic: Mic, paperclip: Paperclip, file: FileText } as const;
export type IconName = keyof typeof icons;

export function Icon({ name, size = 16, style }: { name: IconName; size?: number; style?: CSSProperties }): React.ReactElement {
  const Glyph = icons[name];
  return <Glyph size={size} strokeWidth={2} aria-hidden="true" style={style} />;
}

/** The approved perpendicular reaching-hands app mark. */
export function PantheonMark({ size = 24 }: { size?: number }): React.ReactElement {
  return <img src={pantheonIcon} width={size} height={size} alt="" aria-hidden="true" draggable={false} style={{ display: "block", borderRadius: "22%", flexShrink: 0 }} />;
}
