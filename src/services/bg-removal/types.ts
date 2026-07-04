/** Which local background-removal engine to run. */
export type BgRemovalEngine = 'imgly' | 'birefnet';

/** BiRefNet model tier (imgly ignores this). */
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
  /** Optional self-host base for imgly assets. */
  imglyPublicPath?: string;
  /** Optional self-host host for BiRefNet (transformers.js env.remoteHost). */
  birefnetModelHost?: string;
}

export type BgRemovalResponse =
  | { id: number; type: 'progress'; phase: BgRemovalProgress['phase']; progress: number | null }
  | { id: number; type: 'done'; blob: Blob }
  | { id: number; type: 'error'; message: string };
