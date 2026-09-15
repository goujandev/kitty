import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useMemo } from "react";

/**
 * Renders a finished agent message.
 *
 * Two decisions worth stating, because both are about not being clever.
 *
 * **Model output is untrusted.** It is parsed to HTML and then sanitised
 * before it goes anywhere near the DOM. The allow-list is narrow: no scripts,
 * no styles, no iframes, no event handlers, and any link is forced to open
 * externally rather than navigating the app's own window.
 *
 * **Only finished blocks are rendered as markdown.** Re-parsing a growing
 * message on every token would be quadratic over the length of an answer, and
 * half-written markdown renders badly anyway. The streaming block is shown as
 * plain text and swaps to formatted the moment it completes, which is one
 * reflow instead of hundreds of parses.
 */

marked.setOptions({
  gfm: true,
  breaks: false,
});

/** Tags an assistant is allowed to produce. Deliberately small. */
const ALLOWED_TAGS = [
  "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "a", "table", "thead", "tbody", "tr", "th", "td",
];

const ALLOWED_ATTR = ["href", "title", "class"];

export const Markdown = memo(function Markdown({
  text,
}: {
  text: string;
}): React.ReactElement {
  const html = useMemo(() => {
    const parsed = marked.parse(text, { async: false });
    return DOMPurify.sanitize(parsed, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      // Anything not on the list is dropped entirely rather than having its
      // tags stripped and its text kept, which can change what a message says.
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["style", "srcset", "formaction"],
    });
  }, [text]);

  return (
    <div
      className="markdown"
      // Sanitised immediately above. The alternative is a full React renderer
      // for every markdown node, which is a lot of surface for no more safety.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

/**
 * Sends links to the system browser instead of navigating the app.
 *
 * A model can emit any URL it likes. Letting one replace the window would be a
 * navigation bug at best, so clicks are intercepted at the container.
 */
export function openLinksExternally(event: React.MouseEvent<HTMLElement>): void {
  const target = (event.target as HTMLElement).closest("a");
  if (!target) return;
  event.preventDefault();

  const href = target.getAttribute("href");
  if (!href) return;
  // Only schemes a human would expect from a chat message.
  if (!/^https?:\/\//i.test(href)) return;

  void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href));
}
