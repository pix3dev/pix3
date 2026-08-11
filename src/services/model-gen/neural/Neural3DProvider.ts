/**
 * The contract the neural (image→3D) lane of Model Lab drives.
 *
 * Extracted so the lane can run on more than one backend:
 * {@link import('./TripoModelProvider').TripoModelProvider} calls Tripo3D directly (through a dev
 * proxy, since Tripo sends no CORS headers), and
 * {@link import('./StropheModel3DProvider').StropheModel3DProvider} goes through Strophe's metered
 * API (no proxy needed). `NeuralModelGenService` picks one per the Model Lab preference and never
 * needs to know which is which.
 */

/** The source image for an image→3D job. */
export interface Neural3DInput {
  /** MIME type of the source image (e.g. `image/png`). */
  readonly mimeType: string;
  /** Base64 payload of the source image (no `data:` prefix). */
  readonly base64: string;
}

export interface Neural3DOptions {
  readonly signal?: AbortSignal;
  /** Progress callback; `stage` ∈ 'uploading' | 'queued' | 'running' | 'downloading'. */
  readonly onProgress?: (progress: number, stage: string) => void;
}

export interface Neural3DResult {
  /** The raw downloaded GLB bytes — saved losslessly, never re-exported. */
  readonly glb: Blob;
  /** Backend job id, for support/debugging. */
  readonly taskId: string;
}

export interface Neural3DProvider {
  /** Stable id used in preferences (`'tripo'` | `'strophe'`). */
  readonly id: string;
  /** Human label for the mode selector and key-status copy. */
  readonly label: string;
  hasKey(): Promise<boolean>;
  setKey(value: string): Promise<void>;
  clearKey(): Promise<void>;
  /** Full image→GLB flow. Emits progress; rejects with an AbortError on cancellation. */
  generateGlb(input: Neural3DInput, opts: Neural3DOptions): Promise<Neural3DResult>;
}

/** Ids of the neural 3D backends Model Lab can use. */
export type Neural3DProviderId = 'tripo' | 'strophe';

export const NEURAL_3D_PROVIDER_IDS: readonly Neural3DProviderId[] = ['tripo', 'strophe'];

export const isNeural3DProviderId = (value: unknown): value is Neural3DProviderId =>
  typeof value === 'string' && (NEURAL_3D_PROVIDER_IDS as readonly string[]).includes(value);
