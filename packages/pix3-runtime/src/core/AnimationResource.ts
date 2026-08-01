export interface AnimationVector2 {
  x: number;
  y: number;
}

export interface AnimationBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnimationPolygonPoint {
  x: number;
  y: number;
}

export type AnimationPlaybackMode = 'normal' | 'ping-pong';

/**
 * A signal emitted when a flipbook clip enters this frame during play-driven
 * advance (AnimatedSprite2D/3D). `args` is a raw string parsed at fire time by
 * `parseEventArgs` (same convention as the keyframe event-track).
 */
export interface AnimationFrameEvent {
  signal: string;
  args: string;
}

/** Intrinsic pixel size of a frame's raster. `0×0` means "unknown". */
export interface AnimationSize {
  width: number;
  height: number;
}

/**
 * A named point that lives in frame space and moves (and rotates) across frames —
 * a muzzle on a gun barrel, a hand socket an item follows through a walk cycle.
 * Construct 3 calls these "image points"; the `angle` makes ours a full 2D socket
 * (a direction, not just a position).
 *
 * Coordinates are normalized to the frame rect with y measured from the top, the
 * same convention as {@link AnimationFrame.anchor} (the UI shows pixels). `angle`
 * is in degrees, clockwise, 0 = pointing right.
 */
export interface AnimationFramePoint {
  name: string;
  x: number;
  y: number;
  angle?: number;
}

export interface AnimationFrame {
  textureIndex: number;
  offset: AnimationVector2;
  repeat: AnimationVector2;
  durationMultiplier: number;
  /**
   * The frame's own origin, normalized to the frame rect with **y measured from
   * the top** (same convention as `boundingBox` and `collisionPolygon`; the
   * editor's overlay places its marker at `top: anchor.y * 100%`). This is the
   * point in the — possibly tightly cropped — raster that lands on the node's
   * position, so cropping a frame and moving its anchor keeps the animation
   * visually identical while the PNG shrinks. Composes with the node-level
   * `AnimatedSprite2D.anchor`, which is a separate global offset.
   */
  anchor: AnimationVector2;
  texturePath: string;
  boundingBox: AnimationBoundingBox;
  collisionPolygon: AnimationPolygonPoint[];
  /**
   * Signals fired when the clip enters this frame (play-mode advance only).
   * Optional so existing frame literals stay valid; `normalizeFrame` always
   * materializes it to `[]`, so runtime (loaded) frames always carry the field.
   */
  events?: AnimationFrameEvent[];
  /**
   * Intrinsic pixel size of this frame's raster, stamped by the editor whenever a
   * frame is added / replaced / cropped so `sizeMode: 'native'` layout never has
   * to wait on a texture load. Optional in authored files; `normalizeFrame`
   * materializes it (falling back to the bounding box, then `0×0`). A `0×0` size
   * makes the frame fall back to stretch layout, so legacy files keep working.
   */
  sourceSize?: AnimationSize;
  /**
   * Named sockets in this frame's space. Optional in authored files;
   * `normalizeFrame` materializes `[]` and de-duplicates names within a frame
   * (first occurrence wins), so runtime frames always carry the field.
   */
  points?: AnimationFramePoint[];
}

export interface AnimationClip {
  name: string;
  frames: AnimationFrame[];
  fps: number;
  loop: boolean;
  playbackMode: AnimationPlaybackMode;
}

export interface AnimationResource {
  version: string;
  texturePath: string;
  clips: AnimationClip[];
}

export function getAnimationFrameTexturePath(
  resource: AnimationResource | null | undefined,
  frame: AnimationFrame | null | undefined
): string {
  if (!frame) {
    return '';
  }

  if (frame.texturePath.trim().length > 0) {
    return frame.texturePath.trim();
  }

  return resource?.texturePath?.trim() ?? '';
}

export function isSequenceAnimationFrame(frame: AnimationFrame | null | undefined): boolean {
  return Boolean(frame?.texturePath?.trim());
}

function normalizeAnchor(value: unknown): AnimationVector2 {
  const candidate = typeof value === 'object' && value !== null ? value : {};
  const x =
    typeof (candidate as { x?: unknown }).x === 'number' ? (candidate as { x: number }).x : 0.5;
  const y =
    typeof (candidate as { y?: unknown }).y === 'number' ? (candidate as { y: number }).y : 0.5;
  return { x, y };
}

function normalizeVector2(value: unknown): AnimationVector2 {
  const candidate = typeof value === 'object' && value !== null ? value : {};
  const x =
    typeof (candidate as { x?: unknown }).x === 'number' ? (candidate as { x: number }).x : 0;
  const y =
    typeof (candidate as { y?: unknown }).y === 'number' ? (candidate as { y: number }).y : 0;
  return { x, y };
}

function normalizeFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeBoundingBox(value: unknown): AnimationBoundingBox {
  const candidate = typeof value === 'object' && value !== null ? value : {};
  return {
    x: normalizeFiniteNumber((candidate as { x?: unknown }).x),
    y: normalizeFiniteNumber((candidate as { y?: unknown }).y),
    width: Math.max(0, normalizeFiniteNumber((candidate as { width?: unknown }).width)),
    height: Math.max(0, normalizeFiniteNumber((candidate as { height?: unknown }).height)),
  };
}

function normalizePolygonPoint(value: unknown): AnimationPolygonPoint {
  return normalizeVector2(value);
}

function normalizeFrameEvents(value: unknown): AnimationFrameEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const events: AnimationFrameEvent[] = [];
  for (const entry of value) {
    const candidate = typeof entry === 'object' && entry !== null ? entry : {};
    const signal =
      typeof (candidate as { signal?: unknown }).signal === 'string'
        ? (candidate as { signal: string }).signal.trim()
        : '';
    if (signal.length === 0) {
      continue;
    }
    const args =
      typeof (candidate as { args?: unknown }).args === 'string'
        ? (candidate as { args: string }).args
        : '';
    events.push({ signal, args });
  }
  return events;
}

function normalizeFramePoints(value: unknown): AnimationFramePoint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const points: AnimationFramePoint[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const candidate = typeof entry === 'object' && entry !== null ? entry : {};
    const name =
      typeof (candidate as { name?: unknown }).name === 'string'
        ? (candidate as { name: string }).name.trim()
        : '';
    // A point is addressed by name, so an unnamed or duplicate one is unusable.
    if (name.length === 0 || seen.has(name)) {
      continue;
    }
    seen.add(name);

    const angle = normalizeFiniteNumber((candidate as { angle?: unknown }).angle);
    points.push({
      name,
      x: normalizeFiniteNumber((candidate as { x?: unknown }).x, 0.5),
      y: normalizeFiniteNumber((candidate as { y?: unknown }).y, 0.5),
      ...(angle !== 0 ? { angle } : {}),
    });
  }

  return points;
}

function normalizeSourceSize(value: unknown, boundingBox: AnimationBoundingBox): AnimationSize {
  const candidate = typeof value === 'object' && value !== null ? value : null;
  const width = Math.max(0, normalizeFiniteNumber((candidate as { width?: unknown })?.width));
  const height = Math.max(0, normalizeFiniteNumber((candidate as { height?: unknown })?.height));
  if (width > 0 && height > 0) {
    return { width, height };
  }

  // No explicit size: the bounding box is the best available description of the
  // frame's extent (the editor authors it in source pixels). Zero when neither
  // is known — callers treat that as "unknown" and fall back to stretch layout.
  return { width: boundingBox.width, height: boundingBox.height };
}

function normalizePlaybackMode(value: unknown): AnimationPlaybackMode {
  return value === 'ping-pong' ? 'ping-pong' : 'normal';
}

function normalizeFrame(frame: unknown): AnimationFrame {
  const candidate = typeof frame === 'object' && frame !== null ? frame : {};
  const textureIndex =
    typeof (candidate as { textureIndex?: unknown }).textureIndex === 'number'
      ? Math.max(0, Math.floor((candidate as { textureIndex: number }).textureIndex))
      : 0;
  const boundingBox = normalizeBoundingBox((candidate as { boundingBox?: unknown }).boundingBox);

  return {
    textureIndex,
    offset: normalizeVector2((candidate as { offset?: unknown }).offset),
    repeat: normalizeVector2((candidate as { repeat?: unknown }).repeat),
    durationMultiplier: Math.max(
      0.001,
      normalizeFiniteNumber((candidate as { durationMultiplier?: unknown }).durationMultiplier, 1)
    ),
    anchor: normalizeAnchor((candidate as { anchor?: unknown }).anchor),
    texturePath:
      typeof (candidate as { texturePath?: unknown }).texturePath === 'string'
        ? (candidate as { texturePath: string }).texturePath.trim()
        : '',
    boundingBox,
    collisionPolygon: Array.isArray((candidate as { collisionPolygon?: unknown }).collisionPolygon)
      ? ((candidate as { collisionPolygon: unknown[] }).collisionPolygon ?? []).map(
          normalizePolygonPoint
        )
      : [],
    events: normalizeFrameEvents((candidate as { events?: unknown }).events),
    sourceSize: normalizeSourceSize(
      (candidate as { sourceSize?: unknown }).sourceSize,
      boundingBox
    ),
    points: normalizeFramePoints((candidate as { points?: unknown }).points),
  };
}

/** Look up a named point on a frame, or `null` when the frame doesn't define it. */
export function findAnimationFramePoint(
  frame: AnimationFrame | null | undefined,
  name: string
): AnimationFramePoint | null {
  if (!frame?.points || name.length === 0) {
    return null;
  }
  return frame.points.find(point => point.name === name) ?? null;
}

/** Every point name defined anywhere in a clip, in first-seen order. */
export function collectClipPointNames(clip: AnimationClip | null | undefined): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const frame of clip?.frames ?? []) {
    for (const point of frame.points ?? []) {
      if (!seen.has(point.name)) {
        seen.add(point.name);
        names.push(point.name);
      }
    }
  }
  return names;
}

function normalizeClip(clip: unknown, index: number): AnimationClip {
  const candidate = typeof clip === 'object' && clip !== null ? clip : {};
  const rawFrames = Array.isArray((candidate as { frames?: unknown }).frames)
    ? ((candidate as { frames: unknown[] }).frames ?? [])
    : [];

  return {
    name:
      typeof (candidate as { name?: unknown }).name === 'string' &&
      (candidate as { name: string }).name.trim().length > 0
        ? (candidate as { name: string }).name.trim()
        : `clip-${index + 1}`,
    frames: rawFrames.map(normalizeFrame),
    fps:
      typeof (candidate as { fps?: unknown }).fps === 'number' &&
      Number.isFinite((candidate as { fps: number }).fps) &&
      (candidate as { fps: number }).fps > 0
        ? (candidate as { fps: number }).fps
        : 12,
    loop:
      typeof (candidate as { loop?: unknown }).loop === 'boolean'
        ? (candidate as { loop: boolean }).loop
        : true,
    playbackMode: normalizePlaybackMode((candidate as { playbackMode?: unknown }).playbackMode),
  };
}

export function normalizeAnimationResource(resource: unknown): AnimationResource {
  const candidate = typeof resource === 'object' && resource !== null ? resource : {};
  const rawClips = Array.isArray((candidate as { clips?: unknown }).clips)
    ? ((candidate as { clips: unknown[] }).clips ?? [])
    : [];

  return {
    version:
      typeof (candidate as { version?: unknown }).version === 'string' &&
      (candidate as { version: string }).version.trim().length > 0
        ? (candidate as { version: string }).version.trim()
        : '1.0.0',
    texturePath:
      typeof (candidate as { texturePath?: unknown }).texturePath === 'string'
        ? (candidate as { texturePath: string }).texturePath.trim()
        : '',
    clips: rawClips.map(normalizeClip),
  };
}

export function findAnimationClip(
  resource: AnimationResource | null | undefined,
  clipName: string | null | undefined
): AnimationClip | null {
  if (!resource || resource.clips.length === 0) {
    return null;
  }

  if (!clipName) {
    return resource.clips[0] ?? null;
  }

  return resource.clips.find(clip => clip.name === clipName) ?? resource.clips[0] ?? null;
}
