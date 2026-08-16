// U²-Net background removal on onnxruntime-web — the commercial-safe CPU engine.
//
// WHY THIS EXISTS. It replaced @imgly/background-removal, which was AGPL-3.0: shipping it would
// have obliged us to disclose the source of the combined work, and — unlike the Spine runtime,
// whose licence explicitly offers a "each user brings their own licence" path — AGPL offers no way
// to buy that obligation off short of a commercial licence from IMG.LY. The remaining alternative,
// birefnet, has MIT weights but a static 1024² input that OOMs the 32-bit WASM heap, so it
// hard-requires WebGPU — and WebGPU is blocklisted on Qualcomm Adreno (Windows-on-ARM / Snapdragon
// X), which is precisely where a CPU fallback is needed.
//
// U²-Net closes both: Apache-2.0 for BOTH code and weights (verified against the upstream
// xuebinqin/U-2-Net LICENSE, not a copied model-card field), and it is a small CNN at 320² that
// runs comfortably on the CPU. Note that IS-Net / DIS — the model that was *inside* imgly — is NOT
// a substitute despite the Apache-2.0 code: upstream publishes its checkpoints with no licence at
// all, and DIS5K carries separate terms. Silence is not a grant.
//
// onnxruntime-web is MIT, and is declared as a direct dependency rather than borrowed: the copy
// that used to be hoisted at the root belonged to imgly, so it left with it. We import the `/wasm`
// subpath — the WASM-only build, without the WebGPU and WebGL backends we never register here.

import type { InferenceSession, Tensor } from 'onnxruntime-web/wasm';
// ORT resolves its `.wasm` binary at runtime, and its default guess is relative to the document —
// which on a dev server silently returns index.html and dies with "expected magic word". Hand it a
// real URL that the bundler owns instead. The package exports the binary as its own subpath, so
// Vite hashes and serves it like any other asset; no postinstall copy into public/ needed.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

/** U²-Net's fixed input resolution (both tiers). */
const INPUT_SIZE = 320;
/** ImageNet normalisation, matching the reference rembg pre-processing. */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * Prototype defaults: ONNX exports of the Apache-2.0 U²-Net checkpoints, served from the Hugging
 * Face hub. Note that the canonical rembg release assets on GitHub are NOT usable here — release
 * downloads send no `Access-Control-Allow-Origin`, so fetching one from a page fails CORS. The HF
 * hub sends `*`, which is why the default points there.
 *
 * BEFORE SHIPPING these should be re-exported from the upstream weights and self-hosted, for three
 * reasons: provenance we can document in THIRD-PARTY-NOTICES (this mirror is a third party's), no
 * runtime dependency on a host we do not control, and a uint8 quantisation pass that takes the full
 * tier from ~176 MB down to ~45 MB. Both are overridable via `BackgroundRemovalService.configure()`.
 */
export const U2NET_MODEL_URLS = {
  /** u2netp — 4.6 MB, the same architecture at reduced width. Fast, softer edges. */
  balanced: 'https://huggingface.co/tomjackson2023/rembg/resolve/main/u2netp.onnx',
  /** u2net — ~176 MB, full width. Noticeably cleaner mattes. */
  max: 'https://huggingface.co/tomjackson2023/rembg/resolve/main/u2net.onnx',
} as const;

export type U2NetTier = keyof typeof U2NET_MODEL_URLS;

export interface U2NetRunOptions {
  blob: Blob;
  tier: U2NetTier;
  /** Overrides `U2NET_MODEL_URLS[tier]`. */
  modelUrl?: string;
  /** Base URL for the ORT `.wasm` binaries (defaults to onnxruntime-web's own resolution). */
  wasmPath?: string;
  onProgress: (phase: 'downloading' | 'loading' | 'running', progress: number | null) => void;
}

interface CachedSession {
  key: string;
  session: InferenceSession;
}
let cached: CachedSession | null = null;

/** Fetch with byte-level progress, so the first (large) model download reports a real percentage. */
async function fetchModel(
  url: string,
  onProgress: (fraction: number | null) => void
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the U²-Net model (HTTP ${response.status}).`);
  }
  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : 0;
  if (!response.body || !Number.isFinite(total) || total <= 0) {
    onProgress(null);
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.buffer;
}

async function ensureSession(options: U2NetRunOptions): Promise<InferenceSession> {
  const url = options.modelUrl ?? U2NET_MODEL_URLS[options.tier];
  if (cached?.key === url) {
    return cached.session;
  }

  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmPaths = options.wasmPath ?? { wasm: new URL(ortWasmUrl, self.location.href) };
  // Multi-threaded WASM needs cross-origin isolation (COOP/COEP), which the editor does not set.
  // Asking for threads without it makes ORT fail at init rather than degrade, so pin to 1 unless
  // the document really is isolated. SIMD stays on and carries most of the win.
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? 4 : 1;

  const buffer = await fetchModel(url, fraction => options.onProgress('downloading', fraction));
  options.onProgress('loading', null);
  const session = await ort.InferenceSession.create(buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  cached = { key: url, session };
  return session;
}

/** Draw `bitmap` into a 320² NCHW float tensor using the reference normalisation. */
function buildInputTensor(bitmap: ImageBitmap): Float32Array {
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create a 2D context for U²-Net pre-processing.');
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);

  // The reference implementation scales by the image's own maximum channel value rather than a
  // fixed 255 — on dark sources the two differ enough to shift the matte, so mirror it exactly.
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > max) max = data[i];
    if (data[i + 1] > max) max = data[i + 1];
    if (data[i + 2] > max) max = data[i + 2];
  }
  if (max === 0) {
    max = 1;
  }

  const plane = INPUT_SIZE * INPUT_SIZE;
  const out = new Float32Array(plane * 3);
  for (let p = 0; p < plane; p++) {
    const o = p * 4;
    out[p] = (data[o] / max - MEAN[0]) / STD[0];
    out[plane + p] = (data[o + 1] / max - MEAN[1]) / STD[1];
    out[plane * 2 + p] = (data[o + 2] / max - MEAN[2]) / STD[2];
  }
  return out;
}

/** Min-max normalise the raw d0 output into 0..255 alpha bytes. */
function maskToBytes(pred: Float32Array): Uint8ClampedArray {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pred.length; i++) {
    if (pred[i] < min) min = pred[i];
    if (pred[i] > max) max = pred[i];
  }
  const range = max - min || 1;
  const bytes = new Uint8ClampedArray(pred.length);
  for (let i = 0; i < pred.length; i++) {
    bytes[i] = ((pred[i] - min) / range) * 255;
  }
  return bytes;
}

/** Upscale the 320² mask to `width`×`height` and apply it as the alpha of the original image. */
function composite(
  bitmap: ImageBitmap,
  maskBytes: Uint8ClampedArray,
  width: number,
  height: number
): Promise<Blob> {
  const maskCanvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const maskCtx = maskCanvas.getContext('2d');
  const outCanvas = new OffscreenCanvas(width, height);
  const outCtx = outCanvas.getContext('2d');
  if (!maskCtx || !outCtx) {
    throw new Error('Could not create a 2D context for U²-Net compositing.');
  }

  // Expand the single-channel mask into an RGBA greyscale image so the canvas can rescale it with
  // smoothing (a manual bilinear pass here would be slower and no better).
  const maskImage = maskCtx.createImageData(INPUT_SIZE, INPUT_SIZE);
  for (let p = 0; p < maskBytes.length; p++) {
    const o = p * 4;
    maskImage.data[o] = maskBytes[p];
    maskImage.data[o + 1] = maskBytes[p];
    maskImage.data[o + 2] = maskBytes[p];
    maskImage.data[o + 3] = 255;
  }
  maskCtx.putImageData(maskImage, 0, 0);

  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';
  outCtx.drawImage(maskCanvas, 0, 0, width, height);
  const scaledMask = outCtx.getImageData(0, 0, width, height).data;

  outCtx.clearRect(0, 0, width, height);
  outCtx.drawImage(bitmap, 0, 0, width, height);
  const rgba = outCtx.getImageData(0, 0, width, height);
  for (let p = 0; p < width * height; p++) {
    rgba.data[p * 4 + 3] = scaledMask[p * 4];
  }
  outCtx.putImageData(rgba, 0, 0);
  return outCanvas.convertToBlob({ type: 'image/png' });
}

export async function runU2Net(options: U2NetRunOptions): Promise<Blob> {
  const session = await ensureSession(options);
  const ort = await import('onnxruntime-web/wasm');

  const bitmap = await createImageBitmap(options.blob);
  try {
    options.onProgress('running', null);
    const input = new ort.Tensor('float32', buildInputTensor(bitmap), [
      1,
      3,
      INPUT_SIZE,
      INPUT_SIZE,
    ]);
    const inputName = session.inputNames[0];
    const outputs = await session.run({ [inputName]: input });
    // U²-Net emits seven side outputs (d0..d6); d0 is the fused prediction the reference uses.
    const d0 = outputs[session.outputNames[0]] as Tensor;
    const pred = d0.data as Float32Array;
    return await composite(bitmap, maskToBytes(pred), bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
