/**
 * UI Kit Forge page — the atlas: a shelf-packed PNG sheet plus a TexturePacker JSON-hash
 * manifest.
 *
 * TexturePacker's own fields keep their meaning, so an existing loader (Phaser `load.atlas`,
 * PixiJS `Assets.load`, Cocos) reads the sheet unchanged. Everything a *slicer* needs is added
 * alongside, and that extra half is the reason this manifest exists at all — the core knows
 * its own corner geometry, so nobody downstream has to guess it (plan §3.2):
 *
 *  - `border` — the safe nine-slice inset, wide enough that stretching never distorts a corner
 *    or smears the gloss strip; `cap` is its single symmetric form. For Pix3 this is exactly
 *    what `TiledSprite2D.sliceBorderLeft/Right/Top/Bottom` takes.
 *  - `body` / `shadow` / `midY` — where the opaque body sits inside the frame, so a caption can
 *    be centred on the BODY rather than on the rect (a drop shadow pushes the two apart).
 *  - `anchors` — where the captions this build stripped belonged. PNG art carries no text: the
 *    engine draws the label at runtime, so a baked word would be wrong in every other language.
 *  - `warnings` — what cannot be sliced at all. `puffy` and `skew` bulge or lean the edges, and
 *    nine parts cannot express either.
 *
 * Padding is trimmed by default: `theme.pad` lands INSIDE the frame, so an untrimmed frame
 * slices empty space and draws its body at a fraction of its rect.
 *
 * No consumer caps are passed to `frameMeta` — the jam-august original checked against one
 * specific game's fixed slice constants, which do not travel (plan §9.1). A host that has such
 * caps can pass them; this page has none, so no fit verdict is emitted.
 */
import {
  frameMeta,
  type FrameMeta,
  type SliceBorder,
  type SliceRect,
  type TextAnchor,
} from '@/services/uikit';
import { type ForgeComponent, type ForgeTheme } from '@/services/uikit';

import { rasterize } from './raster';

/** One entry of the manifest. */
export interface AtlasFrame {
  frame: SliceRect;
  rotated: false;
  trimmed: boolean;
  spriteSourceSize: SliceRect;
  sourceSize: { w: number; h: number };
  /** Nine-slice insets, in atlas pixels. */
  border: SliceBorder;
  /** The symmetric form of `border`. */
  cap: number;
  body: SliceRect | null;
  shadow: SliceBorder | null;
  midY: number;
  anchors: TextAnchor[];
  warnings: string[];
}

export interface AtlasManifest {
  frames: Record<string, AtlasFrame>;
  meta: {
    app: string;
    version: string;
    image: string;
    format: 'RGBA8888';
    size: { w: number; h: number };
    scale: string;
    padTrimmed: boolean;
    theme: ForgeTheme;
  };
}

export interface AtlasResult {
  canvas: HTMLCanvasElement;
  manifest: AtlasManifest;
  /** The per-frame records, for the style contract — the same objects as `manifest.frames`. */
  frames: Record<string, AtlasFrame>;
  count: number;
  /** How many frames carry at least one warning. */
  warned: number;
  warnings: Record<string, string[]>;
}

export interface AtlasOptions {
  components: ForgeComponent[];
  theme: ForgeTheme;
  scale: number;
  trimPad: boolean;
  /** The base name of the image the manifest points at (`uikit`, `icons`). */
  image: string;
  /** Progress, so a hundred rasterizations do not look like a hang. */
  onProgress?: (done: number, total: number, name: string) => void;
}

interface PackedItem {
  name: string;
  canvas: HTMLCanvasElement;
  meta: FrameMeta;
  /** The part of the rasterized canvas that goes into the sheet. */
  src: SliceRect;
  x: number;
  y: number;
}

/** Gap between sprites, atlas pixels. Two, so a bilinear sample never bleeds a neighbour in. */
const PADDING = 2;

/** Which part of the rasterized canvas actually goes into the atlas. */
function pickSource(meta: FrameMeta, canvas: HTMLCanvasElement, trim: boolean): SliceRect {
  if (trim && meta.trim) return { ...meta.trim };
  return { x: 0, y: 0, w: canvas.width, h: canvas.height };
}

/** With the padding gone, every inset loses exactly that padding. */
function shiftBorder(border: SliceBorder, pad: number): SliceBorder {
  return {
    left: Math.max(1, border.left - pad),
    right: Math.max(1, border.right - pad),
    top: Math.max(1, border.top - pad),
    bottom: Math.max(1, border.bottom - pad),
  };
}

/** One frame's manifest entry, in the coordinates it actually occupies in the sheet. */
function describeFrame(item: PackedItem, trim: boolean): AtlasFrame {
  const meta = item.meta;
  const src = item.src;
  const off = trim && meta.trim ? { x: meta.trim.x, y: meta.trim.y } : { x: 0, y: 0 };
  const shift = (rect: SliceRect): SliceRect => ({
    x: rect.x - off.x,
    y: rect.y - off.y,
    w: rect.w,
    h: rect.h,
  });
  const border = trim ? shiftBorder(meta.border, meta.pad) : meta.border;
  const cap = trim ? Math.max(1, meta.cap - meta.pad) : meta.cap;

  return {
    frame: { x: item.x, y: item.y, w: src.w, h: src.h },
    rotated: false,
    trimmed: trim ? meta.trimmed : false,
    // The trimmed rect's place inside the untrimmed source, per the TexturePacker contract.
    spriteSourceSize: trim
      ? { x: off.x, y: off.y, w: src.w, h: src.h }
      : { x: 0, y: 0, w: src.w, h: src.h },
    sourceSize: trim ? { ...meta.sourceSize } : { w: src.w, h: src.h },
    border,
    cap,
    body: meta.body ? shift(meta.body) : null,
    shadow: meta.shadow,
    midY: trim ? meta.midYTrimmed : meta.midY,
    anchors: meta.anchors.map(anchor => ({ ...anchor, x: anchor.x - off.x, y: anchor.y - off.y })),
    warnings: meta.warnings,
  };
}

/**
 * Rasterize every component, shelf-pack the results and build the manifest.
 *
 * The components must already be built with `stripText: true` — the caller decides that,
 * because the same packer serves both the sprite atlas and (in principle) a preview sheet.
 */
export async function buildAtlas(options: AtlasOptions): Promise<AtlasResult> {
  const { components, theme, scale, trimPad, image } = options;
  const items: PackedItem[] = [];

  for (let i = 0; i < components.length; i++) {
    const component = components[i];
    if (!component) continue;
    options.onProgress?.(i + 1, components.length, component.name);
    const canvas = await rasterize(component.svg, component.w, component.h, scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not read back the rasterized component.');
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const meta = frameMeta({
      rgba: pixels,
      w: canvas.width,
      h: canvas.height,
      theme,
      scale,
      comp: {
        name: component.name,
        w: component.w,
        h: component.h,
        anchors: component.anchors,
        kind: component.tab,
      },
    });
    items.push({
      name: component.name,
      canvas,
      meta,
      src: pickSource(meta, canvas, trimPad),
      x: 0,
      y: 0,
    });
  }

  // Shelf packing: tallest first, one row at a time. Not optimal, but the sheet is authored
  // art rather than a build artifact — legibility of the layout beats the last few percent.
  const maxWidth = 2048 * Math.min(scale, 2);
  items.sort((a, b) => b.src.h - a.src.h);
  let x = PADDING;
  let y = PADDING;
  let rowHeight = 0;
  let usedWidth = 0;
  for (const item of items) {
    if (x + item.src.w + PADDING > maxWidth) {
      x = PADDING;
      y += rowHeight + PADDING;
      rowHeight = 0;
    }
    item.x = x;
    item.y = y;
    x += item.src.w + PADDING;
    rowHeight = Math.max(rowHeight, item.src.h);
    usedWidth = Math.max(usedWidth, item.x + item.src.w + PADDING);
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, usedWidth);
  canvas.height = Math.max(1, y + rowHeight + PADDING);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D canvas context for the atlas.');

  const frames: Record<string, AtlasFrame> = {};
  const warnings: Record<string, string[]> = {};
  let warned = 0;
  for (const item of items) {
    const src = item.src;
    ctx.drawImage(item.canvas, src.x, src.y, src.w, src.h, item.x, item.y, src.w, src.h);
    frames[item.name] = describeFrame(item, trimPad);
    if (item.meta.warnings.length) {
      warnings[item.name] = item.meta.warnings;
      warned++;
    }
  }

  const manifest: AtlasManifest = {
    frames,
    meta: {
      app: 'UI Kit Forge',
      version: '2.0',
      image: `${image}.png`,
      format: 'RGBA8888',
      size: { w: canvas.width, h: canvas.height },
      scale: String(scale),
      padTrimmed: trimPad,
      theme: { ...theme },
    },
  };

  return { canvas, manifest, frames, count: items.length, warned, warnings };
}
