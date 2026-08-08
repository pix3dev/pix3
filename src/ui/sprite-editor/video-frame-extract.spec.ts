import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_VIDEO_IMPORT_FRAMES,
  formatVideoTime,
  grabVideoFrames,
  loadVideoFile,
  planVideoFrameTimes,
  seekVideoTo,
} from './video-frame-extract';

/**
 * §9.12.5. The planning half is pure and runs exactly as it ships. The grabbing
 * half cannot: happy-dom decodes no video and has no 2D canvas, so both are stood
 * up here — and they are stood up as *models of the browser's timing*, not as
 * shortcuts round it.
 *
 * That timing is the whole point. A real element does not present the frame at
 * `currentTime` on the line after the assignment; it decodes and presents later.
 * {@link FakeVideo} reproduces that by keeping the requested time (`currentTime`)
 * apart from the frame that would actually be painted (`presentedTime`), and the
 * canvas double records the *presented* one. An implementation that grabbed
 * without awaiting the seek would therefore record the same frame N times over,
 * which is precisely the bug §9.12.5 calls out.
 */

interface FakeVideoOptions {
  duration?: number;
  width?: number;
  height?: number;
  /** Emit `requestVideoFrameCallback`, i.e. be a Chrome/Safari-shaped element. */
  frameCallback?: boolean;
  /**
   * Have `requestVideoFrameCallback` but never actually run it, while the seek
   * itself completes — `rVFC` on a *paused* element is a weaker promise than the
   * spec suggests, and this is the shape that makes `seekVideoTo`'s timeout do
   * something other than fail.
   */
  silentFrameCallback?: boolean;
  /** Never complete a seek — an unseekable / truncated file. */
  unseekable?: boolean;
  /** Report a 0×0 frame from this timestamp on (past the real end of the video). */
  emptyFrom?: number;
  /** Fire `error` instead of `loadeddata` when a source is attached. */
  failToLoad?: boolean;
  /** Report no video track once loaded (an audio-only file). */
  noVideoTrack?: boolean;
}

class FakeVideo extends EventTarget {
  public readyState = 0;
  public duration: number;
  /** The frame the element would paint — only catches up when a seek completes. */
  public presentedTime = -1;
  public preload = '';
  public muted = false;
  public playsInline = false;
  public seekCount = 0;
  public frameCallbackCount = 0;

  private time = 0;
  private source = '';
  private pendingFrameCallback: (() => void) | null = null;
  private nextHandle = 1;

  constructor(private readonly options: FakeVideoOptions = {}) {
    super();
    this.duration = options.duration ?? 1;
    if (options.frameCallback || options.silentFrameCallback) {
      // Declared conditionally on purpose: the extractor picks its seek signal by
      // `typeof video.requestVideoFrameCallback === 'function'`, so a Firefox-shaped
      // element must genuinely not have it.
      Object.defineProperties(this, {
        requestVideoFrameCallback: {
          value: (callback: () => void) => {
            this.frameCallbackCount += 1;
            this.pendingFrameCallback = callback;
            return this.nextHandle++;
          },
        },
        cancelVideoFrameCallback: {
          value: () => {
            this.pendingFrameCallback = null;
          },
        },
      });
    }
  }

  get videoWidth(): number {
    if (this.options.noVideoTrack) {
      return 0;
    }
    if (this.options.emptyFrom !== undefined && this.presentedTime >= this.options.emptyFrom) {
      return 0;
    }
    return this.options.width ?? 8;
  }

  get videoHeight(): number {
    return this.videoWidth > 0 ? (this.options.height ?? 6) : 0;
  }

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
    if (!value) {
      return;
    }
    setTimeout(() => {
      if (this.options.failToLoad) {
        this.dispatchEvent(new Event('error'));
        return;
      }
      this.readyState = 2;
      this.presentedTime = 0;
      this.dispatchEvent(new Event('loadeddata'));
    }, 1);
  }

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.time = value;
    this.seekCount += 1;
    if (this.options.unseekable) {
      return;
    }
    // The decode is asynchronous, exactly as it is in a browser.
    setTimeout(() => {
      this.presentedTime = value;
      this.readyState = 2;
      if (!this.options.silentFrameCallback) {
        const callback = this.pendingFrameCallback;
        this.pendingFrameCallback = null;
        callback?.();
      }
      this.dispatchEvent(new Event('seeked'));
    }, 1);
  }

  removeAttribute(name: string): void {
    if (name === 'src') {
      this.source = '';
    }
  }

  load(): void {
    this.readyState = 0;
  }
}

const asVideo = (fake: FakeVideo): HTMLVideoElement => fake as unknown as HTMLVideoElement;

/** What the canvas double recorded: the frame that was really on screen per draw. */
interface GrabRecord {
  presentedTime: number;
  width: number;
  height: number;
}

/**
 * Stand up the 2D canvas happy-dom lacks. `toBlob` hands back a distinct blob per
 * call so a duplicated grab would still be visible in the files, and the recorded
 * `presentedTime` is what makes the duplicate assertion possible at all.
 */
function stubGrabCanvas(records: GrabRecord[], options: { failEncode?: boolean } = {}): void {
  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tagName: string, elementOptions?) => {
    if (tagName !== 'canvas') {
      return realCreateElement(tagName, elementOptions as ElementCreationOptions | undefined);
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingEnabled: false,
        drawImage: (source: unknown, _x: number, _y: number, width: number, height: number) => {
          records.push({
            presentedTime: (source as FakeVideo).presentedTime,
            width,
            height,
          });
        },
      }),
      toBlob: (callback: (blob: Blob | null) => void) =>
        callback(
          options.failEncode ? null : new Blob([`frame-${records.length}`], { type: 'image/png' })
        ),
    };
    return canvas as unknown as HTMLElement;
  });
}

describe('planVideoFrameTimes (§9.12.5)', () => {
  it('samples from the start of the range and never past its end', () => {
    const plan = planVideoFrameTimes({ duration: 2, fps: 4, inSeconds: 0, outSeconds: 1 });

    expect(plan.status).toBe('ok');
    expect(plan.times).toEqual([0, 0.25, 0.5, 0.75]);
    expect(plan.requested).toBe(4);
  });

  it('offsets every timestamp by the in point and clamps the range into the video', () => {
    const plan = planVideoFrameTimes({ duration: 1.5, fps: 2, inSeconds: 0.5, outSeconds: 9 });

    expect(plan.inSeconds).toBe(0.5);
    expect(plan.outSeconds).toBe(1.5);
    expect(plan.times).toEqual([0.5, 1]);
  });

  it('absorbs binary float error rather than dropping the last frame', () => {
    // 0.3 × 10 is 2.9999999999999996 in IEEE 754; the user asked for three.
    const plan = planVideoFrameTimes({ duration: 1, fps: 10, inSeconds: 0, outSeconds: 0.3 });

    expect(plan.times).toHaveLength(3);
  });

  it('refuses a video with no usable duration', () => {
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = planVideoFrameTimes({ duration, fps: 12, inSeconds: 0, outSeconds: 1 });
      expect(plan.status).toBe('no-duration');
      expect(plan.times).toEqual([]);
    }
  });

  it('refuses a range that holds less than one frame', () => {
    const tooShort = planVideoFrameTimes({ duration: 5, fps: 12, inSeconds: 1, outSeconds: 1.05 });
    expect(tooShort.status).toBe('empty-range');

    const zeroLength = planVideoFrameTimes({ duration: 5, fps: 12, inSeconds: 2, outSeconds: 2 });
    expect(zeroLength.status).toBe('empty-range');

    const invertedRange = planVideoFrameTimes({
      duration: 5,
      fps: 12,
      inSeconds: 3,
      outSeconds: 1,
    });
    expect(invertedRange.status).toBe('empty-range');

    const noFps = planVideoFrameTimes({ duration: 5, fps: 0, inSeconds: 0, outSeconds: 5 });
    expect(noFps.status).toBe('empty-range');
  });

  it('refuses a frame count large enough to be a mistake, and says how large', () => {
    const plan = planVideoFrameTimes({ duration: 600, fps: 30, inSeconds: 0, outSeconds: 600 });

    expect(plan.status).toBe('too-many');
    expect(plan.requested).toBe(18_000);
    expect(plan.maxFrames).toBe(MAX_VIDEO_IMPORT_FRAMES);
    // Nothing is planned, so no caller can accidentally import a truncated range.
    expect(plan.times).toEqual([]);
  });

  it('honours a caller-supplied cap', () => {
    const plan = planVideoFrameTimes({
      duration: 10,
      fps: 4,
      inSeconds: 0,
      outSeconds: 10,
      maxFrames: 8,
    });

    expect(plan.status).toBe('too-many');
    expect(plan.requested).toBe(40);
    expect(plan.maxFrames).toBe(8);
  });
});

describe('seekVideoTo (§9.12.5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves only once the frame at the requested time is really presented', async () => {
    const video = new FakeVideo();

    const pending = seekVideoTo(asVideo(video), 0.4);
    // The assignment has landed; the frame has not.
    expect(video.currentTime).toBe(0.4);
    expect(video.presentedTime).toBe(-1);

    await pending;
    expect(video.presentedTime).toBe(0.4);
  });

  it('prefers requestVideoFrameCallback when the element has one', async () => {
    const video = new FakeVideo({ frameCallback: true });

    await seekVideoTo(asVideo(video), 0.2);

    expect(video.frameCallbackCount).toBe(1);
    expect(video.presentedTime).toBe(0.2);
  });

  it('does not re-seek when the element is already parked on the frame', async () => {
    const video = new FakeVideo();
    await seekVideoTo(asVideo(video), 0.5);
    expect(video.seekCount).toBe(1);

    await seekVideoTo(asVideo(video), 0.5);

    // Asking a browser to seek where it already is does not reliably fire
    // `seeked`, so the helper must answer from state instead of waiting.
    expect(video.seekCount).toBe(1);
  });

  it('rejects when the seek never lands (an unseekable file)', async () => {
    const video = new FakeVideo({ unseekable: true });

    await expect(seekVideoTo(asVideo(video), 0.3, 20)).rejects.toThrow(/could not be seeked/);
  });

  it('takes a completed seek whose frame callback never fires, rather than failing it', async () => {
    // The timeout is not only a hang guard: `rVFC` on a paused element can simply
    // not fire, and a `seeked` that did arrive is evidence enough that the frame
    // is there. Failing here would abort a whole import on such a browser.
    const video = new FakeVideo({ silentFrameCallback: true });

    await expect(seekVideoTo(asVideo(video), 0.3, 20)).resolves.toBeUndefined();
    expect(video.frameCallbackCount).toBe(1);
    expect(video.presentedTime).toBe(0.3);
  });
});

describe('grabVideoFrames (§9.12.5)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The regression this feature is most likely to ship with: without the awaited
   * seek every grab records the frame that was already presented, so four
   * timestamps produce four copies of frame 0.
   */
  it('captures a distinct frame per timestamp on the seeked fallback', async () => {
    const records: GrabRecord[] = [];
    stubGrabCanvas(records);
    const video = new FakeVideo();
    expect('requestVideoFrameCallback' in video).toBe(false);

    const result = await grabVideoFrames(asVideo(video), { times: [0, 0.25, 0.5, 0.75] });

    expect(records.map(record => record.presentedTime)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(new Set(records.map(record => record.presentedTime)).size).toBe(4);
    expect(result.files).toHaveLength(4);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('captures a distinct frame per timestamp through requestVideoFrameCallback', async () => {
    const records: GrabRecord[] = [];
    stubGrabCanvas(records);
    const video = new FakeVideo({ frameCallback: true });

    await grabVideoFrames(asVideo(video), { times: [0.1, 0.2, 0.3] });

    expect(video.frameCallbackCount).toBe(3);
    expect(records.map(record => record.presentedTime)).toEqual([0.1, 0.2, 0.3]);
  });

  it('names the files in order, at the video’s own size, and reports progress', async () => {
    const records: GrabRecord[] = [];
    stubGrabCanvas(records);
    const video = new FakeVideo({ width: 64, height: 48 });
    const progress: number[] = [];

    const result = await grabVideoFrames(asVideo(video), {
      times: [0, 0.5],
      namePrefix: 'clip',
      onProgress: grabbed => progress.push(grabbed),
    });

    expect(result.files.map(file => file.name)).toEqual(['clip_0001.png', 'clip_0002.png']);
    expect(result.files.every(file => file.type === 'image/png')).toBe(true);
    expect(records[0]).toMatchObject({ width: 64, height: 48 });
    expect(progress).toEqual([1, 2]);
  });

  it('skips a timestamp the decoder has no frame for rather than failing it', async () => {
    const records: GrabRecord[] = [];
    stubGrabCanvas(records);
    // Past 0.5s the fake reports a 0×0 frame — the tail of a video whose real end
    // sits inside the requested range.
    const video = new FakeVideo({ emptyFrom: 0.5 });

    const result = await grabVideoFrames(asVideo(video), { times: [0, 0.25, 0.5, 0.75] });

    expect(result.files).toHaveLength(2);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('counts an encode that hands back nothing as a failure', async () => {
    const records: GrabRecord[] = [];
    stubGrabCanvas(records, { failEncode: true });
    const video = new FakeVideo();

    const result = await grabVideoFrames(asVideo(video), { times: [0, 0.25] });

    expect(result.files).toHaveLength(0);
    expect(result.failed).toBe(2);
  });

  it('aborts the whole run when the file turns out to be unseekable', async () => {
    const records: GrabRecord[] = [];
    stubGrabCanvas(records);
    const video = new FakeVideo({ unseekable: true });

    await expect(
      grabVideoFrames(asVideo(video), { times: [0, 0.25, 0.5], seekTimeoutMs: 20 })
    ).rejects.toThrow(/could not be seeked/);
    // Not 300 timeouts in a row: the first refusal ends it.
    expect(records).toHaveLength(0);
  });
});

describe('loadVideoFile (§9.12.5)', () => {
  let created: FakeVideo[] = [];

  function stubVideoElement(options: FakeVideoOptions): void {
    created = [];
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string, elementOptions?) => {
      if (tagName !== 'video') {
        return realCreateElement(tagName, elementOptions as ElementCreationOptions | undefined);
      }
      const video = new FakeVideo(options);
      created.push(video);
      return video as unknown as HTMLElement;
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:video');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with the decoded size and duration once a first frame exists', async () => {
    stubVideoElement({ duration: 3.5, width: 320, height: 180 });

    const loaded = await loadVideoFile(new Blob(['video']));

    expect(loaded.duration).toBe(3.5);
    expect(loaded.width).toBe(320);
    expect(loaded.height).toBe(180);
    loaded.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video');
  });

  it('rejects a file the browser cannot decode, and revokes the URL anyway', async () => {
    stubVideoElement({ failToLoad: true });

    await expect(loadVideoFile(new Blob(['not a video']))).rejects.toThrow(/could not decode/);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video');
  });

  it('rejects a file with no video track', async () => {
    stubVideoElement({ noVideoTrack: true });

    await expect(loadVideoFile(new Blob(['audio only']))).rejects.toThrow(/no video track/);
  });

  it('rejects rather than hanging on a file that never decodes', async () => {
    created = [];
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string, elementOptions?) => {
      if (tagName !== 'video') {
        return realCreateElement(tagName, elementOptions as ElementCreationOptions | undefined);
      }
      // Silent: neither `loadeddata` nor `error` ever fires.
      return {
        preload: '',
        muted: false,
        playsInline: false,
        src: '',
        addEventListener: () => {},
        removeEventListener: () => {},
        removeAttribute: () => {},
        load: () => {},
      } as unknown as HTMLElement;
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:video');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await expect(loadVideoFile(new Blob(['truncated']), { timeoutMs: 20 })).rejects.toThrow(
      /Timed out/
    );
  });
});

describe('formatVideoTime', () => {
  it('reads as m:ss.s', () => {
    expect(formatVideoTime(0)).toBe('0:00.0');
    expect(formatVideoTime(9.25)).toBe('0:09.3');
    expect(formatVideoTime(72.5)).toBe('1:12.5');
    expect(formatVideoTime(Number.NaN)).toBe('0:00.0');
    // Rounding happens before the split, so a second that rounds up carries into
    // the minutes instead of reading as "0:60.0".
    expect(formatVideoTime(59.96)).toBe('1:00.0');
    expect(formatVideoTime(119.99)).toBe('2:00.0');
  });
});
