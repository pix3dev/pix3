/**
 * Ingest of operating-system content (drag & drop or the file picker) into curated Asset Store
 * bundles, plus the upload itself.
 *
 * Three things about this file are load-bearing and easy to break:
 *
 * 1. **{@link StoreUploadService.captureEntries} must stay synchronous.** `DataTransferItem`s are
 *    only alive while the `drop` handler is still on the stack — after the first `await` the list
 *    is emptied and `webkitGetAsEntry()` returns null. So the drop handler captures lazy
 *    {@link IngestEntry} wrappers immediately; the directory walk and the file reads happen later,
 *    in {@link StoreUploadService.buildPlan}.
 * 2. **`FileSystemDirectoryEntry.createReader().readEntries()` yields at most ~100 entries per
 *    call.** It has to be called in a loop until it answers with an empty batch, or large folders
 *    silently lose their tail.
 * 3. **The upload goes through `XMLHttpRequest`, not `fetch`.** This is the one place that departs
 *    from the `ApiClient` (fetch) pattern, and deliberately so: `fetch` exposes no upload progress
 *    and no way to abort mid-body in a way we can report per bundle, while a multi-hundred-megabyte
 *    bundle needs both a progress bar and a working Cancel. The wire format is byte-identical to
 *    {@link ApiClient.uploadStoreItem} (`manifest` + `paths` + `files`, `credentials: 'include'`),
 *    so the server sees the same request either way.
 *
 * Grouping rules (plan §5): a top-level folder is one bundle, a lone file is a one-file bundle, and
 * a `.zip` is treated as a folder. An `item.json` inside a bundle is honoured *including its id*,
 * which makes re-uploading the same folder an idempotent update rather than a duplicate item.
 */

import { inject, injectable } from '@/fw/di';
import * as ApiClient from '@/services/cloud/ApiClient';
import { AssetLibraryService } from '@/services/library/AssetLibraryService';
import { normalizeBundlePath } from '@/services/library/library-path-remap';
import { inferItemTypeFromPath, type LibraryItemManifest } from '@/services/library/library-types';
import type { StoreValidationIssue } from '@/services/library/store-validation';

/** Per-file cap enforced by the server's multer config (`store-router.ts`). */
export const STORE_MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Per-bundle file cap enforced by the same multer config. */
export const STORE_MAX_FILES_PER_BUNDLE = 200;

/** Bundle-relative name of the optional authored manifest. */
const MANIFEST_FILE = 'item.json';

/** Archive junk that must never end up in a published bundle. */
const JUNK_BASENAMES = new Set(['.ds_store', 'thumbs.db']);
const JUNK_DIRECTORIES = new Set(['__macosx']);

const IMAGE_PATTERN = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;
const SCENE_PATTERN = /\.(pix3scene|pix3prefab)$/i;
const CODE_PATTERN = /\.(ts|js|mjs)$/i;

/**
 * A lazily-read node of dropped content. Deliberately not the DOM's `FileSystemEntry`: the
 * traversal is then testable with plain object trees (happy-dom has no `webkitGetAsEntry`).
 */
export interface IngestEntry {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  /** Present for files. */
  file?(): Promise<File>;
  /** Present for directories. */
  children?(): Promise<IngestEntry[]>;
}

/** One prospective store item, fully materialized in memory and ready to upload (or blocked). */
export interface StagedBundle {
  /** Same value as `manifest.id`; kept separate so progress can be keyed without reaching in. */
  readonly id: string;
  manifest: LibraryItemManifest;
  readonly files: Map<string, Blob>;
  /** What the user dropped (folder / file / archive name), for the staging list. */
  readonly sourceLabel: string;
  /** True ⇒ the bundle violates a server limit (or has nothing to send) and is NOT uploaded. */
  readonly oversize: boolean;
  /** Human-readable notes: limit violations, discarded paths, unreadable files. */
  readonly issues: string[];
}

export interface StoreIngestPlan {
  readonly bundles: StagedBundle[];
  /** Drop-level problems (an entry that could not be read at all). */
  readonly issues: string[];
}

export interface UploadOptions {
  onProgress?(bundleId: string, loaded: number, total: number): void;
  signal?: AbortSignal;
}

/** Per-bundle result. A partial success (3 of 5) is a normal outcome, not an error. */
export type UploadOutcome =
  | { readonly bundleId: string; readonly status: 'ok' }
  | {
      readonly bundleId: string;
      readonly status: 'error';
      readonly message: string;
      /** The server's publish checklist, when it answered 400 with one. */
      readonly issues?: StoreValidationIssue[];
    }
  | { readonly bundleId: string; readonly status: 'cancelled' };

/** Rejection carrying the store's response detail so the dialog can render a field checklist. */
export class StoreUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: StoreValidationIssue[]
  ) {
    super(message);
    this.name = 'StoreUploadError';
  }
}

class UploadAbortedError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadAbortedError';
  }
}

/** Total byte size of a staged bundle (the staging list shows it; the limit check uses it). */
export function bundleByteSize(bundle: StagedBundle): number {
  let total = 0;
  for (const blob of bundle.files.values()) {
    total += blob.size;
  }
  return total;
}

@injectable()
export class StoreUploadService {
  @inject(AssetLibraryService) private readonly library!: AssetLibraryService;

  /**
   * Snapshot a drop's contents. MUST be called synchronously from the `drop` handler — see the
   * file header. Falls back to the flat `DataTransfer.files` list when the entry API is missing
   * (non-Chromium, or a synthetic event), which still supports the lone-file case.
   */
  captureEntries(dataTransfer: DataTransfer): IngestEntry[] {
    const entries: IngestEntry[] = [];
    const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    for (const item of items) {
      if (item.kind !== 'file') {
        continue;
      }
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      if (entry) {
        entries.push(fromFileSystemEntry(entry));
        continue;
      }
      const file = item.getAsFile();
      if (file) {
        entries.push(entryForFile(file.name, file));
      }
    }
    if (entries.length > 0) {
      return entries;
    }
    return this.entriesFromFileList(dataTransfer.files);
  }

  /**
   * Rebuild an entry tree from a `<input type="file">` selection. With `webkitdirectory` each file
   * carries a `webkitRelativePath` (`pack/ui/button.png`), so the flat list is re-nested here — the
   * picker then produces exactly the same plan a folder drop would.
   */
  entriesFromFileList(files: FileList | readonly File[] | null | undefined): IngestEntry[] {
    const root = new Map<string, TreeNode>();
    for (const file of Array.from(files ?? [])) {
      const relative = normalizeBundlePath(relativePathOf(file) || file.name);
      const segments = relative.split('/').filter(segment => segment && segment !== '.');
      if (segments.length === 0 || segments.includes('..')) {
        continue;
      }
      let cursor = root;
      for (const segment of segments.slice(0, -1)) {
        const existing = cursor.get(segment);
        if (existing && 'dir' in existing) {
          cursor = existing.dir;
        } else {
          const dir = new Map<string, TreeNode>();
          cursor.set(segment, { dir });
          cursor = dir;
        }
      }
      cursor.set(segments[segments.length - 1]!, { file });
    }
    return toIngestEntries(root);
  }

  /**
   * Read every entry and turn it into staged bundles. Limits are checked here (not at upload time)
   * so the dialog can show the offender in red before anything leaves the machine; the remaining
   * bundles from the same drop stay uploadable.
   */
  async buildPlan(entries: readonly IngestEntry[]): Promise<StoreIngestPlan> {
    const bundles: StagedBundle[] = [];
    const issues: string[] = [];
    for (const entry of entries) {
      try {
        const bundle = await this.stageEntry(entry);
        if (bundle) {
          bundles.push(bundle);
        } else {
          issues.push(`"${entry.name}" holds no usable files — skipped.`);
        }
      } catch (error) {
        issues.push(`"${entry.name}" could not be read: ${messageOf(error)}`);
      }
    }
    return { bundles, issues };
  }

  /**
   * Upload bundles one after another (the server writes a whole bundle per request, and serial
   * uploads keep the progress bar meaningful). Blocked bundles are reported as errors without a
   * request; an abort stops the queue and marks the rest cancelled.
   */
  async upload(
    bundles: readonly StagedBundle[],
    opts: UploadOptions = {}
  ): Promise<UploadOutcome[]> {
    const outcomes: UploadOutcome[] = [];
    let cancelled = false;
    for (const bundle of bundles) {
      if (cancelled || opts.signal?.aborted) {
        outcomes.push({ bundleId: bundle.id, status: 'cancelled' });
        continue;
      }
      if (bundle.oversize) {
        outcomes.push({
          bundleId: bundle.id,
          status: 'error',
          message: bundle.issues.join(' ') || 'The bundle exceeds the store limits.',
        });
        continue;
      }
      try {
        await this.uploadBundle(bundle, opts);
        outcomes.push({ bundleId: bundle.id, status: 'ok' });
        // Surface the new item immediately; a failed refresh is cosmetic, never a failed upload.
        try {
          await this.library.refreshStore();
        } catch {
          // The next panel focus re-pulls the catalog anyway.
        }
      } catch (error) {
        if (error instanceof UploadAbortedError) {
          cancelled = true;
          outcomes.push({ bundleId: bundle.id, status: 'cancelled' });
          continue;
        }
        outcomes.push({
          bundleId: bundle.id,
          status: 'error',
          message: messageOf(error),
          issues: error instanceof StoreUploadError ? error.issues : undefined,
        });
      }
    }
    return outcomes;
  }

  // -- internals ---------------------------------------------------------------

  private async stageEntry(entry: IngestEntry): Promise<StagedBundle | null> {
    const files = new Map<string, Blob>();
    const dropped: string[] = [];
    let label: string;

    if (entry.kind === 'directory') {
      label = entry.name;
      await collectDirectory(entry, '', files, dropped);
    } else {
      const file = await entry.file?.();
      if (!file) {
        return null;
      }
      if (/\.zip$/i.test(entry.name)) {
        label = entry.name;
        await collectZip(file, files, dropped);
      } else {
        label = entry.name;
        addFile(files, dropped, entry.name, file);
      }
    }

    if (files.size === 0) {
      return null;
    }
    return this.stageBundle(label, files, dropped);
  }

  private async stageBundle(
    label: string,
    files: Map<string, Blob>,
    dropped: readonly string[]
  ): Promise<StagedBundle> {
    // `item.json` is the manifest, not bundle content — it travels as the multipart `manifest`
    // field, so it is lifted out of the file map here.
    const declared = await readDeclaredManifest(files);
    const paths = [...files.keys()].sort();
    const manifest = declared
      ? completeManifest(declared, paths, label)
      : synthesizeManifest(paths, label);

    const issues: string[] = [];
    if (dropped.length > 0) {
      issues.push(
        `${dropped.length} unsafe or empty path${dropped.length === 1 ? '' : 's'} discarded (${dropped
          .slice(0, 3)
          .join(', ')}${dropped.length > 3 ? '…' : ''}).`
      );
    }

    let blocked = paths.length === 0;
    if (paths.length === 0) {
      issues.push('Nothing left to upload after filtering.');
    }
    if (paths.length > STORE_MAX_FILES_PER_BUNDLE) {
      blocked = true;
      issues.push(
        `${paths.length} files — the store accepts at most ${STORE_MAX_FILES_PER_BUNDLE} per item.`
      );
    }
    const tooBig = paths.filter(path => (files.get(path)?.size ?? 0) > STORE_MAX_FILE_BYTES);
    if (tooBig.length > 0) {
      blocked = true;
      issues.push(
        `${tooBig.length} file${tooBig.length === 1 ? '' : 's'} over ${formatBytes(
          STORE_MAX_FILE_BYTES
        )} (${tooBig.slice(0, 3).join(', ')}${tooBig.length > 3 ? '…' : ''}).`
      );
    }

    return { id: manifest.id, manifest, files, sourceLabel: label, oversize: blocked, issues };
  }

  private uploadBundle(bundle: StagedBundle, opts: UploadOptions): Promise<void> {
    const paths = [...bundle.files.keys()];
    const totalBytes = bundleByteSize(bundle);
    const manifest: LibraryItemManifest = {
      ...bundle.manifest,
      files: paths,
      updatedAt: Date.now(),
    };

    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append('paths', JSON.stringify(paths));
    for (const path of paths) {
      form.append('files', bundle.files.get(path)!, path.split('/').pop() ?? 'file');
    }

    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const signal = opts.signal;
      const onAbortRequested = () => xhr.abort();
      const cleanup = () => signal?.removeEventListener('abort', onAbortRequested);

      xhr.open('POST', ApiClient.storeItemUrl(bundle.manifest.id));
      // The store cookie is the admin's session — same as `credentials: 'include'` on fetch.
      xhr.withCredentials = true;
      xhr.upload.addEventListener('progress', event => {
        opts.onProgress?.(
          bundle.id,
          event.loaded,
          event.lengthComputable ? event.total : totalBytes
        );
      });
      xhr.addEventListener('abort', () => {
        cleanup();
        reject(new UploadAbortedError());
      });
      xhr.addEventListener('error', () => {
        cleanup();
        reject(new Error('The store server could not be reached.'));
      });
      xhr.addEventListener('load', () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          opts.onProgress?.(bundle.id, totalBytes, totalBytes);
          resolve();
          return;
        }
        reject(readErrorResponse(xhr));
      });

      signal?.addEventListener('abort', onAbortRequested);
      if (signal?.aborted) {
        // Aborted between the queue check and here — never open a connection we already lost.
        cleanup();
        reject(new UploadAbortedError());
        return;
      }
      xhr.send(form);
    });
  }
}

// -- DataTransfer / FileList adapters ------------------------------------------

type TreeNode = { file: File } | { dir: Map<string, TreeNode> };

function toIngestEntries(nodes: Map<string, TreeNode>): IngestEntry[] {
  return [...nodes.entries()].map(([name, node]) =>
    'file' in node
      ? entryForFile(name, node.file)
      : { kind: 'directory' as const, name, children: async () => toIngestEntries(node.dir) }
  );
}

function entryForFile(name: string, file: File): IngestEntry {
  return { kind: 'file', name, file: async () => file };
}

function relativePathOf(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
}

function fromFileSystemEntry(entry: FileSystemEntry): IngestEntry {
  if (entry.isDirectory) {
    const directory = entry as FileSystemDirectoryEntry;
    return {
      kind: 'directory',
      name: entry.name,
      children: async () => (await readAllEntries(directory)).map(fromFileSystemEntry),
    };
  }
  const fileEntry = entry as FileSystemFileEntry;
  return {
    kind: 'file',
    name: entry.name,
    file: () => new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject)),
  };
}

/** `readEntries` answers with ≤100 entries per call — loop until it returns an empty batch. */
function readAllEntries(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const readBatch = () => {
      reader.readEntries(batch => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

// -- Collection ----------------------------------------------------------------

async function collectDirectory(
  entry: IngestEntry,
  prefix: string,
  out: Map<string, Blob>,
  dropped: string[]
): Promise<void> {
  const children = (await entry.children?.()) ?? [];
  for (const child of children) {
    const path = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.kind === 'directory') {
      await collectDirectory(child, path, out, dropped);
      continue;
    }
    const file = await child.file?.();
    if (file) {
      addFile(out, dropped, path, file);
    }
  }
}

/** A `.zip` is ingested as if it were the folder it contains (a single wrapping root is stripped). */
async function collectZip(archive: Blob, out: Map<string, Blob>, dropped: string[]): Promise<void> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(archive);
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  const root = commonRootFolder(entries.map(entry => entry.name));
  for (const entry of entries) {
    const path = root ? entry.name.slice(root.length + 1) : entry.name;
    addFile(out, dropped, path, await entry.async('blob'));
  }
}

/** `pack/a.png` + `pack/b.png` ⇒ `pack`; mixed or flat contents ⇒ null (nothing to strip). */
function commonRootFolder(paths: readonly string[]): string | null {
  const first = paths[0]?.split('/')[0];
  if (!first) {
    return null;
  }
  return paths.every(path => path.startsWith(`${first}/`)) ? first : null;
}

function addFile(out: Map<string, Blob>, dropped: string[], rawPath: string, blob: Blob): void {
  const path = safeBundlePath(rawPath);
  if (!path) {
    dropped.push(rawPath || '(empty)');
    return;
  }
  if (isJunkPath(path)) {
    return;
  }
  out.set(path, blob);
}

/**
 * Bundle paths are relative, forward-slashed and free of `.`/`..` segments. The server rejects the
 * rest anyway (`resolveSafePath` in `library-storage.ts`) — dropping them here keeps one bad file
 * from failing the whole bundle.
 */
function safeBundlePath(raw: string): string | null {
  const normalized = normalizeBundlePath(raw);
  if (!normalized) {
    return null;
  }
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return normalized;
}

function isJunkPath(path: string): boolean {
  const segments = path.split('/');
  const base = segments[segments.length - 1]!.toLowerCase();
  return (
    JUNK_BASENAMES.has(base) ||
    segments.slice(0, -1).some(segment => JUNK_DIRECTORIES.has(segment.toLowerCase()))
  );
}

// -- Manifests -----------------------------------------------------------------

async function readDeclaredManifest(
  files: Map<string, Blob>
): Promise<Partial<LibraryItemManifest> | null> {
  const blob = files.get(MANIFEST_FILE);
  if (!blob) {
    return null;
  }
  files.delete(MANIFEST_FILE);
  try {
    const parsed: unknown = JSON.parse(await blob.text());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Partial<LibraryItemManifest>;
  } catch {
    // A corrupt item.json falls back to synthesis rather than failing the whole bundle.
    return null;
  }
}

/**
 * Honour an authored `item.json`, id included: re-dropping a folder that was exported from the
 * store therefore *updates* that item instead of creating a twin. Only the parts that must match
 * reality (the file list) and the parts it omits are filled in.
 */
function completeManifest(
  declared: Partial<LibraryItemManifest>,
  paths: readonly string[],
  label: string
): LibraryItemManifest {
  const now = Date.now();
  const name = nonEmpty(declared.name) ? declared.name : deriveName(label);
  const preview = nonEmpty(declared.preview) ? normalizeBundlePath(declared.preview) : undefined;
  const entry = nonEmpty(declared.entry) ? normalizeBundlePath(declared.entry) : pickEntry(paths);
  return {
    ...declared,
    id: nonEmpty(declared.id) ? declared.id : newId(),
    slug: nonEmpty(declared.slug) ? declared.slug : slugify(name),
    name,
    type: declared.type ?? (entry ? inferItemTypeFromPath(entry) : 'image'),
    tags: Array.isArray(declared.tags) ? declared.tags.filter(nonEmpty) : [],
    preview: preview && paths.includes(preview) ? preview : pickPreview(paths),
    entry,
    files: [...paths],
    source: declared.source ?? 'imported',
    status: declared.status ?? 'draft',
    createdAt: typeof declared.createdAt === 'number' ? declared.createdAt : now,
    updatedAt: now,
  };
}

function synthesizeManifest(paths: readonly string[], label: string): LibraryItemManifest {
  const now = Date.now();
  const name = deriveName(label);
  const entry = pickEntry(paths);
  return {
    id: newId(),
    slug: slugify(name),
    name,
    type: entry ? inferItemTypeFromPath(entry) : 'image',
    tags: [],
    preview: pickPreview(paths),
    entry,
    files: [...paths],
    source: 'imported',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

/** `preview.*` wins; otherwise the alphabetically first image; otherwise the item has none. */
function pickPreview(paths: readonly string[]): string | undefined {
  const images = paths.filter(path => IMAGE_PATTERN.test(path)).sort();
  return images.find(path => /(^|\/)preview\.[^/]+$/i.test(path)) ?? images[0];
}

/** The file that decides the item's type: a scene/prefab, then code, then any non-image asset. */
function pickEntry(paths: readonly string[]): string | undefined {
  const sorted = [...paths].sort();
  return (
    sorted.find(path => SCENE_PATTERN.test(path)) ??
    sorted.find(path => CODE_PATTERN.test(path)) ??
    sorted.find(path => !IMAGE_PATTERN.test(path)) ??
    sorted[0]
  );
}

function deriveName(label: string): string {
  const base = label.split('/').pop() ?? label;
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).trim() || 'Untitled item';
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `store-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// -- Misc ----------------------------------------------------------------------

function readErrorResponse(xhr: XMLHttpRequest): StoreUploadError {
  let message = xhr.statusText || `Upload failed with HTTP ${xhr.status}`;
  let issues: StoreValidationIssue[] | undefined;
  try {
    const body: unknown = JSON.parse(xhr.responseText);
    if (body && typeof body === 'object') {
      const typed = body as { error?: unknown; issues?: unknown };
      if (nonEmpty(typed.error)) {
        message = typed.error;
      }
      if (Array.isArray(typed.issues)) {
        issues = typed.issues.filter(
          (issue): issue is StoreValidationIssue =>
            nonEmpty((issue as StoreValidationIssue)?.field) &&
            nonEmpty((issue as StoreValidationIssue)?.message)
        );
      }
    }
  } catch {
    // Not JSON (proxy error page) — the status line is the best message available.
  }
  if (xhr.status === 413) {
    message = `${message} — a file exceeded the ${formatBytes(STORE_MAX_FILE_BYTES)} limit.`;
  }
  return new StoreUploadError(message, xhr.status, issues);
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** Compact byte label for limit messages and the staging list. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
