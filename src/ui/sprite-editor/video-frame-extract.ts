/**
 * §9.12.5 — pulling animation frames out of a video file, in the browser and
 * nothing else: a detached `<video>` element parked on one timestamp at a time,
 * `canvas.drawImage(video)` for the grab, PNG out. No ffmpeg, no wasm, no worker.
 *
 * The module is split the way the rest of §9.12 is split: the arithmetic that
 * decides *which* timestamps to grab is a pure function ({@link planVideoFrameTimes})
 * with no DOM in it at all, and the two functions that do touch the DOM
 * ({@link loadVideoFile}, {@link grabVideoFrames}) hold no policy. The host owns
 * the confirm, the status line and the write-back — grabbing produces plain
 * `File`s so they can go through the very same `importOsFiles` path an OS image
 * drop uses (§8.2's managed-folder naming, and one undo step for the append).
 *
 * The trap this file exists to avoid: **a seek is not instantaneous**. Setting
 * `currentTime` and drawing on the next line captures whatever frame was already
 * presented, so a naive loop silently writes N copies of frame 0. Every grab here
 * goes through {@link seekVideoTo}, which waits for `requestVideoFrameCallback`
 * (the new frame really is on screen) or, where that does not exist, for the
 * `seeked` event.
 */

/**
 * Hard ceiling on one import. 300 frames is already an order of magnitude more
 * than a hand-authored clip (SkyDefender's longest is 22) and is where the cost
 * stops being invisible: every grabbed PNG is held in memory until the batch is
 * written, because {@link importOsFiles} has to number the whole run in one call.
 * Past this the user is asked to narrow the range or lower the fps rather than
 * being handed a 4-minute freeze and a 900-file sprite folder.
 */
export const MAX_VIDEO_IMPORT_FRAMES = 300;

/** Sample rates the picker offers. Sprite work lives at the low end of these. */
export const VIDEO_IMPORT_FPS_CHOICES: readonly number[] = [2, 4, 6, 8, 10, 12, 15, 20, 24, 30];

/** Matches the default clip fps the animation document is created with. */
export const DEFAULT_VIDEO_IMPORT_FPS = 12;

/** How long one seek may take before the video counts as unseekable. */
const DEFAULT_SEEK_TIMEOUT_MS = 5_000;

/** How long the file has to produce a decoded first frame before it counts as undecodable. */
const DEFAULT_LOAD_TIMEOUT_MS = 15_000;

/** `HTMLMediaElement.HAVE_CURRENT_DATA` — a frame for the current position exists. */
const HAVE_CURRENT_DATA = 2;

export type VideoFramePlanStatus = 'ok' | 'no-duration' | 'empty-range' | 'too-many';

export interface VideoFramePlanOptions {
  /** The video's own length, seconds. */
  duration: number;
  /** Frames to sample per second of source. */
  fps: number;
  /** Start of the trim range, seconds. Clamped into the video. */
  inSeconds: number;
  /** End of the trim range, seconds. Clamped into the video, never below `inSeconds`. */
  outSeconds: number;
  /** Defaults to {@link MAX_VIDEO_IMPORT_FRAMES}. */
  maxFrames?: number;
}

export interface VideoFramePlan {
  status: VideoFramePlanStatus;
  /** Timestamps to grab, ascending. Empty unless `status` is `ok`. */
  times: number[];
  /** How many frames the range asks for — populated even when the cap refused them. */
  requested: number;
  maxFrames: number;
  /** The range actually planned, after clamping into the video. */
  inSeconds: number;
  outSeconds: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min;

/**
 * Decide which timestamps an import should grab. Pure — every guard the contract
 * names except "the browser cannot decode this file" is decided here, so all of
 * them are testable without a video codec:
 *
 * - a zero-length (or endless — a live stream reports `Infinity`) video →
 *   `no-duration`;
 * - an in/out range that holds less than one frame at the chosen fps →
 *   `empty-range`;
 * - a range that would produce more than `maxFrames` → `too-many`, carrying
 *   `requested` so the host can say by how much.
 *
 * Frames are sampled at `in + i/fps`, i.e. from the *start* of the range and never
 * past `out`: the last slot of a 1 s range at 12 fps is 0.9167 s, not 1.0 s, which
 * would be one frame past the end of the video and is exactly where a decoder
 * hands back nothing.
 */
export function planVideoFrameTimes(options: VideoFramePlanOptions): VideoFramePlan {
  const maxFrames = Math.max(1, Math.floor(options.maxFrames ?? MAX_VIDEO_IMPORT_FRAMES));
  const duration = options.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      status: 'no-duration',
      times: [],
      requested: 0,
      maxFrames,
      inSeconds: 0,
      outSeconds: 0,
    };
  }

  const inSeconds = clamp(options.inSeconds, 0, duration);
  const outSeconds = clamp(options.outSeconds, inSeconds, duration);
  const fps = Number.isFinite(options.fps) ? options.fps : 0;
  const span = outSeconds - inSeconds;
  // The epsilon absorbs binary float error: 0.3 s × 10 fps is 2.9999999999999996
  // slots, and the user asked for three.
  const requested = fps > 0 && span > 0 ? Math.floor(span * fps + 1e-6) : 0;

  if (requested <= 0) {
    return { status: 'empty-range', times: [], requested: 0, maxFrames, inSeconds, outSeconds };
  }
  if (requested > maxFrames) {
    return { status: 'too-many', times: [], requested, maxFrames, inSeconds, outSeconds };
  }

  return {
    status: 'ok',
    times: Array.from({ length: requested }, (_unused, index) => inSeconds + index / fps),
    requested,
    maxFrames,
    inSeconds,
    outSeconds,
  };
}

export interface LoadedVideo {
  video: HTMLVideoElement;
  objectUrl: string;
  /** Seconds. Can be `Infinity` for a stream — {@link planVideoFrameTimes} refuses those. */
  duration: number;
  width: number;
  height: number;
  /** Revoke the object URL and let the decoder go. Safe to call twice. */
  release(): void;
}

/**
 * Decode enough of `file` to grab frames from it: metadata *and* a first frame
 * (`loadeddata`), which is the cheapest honest test that the browser can actually
 * decode this container/codec pair. A file it cannot open fires `error` instead —
 * and a file that does neither (a truncated upload) is caught by the timeout, so
 * the picker can never hang on it.
 */
export async function loadVideoFile(
  file: Blob,
  options: { timeoutMs?: number } = {}
): Promise<LoadedVideo> {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;

  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error('Timed out while decoding this video.'));
      }, options.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);

      function finish(error?: Error): void {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        video.removeEventListener('loadeddata', onLoaded);
        video.removeEventListener('error', onError);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }
      const onLoaded = (): void => finish();
      const onError = (): void =>
        finish(new Error('The browser could not decode this video file.'));

      video.addEventListener('loadeddata', onLoaded);
      video.addEventListener('error', onError);
      video.src = objectUrl;
    });
  } catch (error) {
    release();
    throw error;
  }

  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width <= 0 || height <= 0) {
    release();
    throw new Error('This file has no video track to grab frames from.');
  }

  return { video, objectUrl, duration: video.duration, width, height, release };
}

/**
 * Park `video` on `time` and resolve only once the frame at that timestamp is the
 * one the element would paint. **Everything in this file depends on that "only
 * once"** — grabbing on the line after `currentTime = t` captures the *previous*
 * frame, which is how a video importer ends up writing the same PNG N times.
 *
 * Two signals, in order of trustworthiness:
 *
 * 1. `requestVideoFrameCallback` fires when a new frame has actually been
 *    presented to the compositor, which is precisely the question being asked.
 * 2. Where it does not exist (Firefox), the `seeked` event — the fallback the
 *    contract names.
 *
 * The timeout is not just a hang guard. `rVFC` on a *paused* element is a weaker
 * promise than the spec suggests, so if it never fires but the seek itself
 * completed, the seek is taken rather than failed; only a seek that never lands
 * at all rejects, which is what an unseekable (or truncated) file looks like.
 */
export async function seekVideoTo(
  video: HTMLVideoElement,
  time: number,
  timeoutMs: number = DEFAULT_SEEK_TIMEOUT_MS
): Promise<void> {
  // Already parked here with a decoded frame — the first grab of a range starting
  // at 0 is exactly this case, and asking a browser to seek to where it already is
  // does not reliably fire `seeked`.
  if (Math.abs(video.currentTime - time) < 1e-6 && video.readyState >= HAVE_CURRENT_DATA) {
    return;
  }

  const useFrameCallback = typeof video.requestVideoFrameCallback === 'function';
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let sawSeeked = false;
    let frameHandle = 0;

    const timer = setTimeout(() => {
      if (sawSeeked) {
        finish();
        return;
      }
      finish(new Error(`The video could not be seeked to ${time.toFixed(3)}s.`));
    }, timeoutMs);

    function finish(error?: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      if (frameHandle && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameHandle);
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    const onSeeked = (): void => {
      sawSeeked = true;
      if (!useFrameCallback) {
        finish();
      }
    };
    const onError = (): void => finish(new Error('The video stopped decoding mid-import.'));

    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    if (useFrameCallback) {
      frameHandle = video.requestVideoFrameCallback(() => {
        frameHandle = 0;
        finish();
      });
    }

    video.currentTime = time;
  });
}

export interface VideoFrameGrabOptions {
  /** Timestamps to grab — {@link planVideoFrameTimes}'s output. */
  times: readonly number[];
  /**
   * Stem for the produced files. Only the extension survives `importOsFiles`
   * (which renames every frame to `<clip>_<nnnn>.png`), but a readable name makes
   * the intermediate `File`s legible in a debugger.
   */
  namePrefix?: string;
  seekTimeoutMs?: number;
  /** Called after every grab so a long import can show progress. */
  onProgress?: (grabbed: number, total: number) => void;
}

export interface VideoFrameGrabResult {
  /** One PNG per grabbed timestamp, in order. */
  files: File[];
  /** Timestamps the video had no decodable frame for (past its real end). */
  skipped: number;
  /** Timestamps whose draw or encode threw. */
  failed: number;
}

/**
 * Grab one PNG per timestamp. Follows §9.12.1's shape at the level above:
 * everything is produced first and handed back in one batch, so the caller can
 * write every file and then push a **single** document update.
 *
 * A timestamp the decoder has nothing for is a *skip*, not a failure — the same
 * call `applyRasterOpToClipFrames` makes when a raster op hands back an empty
 * result. A seek that never lands, by contrast, aborts the whole run: it means the
 * file is unseekable, every later timestamp would fail identically, and at the
 * cap that is 300 timeouts in a row.
 */
export async function grabVideoFrames(
  video: HTMLVideoElement,
  options: VideoFrameGrabOptions
): Promise<VideoFrameGrabResult> {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2D canvas context unavailable');
  }

  const namePrefix = options.namePrefix ?? 'video-frame';
  const total = options.times.length;
  const files: File[] = [];
  let skipped = 0;
  let failed = 0;

  for (const [index, time] of options.times.entries()) {
    await seekVideoTo(video, time, options.seekTimeoutMs);

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width <= 0 || height <= 0) {
      skipped += 1;
      options.onProgress?.(index + 1, total);
      continue;
    }

    try {
      canvas.width = width;
      canvas.height = height;
      context.drawImage(video, 0, 0, width, height);
      const blob = await canvasToPng(canvas);
      files.push(
        new File([blob], `${namePrefix}_${String(index + 1).padStart(4, '0')}.png`, {
          type: 'image/png',
        })
      );
    } catch (error) {
      console.warn('[SpriteEditor] Failed to grab a video frame at', time, error);
      failed += 1;
    }
    options.onProgress?.(index + 1, total);
  }

  return { files, skipped, failed };
}

/** Promise wrapper over the callback-style `toBlob`, PNG so alpha (and quality) survive. */
function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Failed to encode the grabbed frame'))),
      'image/png'
    );
  });
}

/** Seconds as `m:ss.s` — short enough for a slider readout. */
export function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00.0';
  }
  // Round to the displayed precision *before* splitting: 59.96 s rounds to 60.0,
  // which as a remainder would read "0:60.0" rather than "1:00.0".
  const tenths = Math.round(seconds * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}
