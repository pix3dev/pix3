/**
 * The generated kit's on-disk format (`<package>/kit/kit.json` + `files/`), shared by the generator
 * (`generate.ts`, loaded only when the kit is (re)built) and `pix3 kit` / `pix3 new`, which only
 * read it.
 */

export interface CoreComponentProperty {
  readonly name: string;
  readonly type: string;
  readonly default?: string;
  readonly notes?: string;
}

export interface CoreComponentInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly properties: readonly CoreComponentProperty[];
}

export interface GenerateKitOptions {
  /** The pix3 repo root (include paths are relative to it). */
  readonly repoRoot: string;
  /** The templates (`packages/pix3-cli/kit-src`). */
  readonly kitSrcDir: string;
  readonly outDir: string;
  readonly version: string;
  readonly coreComponents: readonly CoreComponentInfo[];
  readonly mcpTools: readonly { readonly name: string; readonly summary: string }[];
  readonly mcpErrorCodes: readonly string[];
  /** Written into kit.json; the caller's staleness stamp. */
  readonly inputsStamp?: string;
}

export interface KitManifestFile {
  readonly format: number;
  readonly version: string;
  readonly inputsStamp: string | null;
  /** Project paths of every kit file, sorted. */
  readonly files: readonly string[];
  /** Repo paths every `{{include}}` read (for staleness and for SOURCES-style audits). */
  readonly sources: readonly string[];
}

export const KIT_FORMAT = 1;
export const KIT_MANIFEST = 'kit.json';
export const KIT_FILES_DIR = 'files';
