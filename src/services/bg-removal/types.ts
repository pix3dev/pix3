/** Which local background-removal engine to run. */
export type BgRemovalEngine = 'u2net' | 'birefnet';

/** Model tier — both engines ship a light and a full variant. */
export type BgRemovalQuality = 'balanced' | 'max';

export interface BgRemovalProgress {
  /** 'downloading' (first run) | 'loading' (from cache) | 'running'. */
  phase: 'downloading' | 'loading' | 'running';
  /** 0..1 while a file downloads, else null. */
  progress: number | null;
}

/** Main-thread → worker job. `blob` is already downscaled to the input cap. */
export interface BgRemovalRequest {
  id: number;
  engine: BgRemovalEngine;
  quality: BgRemovalQuality;
  blob: Blob;
  /** True once this engine's model was fetched before (label "loading" vs "downloading"). */
  installed: boolean;
  /**
   * Fill enclosed transparent "holes" in the cutout — transparent pixels fully surrounded by the
   * object become opaque again. Fixes lighter models (ISNet) making a framed object's interior
   * see-through, while leaving the outer background and soft edges untouched.
   */
  fillHoles: boolean;
  /** Optional self-host host for BiRefNet (transformers.js env.remoteHost). */
  birefnetModelHost?: string;
  /** Optional self-host URL for the U²-Net ONNX file (overrides the tier default). */
  u2netModelUrl?: string;
  /** Optional self-host base for the onnxruntime-web `.wasm` binaries. */
  u2netWasmPath?: string;
}

export type BgRemovalResponse =
  | { id: number; type: 'progress'; phase: BgRemovalProgress['phase']; progress: number | null }
  | { id: number; type: 'done'; blob: Blob }
  | { id: number; type: 'error'; message: string };
