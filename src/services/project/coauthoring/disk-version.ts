import { sha256 } from '@/services/project/external-merge/hash';

/** The storage calls needed to read a file's raw bytes (`ProjectStorageService` in the editor). */
export interface ByteSource {
  fileExists(path: string): Promise<boolean>;
  readBlob(path: string): Promise<Blob>;
}

/** One version of a file as it is on disk. */
export interface DiskVersion {
  /** The raw bytes (BOM, line endings and all). */
  readonly bytes: Uint8Array;
  /** UTF-8 decoded text (a leading BOM is dropped, as every text reader does). */
  readonly text: string;
  /** sha256 of {@link bytes} — the only hash the co-authoring code compares (plan §4.3). */
  readonly hash: string;
}

/**
 * Read `path` as raw bytes and hash THOSE (plan §4.3 "факт изменения — хеш от байтов").
 * Hashing decoded text instead would never match `pix3 serve` / `pix3 read` for a file with a BOM
 * (the decoder strips it), and every such file would look like an external change forever.
 * Resolves to null when the file does not exist.
 */
export async function readDiskVersion(
  storage: ByteSource,
  path: string
): Promise<DiskVersion | null> {
  if (!(await storage.fileExists(path))) {
    return null;
  }
  const blob = await storage.readBlob(path);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, text: new TextDecoder('utf-8').decode(bytes), hash: await sha256(bytes) };
}
