import { BufferGeometry, Float32BufferAttribute } from 'three';

/**
 * Fill algorithm for {@link buildTiledSpriteGeometry} — how a single texture is
 * mapped onto a rectangle of arbitrary size.
 *
 * - `stretch`         — one quad, texture stretched to fill (like Sprite2D).
 * - `tile`            — the texture repeats across the rect at its natural size
 *                       (scaled by `tileScale`, phase-shifted by `tileOffset`).
 * - `nine-slice`      — a 3×3 grid: the four corners keep a fixed pixel size, the
 *                       edges and centre scale (or tile) to fill. Great for UI
 *                       panels / windows with rounded or decorated borders.
 * - `three-slice-h`   — a horizontal 3-part strip (left cap · middle · right cap);
 *                       only the left/right borders matter. For horizontal bars.
 * - `three-slice-v`   — a vertical 3-part strip (bottom cap · middle · top cap).
 */
export type TiledSpritePatchMode =
  | 'stretch'
  | 'tile'
  | 'nine-slice'
  | 'three-slice-h'
  | 'three-slice-v';

/** Per-axis fill for the stretchable regions of a slice mode. */
export type TiledSpriteAxisStretch = 'stretch' | 'tile';

/** Border insets, in *source-texture pixels*, that separate the fixed corners
 * from the stretchable middle (Godot's `patch_margin_*`, Unity's sprite border). */
export interface TiledSpriteSliceBorder {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface TiledSpriteVector2Like {
  x: number;
  y: number;
}

export interface TiledSpriteGeometryParams {
  mode: TiledSpritePatchMode;
  /** On-screen width in design pixels. */
  width: number;
  /** On-screen height in design pixels. */
  height: number;
  /** Natural texture width in pixels (used to map borders/tiles to UVs). */
  textureWidth: number;
  /** Natural texture height in pixels. */
  textureHeight: number;
  border: TiledSpriteSliceBorder;
  /** When false, the 9-slice centre quad is omitted (hollow frame, Godot's
   * `draw_center`). Ignored by non-slice modes. */
  drawCenter: boolean;
  /** How the horizontal middle column fills in slice modes. */
  axisStretchHorizontal: TiledSpriteAxisStretch;
  /** How the vertical middle row fills in slice modes. */
  axisStretchVertical: TiledSpriteAxisStretch;
  /** Tile-size multiplier for `tile` mode (1 = natural texture size). */
  tileScale: TiledSpriteVector2Like;
  /** UV phase offset (in tiles) for `tile` mode. */
  tileOffset: TiledSpriteVector2Like;
}

const EPSILON = 1e-4;
/** Guard against runaway vertex counts if a tile size is tiny relative to the rect. */
const MAX_TILES_PER_AXIS = 4096;

interface AxisSegment {
  start: number;
  end: number;
  uv0: number;
  uv1: number;
}

interface QuadUV {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * Splits a 1D span `[posStart, posEnd]` into repeated segments of `tileLength`,
 * mapping each onto the UV range `[uvStart, uvEnd]`. The final segment is clipped
 * (partial tile). `offset` shifts the phase by a fraction of a tile.
 *
 * Falls back to a single stretched segment when the tile length is invalid or the
 * repeat count would exceed {@link MAX_TILES_PER_AXIS}.
 */
function tileAxisSegments(
  posStart: number,
  posEnd: number,
  uvStart: number,
  uvEnd: number,
  tileLength: number,
  offset: number
): AxisSegment[] {
  const span = posEnd - posStart;
  if (span <= EPSILON) {
    return [];
  }

  const single: AxisSegment[] = [{ start: posStart, end: posEnd, uv0: uvStart, uv1: uvEnd }];
  if (!Number.isFinite(tileLength) || tileLength <= EPSILON) {
    return single;
  }
  if (span / tileLength > MAX_TILES_PER_AXIS) {
    return single;
  }

  const uvSpan = uvEnd - uvStart;
  let frac = offset - Math.floor(offset);
  if (!Number.isFinite(frac)) {
    frac = 0;
  }

  const segments: AxisSegment[] = [];
  let pos = posStart;
  let uvCursor = uvStart + frac * uvSpan;
  let remaining = (1 - frac) * tileLength;
  if (remaining <= EPSILON) {
    // frac ≈ 1 → start cleanly on a full tile
    remaining = tileLength;
    uvCursor = uvStart;
  }

  let guard = 0;
  while (pos < posEnd - EPSILON && guard <= MAX_TILES_PER_AXIS + 2) {
    guard += 1;
    const segLength = Math.min(remaining, posEnd - pos);
    const segFraction = segLength / tileLength;
    segments.push({
      start: pos,
      end: pos + segLength,
      uv0: uvCursor,
      uv1: uvCursor + segFraction * uvSpan,
    });
    pos += segLength;
    uvCursor = uvStart;
    remaining = tileLength;
  }

  return segments;
}

/** Non-tiling axis: a single segment spanning the full position/UV range. */
function stretchAxisSegment(
  posStart: number,
  posEnd: number,
  uvStart: number,
  uvEnd: number
): AxisSegment[] {
  if (posEnd - posStart <= EPSILON) {
    return [];
  }
  return [{ start: posStart, end: posEnd, uv0: uvStart, uv1: uvEnd }];
}

/** Emits the cross-product of X and Y segments as quads, skipping zero-area cells. */
function pushQuads(out: QuadUV[], xSegments: AxisSegment[], ySegments: AxisSegment[]): void {
  for (const y of ySegments) {
    if (y.end - y.start <= EPSILON) {
      continue;
    }
    for (const x of xSegments) {
      if (x.end - x.start <= EPSILON) {
        continue;
      }
      out.push({
        x0: x.start,
        y0: y.start,
        x1: x.end,
        y1: y.end,
        u0: x.uv0,
        v0: y.uv0,
        u1: x.uv1,
        v1: y.uv1,
      });
    }
  }
}

/** Clamps two opposing insets so they never overlap the available extent,
 * shrinking both proportionally (matching Godot's NinePatchRect behaviour). */
function fitPair(a: number, b: number, extent: number): { a: number; b: number } {
  const safeA = Math.max(0, Number.isFinite(a) ? a : 0);
  const safeB = Math.max(0, Number.isFinite(b) ? b : 0);
  const sum = safeA + safeB;
  if (sum > extent && sum > EPSILON) {
    const k = extent / sum;
    return { a: safeA * k, b: safeB * k };
  }
  return { a: safeA, b: safeB };
}

/**
 * Builds a centred (`[-w/2, +w/2] × [-h/2, +h/2]`, +Z-facing) {@link BufferGeometry}
 * whose UVs map a single texture onto the rect according to `mode`. Adjacent slice
 * regions are emitted as independent quads (no shared vertices) because they carry
 * different UVs at coincident positions — so this uses per-quad UVs on a plain
 * `ClampToEdge` texture rather than `RepeatWrapping`, which also lets 9-slice edges
 * tile without clobbering the corner UVs.
 *
 * The result is shared by the runtime {@link TiledSprite2D} node and the editor
 * viewport proxy so both renderers stay pixel-identical.
 */
export function buildTiledSpriteGeometry(params: TiledSpriteGeometryParams): BufferGeometry {
  const width = Math.max(0, Number.isFinite(params.width) ? params.width : 0);
  const height = Math.max(0, Number.isFinite(params.height) ? params.height : 0);
  const halfW = width / 2;
  const halfH = height / 2;
  const srcW = params.textureWidth > 0 ? params.textureWidth : width > 0 ? width : 1;
  const srcH = params.textureHeight > 0 ? params.textureHeight : height > 0 ? height : 1;

  const quads: QuadUV[] = [];

  if (params.mode === 'stretch') {
    pushQuads(
      quads,
      stretchAxisSegment(-halfW, halfW, 0, 1),
      stretchAxisSegment(-halfH, halfH, 0, 1)
    );
  } else if (params.mode === 'tile') {
    const tileScaleX =
      Number.isFinite(params.tileScale.x) && params.tileScale.x > 0 ? params.tileScale.x : 1;
    const tileScaleY =
      Number.isFinite(params.tileScale.y) && params.tileScale.y > 0 ? params.tileScale.y : 1;
    const tileW = Math.max(EPSILON, srcW * tileScaleX);
    const tileH = Math.max(EPSILON, srcH * tileScaleY);
    const xs = tileAxisSegments(-halfW, halfW, 0, 1, tileW, params.tileOffset.x || 0);
    const ys = tileAxisSegments(-halfH, halfH, 0, 1, tileH, params.tileOffset.y || 0);
    pushQuads(quads, xs, ys);
  } else {
    buildSliceQuads(quads, params, { width, height, halfW, halfH, srcW, srcH });
  }

  return assembleGeometry(quads);
}

function buildSliceQuads(
  out: QuadUV[],
  params: TiledSpriteGeometryParams,
  dims: { width: number; height: number; halfW: number; halfH: number; srcW: number; srcH: number }
): void {
  const { width, height, halfW, halfH, srcW, srcH } = dims;

  let borderLeft = Math.max(0, params.border.left);
  let borderRight = Math.max(0, params.border.right);
  let borderTop = Math.max(0, params.border.top);
  let borderBottom = Math.max(0, params.border.bottom);

  // Degenerate the perpendicular borders for the 3-slice modes.
  if (params.mode === 'three-slice-h') {
    borderTop = 0;
    borderBottom = 0;
  } else if (params.mode === 'three-slice-v') {
    borderLeft = 0;
    borderRight = 0;
  }

  // UV split: borders are source pixels; clamp so the middle stays non-negative.
  const uvX = fitPair(borderLeft, borderRight, srcW);
  const uvY = fitPair(borderBottom, borderTop, srcH);
  const uLeft = uvX.a / srcW;
  const uRight = 1 - uvX.b / srcW;
  const vBottom = uvY.a / srcH;
  const vTop = 1 - uvY.b / srcH;

  // On-screen split: same source-pixel widths, clamped to fit the rect.
  const screenX = fitPair(borderLeft, borderRight, width);
  const screenY = fitPair(borderBottom, borderTop, height);
  const xCols = [-halfW, -halfW + screenX.a, halfW - screenX.b, halfW];
  const yRows = [-halfH, -halfH + screenY.a, halfH - screenY.b, halfH];
  const uCols = [0, uLeft, uRight, 1];
  const vRows = [0, vBottom, vTop, 1];

  // Source-space size of the tiling middle region (design px == source px 1:1).
  const srcMidW = srcW * (uRight - uLeft);
  const srcMidH = srcH * (vTop - vBottom);
  const tileH = params.axisStretchHorizontal === 'tile';
  const tileV = params.axisStretchVertical === 'tile';

  for (let ri = 0; ri < 3; ri += 1) {
    for (let ci = 0; ci < 3; ci += 1) {
      const isCenter = ci === 1 && ri === 1;
      if (isCenter && !params.drawCenter) {
        continue;
      }

      const xSegments =
        ci === 1 && tileH
          ? tileAxisSegments(xCols[1], xCols[2], uCols[1], uCols[2], srcMidW, 0)
          : stretchAxisSegment(xCols[ci], xCols[ci + 1], uCols[ci], uCols[ci + 1]);

      const ySegments =
        ri === 1 && tileV
          ? tileAxisSegments(yRows[1], yRows[2], vRows[1], vRows[2], srcMidH, 0)
          : stretchAxisSegment(yRows[ri], yRows[ri + 1], vRows[ri], vRows[ri + 1]);

      pushQuads(out, xSegments, ySegments);
    }
  }
}

function assembleGeometry(quads: QuadUV[]): BufferGeometry {
  const positions = new Float32Array(quads.length * 18); // 6 verts × 3
  const uvs = new Float32Array(quads.length * 12); // 6 verts × 2
  const normals = new Float32Array(quads.length * 18);

  let p = 0;
  let u = 0;
  for (const q of quads) {
    // Two CCW (front-facing, +Z) triangles: (BL, BR, TR) and (BL, TR, TL).
    // prettier-ignore
    const verts = [
      q.x0, q.y0, q.u0, q.v0, // BL
      q.x1, q.y0, q.u1, q.v0, // BR
      q.x1, q.y1, q.u1, q.v1, // TR
      q.x0, q.y0, q.u0, q.v0, // BL
      q.x1, q.y1, q.u1, q.v1, // TR
      q.x0, q.y1, q.u0, q.v1, // TL
    ];
    for (let i = 0; i < 6; i += 1) {
      const base = i * 4;
      positions[p] = verts[base];
      positions[p + 1] = verts[base + 1];
      positions[p + 2] = 0;
      normals[p] = 0;
      normals[p + 1] = 0;
      normals[p + 2] = 1;
      p += 3;
      uvs[u] = verts[base + 2];
      uvs[u + 1] = verts[base + 3];
      u += 2;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
