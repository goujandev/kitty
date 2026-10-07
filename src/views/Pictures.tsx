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
 * The URL for a path, on pantheon's own scheme.
 *
 * Bytes over a protocol handler rather than base64 in the transcript: a 3MB
 * render becomes 4MB of text in the database, in memory and across IPC if you
 * inline it, and it is re-sent every time the row re-renders. WebView2 serves
 * a custom scheme from `http://<scheme>.localhost`, which is what the CSP
 * allows and nothing else.
 */
export function pictureUrl(path: string): string {
  // The browser preview's pretend host hands out pictures it already holds.
  if (path.startsWith("data:")) return path;
  return `http://pantheon.localhost/${encodeURIComponent(path)}`;
}

/** Text documents attached to a message, recorded on its row. */
export function blockFiles(block: Block): { name: string; path: string; size: number }[] {
  if (!block.meta) return [];
  try {
    const parsed = JSON.parse(block.meta) as { files?: unknown };
    if (!Array.isArray(parsed.files)) return [];
    return parsed.files.filter((file): file is { name: string; path: string; size: number } =>
      typeof file === "object" && file !== null && typeof (file as { name?: unknown }).name === "string");
  } catch {
    return [];
  }
}

/** "12 KB", for a file chip. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
