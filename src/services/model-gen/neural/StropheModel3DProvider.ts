import { inject, injectable } from '@/fw/di';
import { base64ToBlob } from '@/services/image-gen/image-ops';
import { StropheAccountService } from '@/services/strophe/StropheAccountService';
import type { StropheFamilySummary } from '@/services/strophe/StropheTypes';
import type {
  Neural3DInput,
  Neural3DOptions,
  Neural3DProvider,
  Neural3DResult,
} from './Neural3DProvider';

/** Default image→3D family. Tripo3D v2.5 via Strophe: 45 credits, ~80 s, the balanced middle. */
export const STROPHE_DEFAULT_3D_FAMILY = 'tripo';

/**
 * Image→3D through Strophe's metered API — the second backend of Model Lab's neural lane, alongside
 * {@link import('./TripoModelProvider').TripoModelProvider}.
 *
 * Why this exists even though Strophe resells the same Tripo model: it removes the two proxies the
 * direct integration needs. Tripo's own API sends no CORS headers and its result URLs are presigned
 * links on a third-party CDN, so calling it from the browser needs `/tripo-proxy` for the API *and*
 * `/tripo-download` for the file — both dev-only. Strophe sends `Access-Control-Allow-Origin: *` on
 * both, so this lane works in a production static build with no server at all, and the user pays with
 * Strophe credits instead of holding a second vendor key.
 *
 * The whole flow is `POST /files` → `POST /generations` → poll → download, which
 * {@link import('@/services/strophe/StropheApiClient').StropheApiClient} already encapsulates; the
 * only 3D-specific knob is `enablePbr`.
 */
@injectable()
export class StropheModel3DProvider implements Neural3DProvider {
  readonly id = 'strophe';
  readonly label = 'Strophe';

  @inject(StropheAccountService)
  private readonly account!: StropheAccountService;

  /** Family id to generate with. Defaults to {@link STROPHE_DEFAULT_3D_FAMILY}. */
  private familyId: string = STROPHE_DEFAULT_3D_FAMILY;

  hasKey(): Promise<boolean> {
    return this.account.hasKey();
  }

  setKey(value: string): Promise<void> {
    return this.account.setKey(value);
  }

  clearKey(): Promise<void> {
    return this.account.clearKey();
  }

  /** Choose which 3D family to use (see {@link listFamilies}). Unknown ids fail at request time. */
  setFamilyId(familyId: string): void {
    this.familyId = familyId.trim() || STROPHE_DEFAULT_3D_FAMILY;
  }

  getFamilyId(): string {
    return this.familyId;
  }

  /** The available image→3D families, for a picker. Cached by the account service. */
  listFamilies(opts: { refresh?: boolean } = {}): Promise<StropheFamilySummary[]> {
    return this.account.listFamilies('3d', opts);
  }

  /**
   * Full image→GLB flow. Uploads the source image, runs the generation to completion, and downloads
   * the raw GLB bytes.
   *
   * Progress is interpolated from the family's advertised `generationTime` — Strophe reports no
   * numeric progress (filed in `.plans/strophe-integration-feedback.md`), and a 3D job runs long
   * enough that an empty progress bar would read as a hang.
   */
  async generateGlb(input: Neural3DInput, opts: Neural3DOptions): Promise<Neural3DResult> {
    if (!(await this.hasKey())) {
      throw new Error('No Strophe API key is configured.');
    }
    const { signal, onProgress } = opts;
    const client = this.account.getClient();

    onProgress?.(0, 'uploading');
    const file = await client.uploadFile(
      { blob: base64ToBlob(input.base64, input.mimeType) },
      signal
    );

    const family = await this.account.getFamily(this.familyId).catch(() => null);
    const etaSeconds = family?.generationTime;
    const supportsPbr = (family?.parameters ?? []).some(
      parameter => parameter.name === 'enablePbr'
    );

    onProgress?.(0, 'queued');
    const generation = await client.runGeneration(
      {
        familyId: this.familyId,
        imageIds: [file.fileId],
        ...(supportsPbr ? { parameters: { enablePbr: true } } : {}),
      },
      {
        signal,
        etaSeconds,
        onProgress: (progress, state) => onProgress?.(progress, stageForState(state)),
      }
    );

    if (!generation.result) {
      throw new Error('Strophe reported a finished 3D generation but returned no file.');
    }

    onProgress?.(100, 'downloading');
    const blob = await client.downloadResult(generation.result, signal);
    // The delivery URL carries the right MIME, but normalize so downstream GLB parsing/saving is
    // unambiguous regardless of what the CDN labelled it.
    const glb =
      blob.type === 'model/gltf-binary' ? blob : new Blob([blob], { type: 'model/gltf-binary' });
    return { glb, taskId: generation.generationId };
  }
}

/** Map a Strophe generation state onto the lane's coarse `stage` vocabulary. */
function stageForState(state: string): string {
  return state === 'queued' ? 'queued' : 'running';
}
