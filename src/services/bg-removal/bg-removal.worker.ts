// Web Worker that runs local background removal off the main thread, so neither the model
// download nor the inference freezes the editor and the heavy heap lives in the worker (not
// competing with the editor's memory — this is what avoids the main-thread OOM). Both engine
// libraries are dynamically imported so they split into their own chunks and only load when used.
//
//   • imgly    — @imgly/background-removal (ISNet, ONNX/WASM, WebGPU when available). Lighter and
//                production-proven; AGPL-3.0.
//   • birefnet — @huggingface/transformers + BiRefNet ONNX (MIT). Higher quality ceiling, heavier.

import type { BgRemovalRequest, BgRemovalResponse } from './types';

// Type the worker global locally rather than pulling in the "webworker" lib (which clashes with
// the project's "dom" lib on `self` / `postMessage`).
interface WorkerScope {
  postMessage(message: BgRemovalResponse): void;
  onmessage: ((ev: MessageEvent<BgRemovalRequest>) => void) | null;
  navigator: Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } };
}
const ctx = globalThis as unknown as WorkerScope;
const post = (msg: BgRemovalResponse): void => ctx.postMessage(msg);

// `navigator.gpu` merely being present is NOT enough: on some platforms (notably Qualcomm/Adreno
// on Windows-on-ARM) WebGPU is blocklisted and `requestAdapter()` returns null. Probe for a real
// adapter before choosing the GPU backend.
async function hasUsableWebGpu(): Promise<boolean> {
  const gpu = ctx.navigator?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') {
    return false;
  }
  try {
    const adapter = await gpu.requestAdapter();
    return adapter != null;
  } catch {
    return false;
  }
}

interface RawImageLike {
  toBlob(type: string): Promise<Blob>;
}
interface BiRefNetPipeline {
  (image: unknown): Promise<RawImageLike | RawImageLike[]>;
}

const BIREFNET_MODELS = {
  balanced: 'onnx-community/BiRefNet_lite-ONNX',
  max: 'onnx-community/BiRefNet-ONNX',
} as const;

// The onnx-community BiRefNet exports have a STATIC 1024×1024 input (Swin backbone), so the model
// can only run at 1024² — that OOMs the 32-bit WASM heap. It therefore needs WebGPU (GPU memory).
const BIREFNET_NEEDS_WEBGPU_MESSAGE =
  'BiRefNet needs a WebGPU-capable browser (Chrome/Edge). On this device, switch the ' +
  'background-removal engine to "imgly" in Editor Settings — it runs on the CPU.';

let birefnetCache: { modelId: string; pipe: BiRefNetPipeline } | null = null;

async function runImgly(req: BgRemovalRequest): Promise<Blob> {
  const { removeBackground } = await import('@imgly/background-removal');
  const progress = (key: string, current: number, total: number): void => {
    post({
      id: req.id,
      type: 'progress',
      // Asset fetches report under "fetch:*" keys. On the first run those are real downloads; on
      // later runs the same fetch is served from Cache Storage, so we label it "loading".
      phase: key.startsWith('fetch') ? (req.installed ? 'loading' : 'downloading') : 'running',
      progress: total > 0 ? current / total : null,
    });
  };
  const run = (device: 'cpu' | 'gpu'): Promise<Blob> =>
    removeBackground(req.blob, {
      ...(req.imglyPublicPath ? { publicPath: req.imglyPublicPath } : {}),
      device,
      model: 'isnet_fp16',
      output: { format: 'image/png' },
      progress,
    });

  const useGpu = await hasUsableWebGpu();
  try {
    return await run(useGpu ? 'gpu' : 'cpu');
  } catch (error) {
    // If the GPU path fails despite an adapter, fall back to CPU (which works everywhere).
    if (useGpu) {
      return run('cpu');
    }
    throw error;
  }
}

async function runBiRefNet(req: BgRemovalRequest): Promise<Blob> {
  const transformers = await import('@huggingface/transformers');
  if (req.birefnetModelHost) {
    transformers.env.remoteHost = req.birefnetModelHost;
  }
  // The model's static 1024² input can't fit the WASM heap — require a USABLE WebGPU adapter up
  // front rather than letting it OOM or fail on a blocklisted GPU. (We do NOT silently fall back to
  // imgly: the user picked BiRefNet for its MIT licence, and imgly is AGPL.)
  if (!(await hasUsableWebGpu())) {
    throw new Error(BIREFNET_NEEDS_WEBGPU_MESSAGE);
  }

  const modelId = BIREFNET_MODELS[req.quality];
  let pipe = birefnetCache?.modelId === modelId ? birefnetCache.pipe : null;
  if (!pipe) {
    const progressCallback = (info: unknown): void => {
      const record = typeof info === 'object' && info ? (info as Record<string, unknown>) : {};
      const status = typeof record.status === 'string' ? record.status : '';
      const progress = typeof record.progress === 'number' ? record.progress / 100 : null;
      post({
        id: req.id,
        type: 'progress',
        phase: status === 'progress' ? (req.installed ? 'loading' : 'downloading') : 'running',
        progress,
      });
    };
    try {
      pipe = (await transformers.pipeline('background-removal', modelId, {
        device: 'webgpu',
        dtype: 'fp16',
        progress_callback: progressCallback,
      })) as unknown as BiRefNetPipeline;
    } catch {
      // Some WebGPU adapters don't expose shader-f16 ("device does not support fp16") — retry fp32.
      pipe = (await transformers.pipeline('background-removal', modelId, {
        device: 'webgpu',
        dtype: 'fp32',
        progress_callback: progressCallback,
      })) as unknown as BiRefNetPipeline;
    }
    birefnetCache = { modelId, pipe };
  }

  const image = await transformers.RawImage.fromBlob(req.blob);
  post({ id: req.id, type: 'progress', phase: 'running', progress: null });
  const output = await pipe(image);
  const result = Array.isArray(output) ? output[0] : output;
  if (!result) {
    throw new Error('Background removal produced no output.');
  }
  return result.toBlob('image/png');
}

ctx.onmessage = (event: MessageEvent<BgRemovalRequest>) => {
  const req = event.data;
  const run = req.engine === 'imgly' ? runImgly(req) : runBiRefNet(req);
  run
    .then(blob => post({ id: req.id, type: 'done', blob }))
    .catch((error: unknown) => {
      post({
        id: req.id,
        type: 'error',
        message: error instanceof Error ? error.message : 'Background removal failed.',
      });
    });
};
