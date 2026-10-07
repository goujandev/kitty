/**
 * The wallpaper effect: ordered dithering with fine monochrome noise on top.
 *
 * CSS has no way to dither, so the picture is redrawn on a canvas the size of
 * the panel, at one sample per cell of a few device pixels, and shown with
 * nearest-neighbour scaling so every cell stays a crisp square. Before the
 * dither the picture is toned for a dark interface: darker, a little more
 * saturated, and falling off towards the edges and the bottom where the
 * composer sits.
 */

/** 8×8 Bayer threshold matrix, values 0–63. */
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

export interface DitherOptions {
  /** Device pixels per dither cell. */
  cell: number;
  /** Levels per colour channel after quantising. */
  levels: number;
  /** Overall brightness, 1 leaves it alone. */
  exposure: number;
  /** Colour saturation, 1 leaves it alone. */
  saturation: number;
  /** Extra saturation for muted colours only, so skin and greys come alive without neon. */
  vibrance: number;
  /** Tone curve: above 1 darkens mid-tones while leaving bright colours bright. */
  gamma: number;
  /** How far down the panel the fade to dark begins, 0–1. */
  fadeStart: number;
}

export const DEFAULT_DITHER: DitherOptions = { cell: 2, levels: 6, exposure: 0.8, saturation: 1.3, vibrance: 0.6, gamma: 1.7, fadeStart: 1 };

const images = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(url: string): Promise<HTMLImageElement> {
  let pending = images.get(url);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("could not load the wallpaper"));
      image.src = url;
    });
    images.set(url, pending);
  }
  return pending;
}

/**
 * Draws `image` into `canvas`, cropped to cover `width`×`height` CSS pixels,
 * toned and dithered. The canvas is sized in cells and stretched back up by
 * CSS, so each cell is exactly `cell` device pixels square.
 */
export function drawDithered(canvas: HTMLCanvasElement, image: HTMLImageElement, width: number, height: number, options: DitherOptions = DEFAULT_DITHER): void {
  const dpr = window.devicePixelRatio || 1;
  const cell = Math.max(1, Math.round(options.cell * dpr));
  const w = Math.max(1, Math.ceil((width * dpr) / cell));
  const h = Math.max(1, Math.ceil((height * dpr) / cell));
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${(w * cell) / dpr}px`;
  canvas.style.height = `${(h * cell) / dpr}px`;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;

  // Cover: fill the panel, cropping the longer side, biased towards the top
  // where faces and subjects usually are.
  const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
  const drawW = image.naturalWidth * scale;
  const drawH = image.naturalHeight * scale;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, (w - drawW) / 2, (h - drawH) * 0.3, drawW, drawH);

  const frame = context.getImageData(0, 0, w, h);
  const data = frame.data;
  const steps = Math.max(2, options.levels) - 1;
  for (let y = 0; y < h; y += 1) {
    const v = y / h;
    // Gone to dark by the bottom edge, untouched through the top.
    const fade = v <= options.fadeStart ? 1 : Math.max(0, 1 - ((v - options.fadeStart) / (1 - options.fadeStart)) ** 1.3);
    for (let x = 0; x < w; x += 1) {
      const u = x / w - 0.5;
      // A light vignette only; the reference keeps its colour right to the edges.
      const vignette = 1 - Math.min(1, (u * u * 1.2 + (v - 0.4) * (v - 0.4) * 0.8)) * 0.3;
      const light = options.exposure * fade * vignette;
      const i = (y * w + x) * 4;
      let r = data[i]! / 255;
      let g = data[i + 1]! / 255;
      let b = data[i + 2]! / 255;
      // Colour first: a saturation lift, larger for muted pixels than for
      // ones already vivid.
      const grey = 0.299 * r + 0.587 * g + 0.114 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const lift = options.saturation + (1 - chroma) * options.vibrance;
      r = Math.min(1, Math.max(0, grey + (r - grey) * lift));
      g = Math.min(1, Math.max(0, grey + (g - grey) * lift));
      b = Math.min(1, Math.max(0, grey + (b - grey) * lift));
      // Then darken through brightness alone. Scaling all three channels by
      // one ratio keeps each hue's proportions, so the picture gets darker
      // without going grey: mid-tones drop, bright colours stay bright.
      const luma = Math.max(1e-4, 0.299 * r + 0.587 * g + 0.114 * b);
      const ratio = (luma ** options.gamma * light) / luma;
      r = Math.min(1, r * ratio);
      g = Math.min(1, g * ratio);
      b = Math.min(1, b * ratio);
      const threshold = (BAYER[(y & 7) * 8 + (x & 7)]! + 0.5) / 64 - 0.5;
      data[i] = Math.round(Math.min(steps, Math.max(0, Math.round(r * steps + threshold))) * (255 / steps));
      data[i + 1] = Math.round(Math.min(steps, Math.max(0, Math.round(g * steps + threshold))) * (255 / steps));
      data[i + 2] = Math.round(Math.min(steps, Math.max(0, Math.round(b * steps + threshold))) * (255 / steps));
    }
  }
  context.putImageData(frame, 0, 0);
}

let noise: string | null = null;

/** A tile of monochrome noise, made once, for laying over the dither. */
export function noiseTile(): string {
  if (noise) return noise;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const frame = context.createImageData(size, size);
  for (let i = 0; i < frame.data.length; i += 4) {
    const value = Math.random() * 255;
    frame.data[i] = value;
    frame.data[i + 1] = value;
    frame.data[i + 2] = value;
    frame.data[i + 3] = 255;
  }
  context.putImageData(frame, 0, 0);
  noise = canvas.toDataURL("image/png");
  return noise;
}

export interface WallpaperPalette {
  /** The picture's leading colour, light enough to read as text on dark. */
  accent: string;
  /** Near-black, tinted with that colour, for the window around the panel. */
  shell: string;
  /** A step lighter than the shell, for the panel itself. */
  panel: string;
  /** The composer: dark, tinted, slightly see-through. */
  surface: string;
}

/**
 * The picture's dominant saturated hue, as colours the interface can use.
 * A picture with no real colour gives neutral greys.
 */
export function paletteOf(image: HTMLImageElement): WallpaperPalette {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const bins = new Array<number>(36).fill(0);
  const sums = new Array<number>(36).fill(0);
  let total = 0;
  if (context) {
    context.drawImage(image, 0, 0, size, size);
    const data = context.getImageData(0, 0, size, size).data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]! / 255;
      const g = data[i + 1]! / 255;
      const b = data[i + 2]! / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const chroma = max - min;
      if (chroma < 0.12 || max < 0.2) continue;
      let hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
      hue = (hue * 60 + 360) % 360;
      const weight = chroma * max;
      const bin = Math.floor(hue / 10) % 36;
      bins[bin]! += weight;
      sums[bin]! += hue * weight;
      total += weight;
    }
  }
  if (total < 1) return { accent: "hsl(0 0% 82%)", shell: "hsl(0 0% 4%)", panel: "hsl(0 0% 7%)", surface: "hsl(0 0% 11% / 0.9)" };
  // Neighbouring bins count towards a peak, so a hue split across a boundary
  // is not passed over for a smaller, tidier one.
  let best = 0;
  let bestScore = -1;
  for (let bin = 0; bin < 36; bin += 1) {
    const score = bins[bin]! + 0.5 * (bins[(bin + 35) % 36]! + bins[(bin + 1) % 36]!);
    if (score > bestScore) { bestScore = score; best = bin; }
  }
  const hue = Math.round(bins[best]! > 0 ? sums[best]! / bins[best]! : best * 10 + 5);
  return {
    accent: `hsl(${hue} 72% 70%)`,
    shell: `hsl(${hue} 32% 4%)`,
    panel: `hsl(${hue} 24% 7%)`,
    surface: `hsl(${hue} 22% 11% / 0.9)`,
  };
}
