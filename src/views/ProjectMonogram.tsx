// Adapted from T3 Code's ProjectMonogram/projectIdentity (MIT).
// Copyright 2026 T3 Tools Inc. See docs/licenses/T3-Code-MIT.txt.
import type { CSSProperties } from "react";

// Tailwind gray through rose, in the same order as T3's PROJECT_ICON_COLORS.
const colors = [
  ["#99a1af", "#4a5565"], ["#ff6467", "#e7000b"], ["#ff8904", "#f54a00"],
  ["#ffb900", "#e17100"], ["#fdc700", "#d08700"], ["#9ae600", "#5ea500"],
  ["#05df72", "#00a63e"], ["#00d5be", "#009966"], ["#00d5be", "#009689"],
  ["#00d3f3", "#00a6c0"], ["#00bcff", "#0084d1"], ["#51a2ff", "#155dfc"],
  ["#7c86ff", "#4f39f6"], ["#a684ff", "#7f22fe"], ["#c27aff", "#9810fa"],
  ["#ed6aff", "#c800de"], ["#fb64b6", "#e60076"], ["#ff637e", "#ec003f"],
] as const;

function deriveProjectIdentity(projectName: string): { monogram: string; index: number } {
  const name = projectName.normalize("NFKC").trim();
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const glyphs = Array.from(words[0] ?? "");
  const first = glyphs[0] ?? "P";
  const second = glyphs.slice(1).find(glyph => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ?? first;
  const monogram = words.length ? Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("") : "PR";
  let index = 0;
  for (const glyph of name.toLocaleLowerCase("en-US") || "project") index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % colors.length;
  return { monogram, index };
}

export function ProjectMonogram({ name }: { name: string }): React.ReactElement {
  const { monogram, index } = deriveProjectIdentity(name);
  const [dark, light] = colors[index] ?? colors[11];
  return <span className="project-monogram" aria-hidden="true" style={{ "--project-icon-dark": dark, "--project-icon-light": light } as CSSProperties}>
    <svg viewBox="0 0 16 16"><text x="8" y="10.8" textAnchor="middle" fill="currentColor" fontSize="8.25" fontWeight="700" textLength={Array.from(monogram).length === 1 ? 6 : 12} lengthAdjust="spacingAndGlyphs" textRendering="geometricPrecision">{monogram}</text></svg>
  </span>;
}
