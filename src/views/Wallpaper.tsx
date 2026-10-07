import { useEffect, useLayoutEffect, useRef } from "react";
import { drawDithered, loadImage, noiseTile, paletteOf } from "./dither";

/**
 * The panel's background picture, dithered, with noise over it.
 *
 * Redrawn whenever the panel changes size, so the cells always land on whole
 * device pixels. `dim` lays a sheet of the panel colour over it once there is
 * a conversation to read.
 */
export function Wallpaper({ url, dim }: { url: string; dim: boolean }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const node = host.current;
    const target = canvas.current;
    if (!node || !target) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draw = () => {
      void loadImage(url).then(image => {
        if (cancelled) return;
        const box = node.getBoundingClientRect();
        drawDithered(target, image, box.width, box.height);
      }).catch(() => undefined);
    };
    draw();
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(draw, 120); });
    observer.observe(node);
    return () => { cancelled = true; clearTimeout(timer); observer.disconnect(); };
  }, [url]);

  return <div ref={host} className={`wallpaper${dim ? " wallpaper--dim" : ""}`} aria-hidden="true">
    <canvas ref={canvas} className="wallpaper__dither" />
    <div className="wallpaper__noise" style={{ backgroundImage: `url("${noiseTile()}")` }} />
    <div className="wallpaper__fade" />
    <div className="wallpaper__hush" />
  </div>;
}

/**
 * Tints the whole window from the wallpaper: an accent for the model and send
 * controls, and a near-black shell around the panel. Cleared when there is no
 * wallpaper, so the theme's own colours return.
 */
export function useWallpaperPalette(url: string | null): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!url) {
      delete root.dataset.wallpaper;
      for (const name of ["--wall-accent", "--wall-shell", "--wall-panel", "--wall-surface"]) root.style.removeProperty(name);
      return undefined;
    }
    let cancelled = false;
    void loadImage(url).then(image => {
      if (cancelled) return;
      const palette = paletteOf(image);
      root.style.setProperty("--wall-accent", palette.accent);
      root.style.setProperty("--wall-shell", palette.shell);
      root.style.setProperty("--wall-panel", palette.panel);
      root.style.setProperty("--wall-surface", palette.surface);
      root.dataset.wallpaper = "on";
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [url]);
}
