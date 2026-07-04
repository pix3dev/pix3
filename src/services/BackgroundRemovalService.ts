import { injectable } from '@/fw/di';
import type {
  BgRemovalEngine,
  BgRemovalProgress,
  BgRemovalQuality,
  BgRemovalRequest,
  BgRemovalResponse,
} from './bg-removal/types';

export type { BgRemovalEngine, BgRemovalProgress, BgRemovalQuality } from './bg-removal/types';

// Cap input dimensions before processing: bounds memory and output size. Mirrors the proven Asset
// Lab "Magic Studio" pipeline (a large source is the difference between a clean run and an OOM).
const REMOVE_BG_MAX_INPUT = 2560;

const INSTALLED_KEY = (engine: BgRemovalEngine): string => `pix3.bgRemoval.installed:${engine}`;

export interface RemoveBackgroundOptions {
  engine?: BgRemovalEngine;
  quality?: BgRemovalQuality;
  /** Fill enclosed transparent holes in the result (default true). */
  fillHoles?: boolean;
  onProgress?: (progress: BgRemovalProgress) => void;
}

/**
 * Local (in-browser) background removal. Inference runs in a dedicated Web Worker — off the main
 * thread and in its own heap, which is what keeps the (heavy) model from OOMing the editor. Two
 * engines are supported: `imgly` (@imgly/background-removal, ISNet — light, reliable, AGPL) and
 * `birefnet` (transformers.js + BiRefNet — higher quality ceiling, heavier, MIT). Models are NOT
 * bundled; they download on first use and are cached by the browser.
 */
@injectable()
export class BackgroundRemovalService {
  private worker: Worker | null = null;
  private seq = 0;
  private imglyPublicPath: string | null = null;
  private birefnetModelHost: string | null = null;

  static isSupported(): boolean {
    return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
  }

  /** Self-host model/asset hosts (optional; defaults to each library's CDN / the HF hub). */
  configure(options: { imglyPublicPath?: string; birefnetModelHost?: string }): void {
    if (options.imglyPublicPath !== undefined) {
      this.imglyPublicPath = options.imglyPublicPath;
    }
    if (options.birefnetModelHost !== undefined) {
      this.birefnetModelHost = options.birefnetModelHost;
    }
  }

  async removeBackground(input: Blob, options?: RemoveBackgroundOptions): Promise<Blob> {
    const engine: BgRemovalEngine = options?.engine ?? 'imgly';
    const quality: BgRemovalQuality = options?.quality ?? 'balanced';
    const capped = await capImage(input, REMOVE_BG_MAX_INPUT);
    const worker = this.ensureWorker();
    const id = (this.seq += 1);

    const request: BgRemovalRequest = {
      id,
      engine,
      quality,
      blob: capped,
      installed: isInstalled(engine),
      fillHoles: options?.fillHoles ?? true,
      ...(engine === 'imgly' && this.imglyPublicPath
        ? { imglyPublicPath: this.imglyPublicPath }
        : {}),
      ...(engine === 'birefnet' && this.birefnetModelHost
        ? { birefnetModelHost: this.birefnetModelHost }
        : {}),
    };

    return new Promise<Blob>((resolve, reject) => {
      const cleanup = (): void => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      const onMessage = (event: MessageEvent<BgRemovalResponse>): void => {
        const msg = event.data;
        if (!msg || msg.id !== id) {
          return;
        }
        if (msg.type === 'progress') {
          options?.onProgress?.({ phase: msg.phase, progress: msg.progress });
          return;
        }
        cleanup();
        if (msg.type === 'done') {
          markInstalled(engine);
          resolve(msg.blob);
        } else {
          reject(new Error(friendlyError(msg.message, engine)));
        }
      };
      const onError = (event: ErrorEvent): void => {
        cleanup();
        reject(new Error(event.message || 'Background removal failed.'));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage(request);
    });
  }

  /** Terminate the worker (frees the in-memory model). Next run re-creates it and reloads cache. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./bg-removal/bg-removal.worker.ts', import.meta.url), {
        type: 'module',
      });
    }
    return this.worker;
  }
}

/** Decode `blob` and, if larger than `max` on either edge, redraw it downscaled to a PNG blob. */
async function capImage(blob: Blob, max: number): Promise<Blob> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return blob;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }
  const { width, height } = bitmap;
  if (width <= max && height <= max) {
    bitmap.close();
    return blob;
  }
  const scale = Math.min(max / width, max / height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return blob;
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise<Blob>(resolve => {
    canvas.toBlob(result => resolve(result ?? blob), 'image/png');
  });
}

const isInstalled = (engine: BgRemovalEngine): boolean => {
  try {
    return localStorage.getItem(INSTALLED_KEY(engine)) === '1';
  } catch {
    return false;
  }
};

const markInstalled = (engine: BgRemovalEngine): void => {
  try {
    localStorage.setItem(INSTALLED_KEY(engine), '1');
  } catch {
    // ignore
  }
};

const isOutOfMemory = (message: string): boolean =>
  /bad_alloc|out of memory|oom|ERROR_CODE:\s*6/i.test(message);

const friendlyError = (message: string, engine: BgRemovalEngine): string => {
  if (isOutOfMemory(message)) {
    return engine === 'birefnet'
      ? 'Ran out of memory running BiRefNet. Switch to the "imgly" engine in Editor Settings, ' +
          'use the "Balanced" quality, or try a smaller image / a WebGPU browser.'
      : 'Ran out of memory. Try a smaller image or a browser with WebGPU (Chrome/Edge).';
  }
  return message;
};
