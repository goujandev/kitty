import { useState } from "react";

import type { Block } from "../ipc/bindings";

/**
 * Pictures an agent made, shown under the reply that talks about them.
 *
 * Codex generates images with its own tool and writes them to
 * `~/.codex/generated_images/<thread>/`, then says "Here's your cat" and
 * nothing else -- there is no path in the transcript to find. So nothing here
 * reads the text. The host lists that folder when a turn ends, keyed on the
 * thread id it already keeps to resume the conversation, and records what it
 * found on the block.
 *
 * An earlier version of this did scan the message for paths. It found nothing,
 * because there is nothing there to find.
 */

/** The pictures recorded on a block, if any. */
export function blockPictures(block: Block): string[] {
  if (!block.meta) return [];
  try {
    const parsed = JSON.parse(block.meta) as { images?: unknown };
    if (!Array.isArray(parsed.images)) return [];
    return parsed.images.filter((path): path is string => typeof path === "string");
  } catch {
    return [];
  }
}

export function Pictures({ paths }: { paths: string[] }): React.ReactElement | null {
  const [open, setOpen] = useState<string | null>(null);
  if (paths.length === 0) return null;

  return (
    <>
      <div className="shots">
        {paths.map((path) => (
          <button
            key={path}
            type="button"
            className="shot"
            title={`${path}

Click to see it full size`}
            onClick={() => setOpen(path)}
          >
            <img src={pictureUrl(path)} alt="" draggable={false} loading="lazy" />
          </button>
        ))}
      </div>

      {open && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(null)}
        >
          <img src={pictureUrl(open)} alt="" />
        </div>
      )}
    </>
  );
}

/**
 * The URL for a path, on kitty's own scheme.
 *
 * Bytes over a protocol handler rather than base64 in the transcript: a 3MB
 * render becomes 4MB of text in the database, in memory and across IPC if you
 * inline it, and it is re-sent every time the row re-renders. WebView2 serves
 * a custom scheme from `http://<scheme>.localhost`, which is what the CSP
 * allows and nothing else.
 */
function pictureUrl(path: string): string {
  return `http://kitty.localhost/${encodeURIComponent(path)}`;
}
