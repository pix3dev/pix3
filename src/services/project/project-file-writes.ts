/**
 * Writing a generated artifact into the project, parent directories included.
 *
 * Extracted because three callers had grown the same private helper (the image generator, the Generate
 * panel, and now the SFX generator) and the interesting half is not the write — it is that
 * `createDirectory` on an existing directory is expected to fail and must be ignored. A caller that
 * forgets that swallows nothing and reports a spurious save failure for a folder that was already
 * there.
 *
 * Typed against the narrow slice of `ProjectStorageService` that is actually used, so a spec can pass
 * two `vi.fn()`s instead of a service.
 */

/** The writing surface of `ProjectStorageService`, as much of it as these helpers touch. */
export interface ProjectBinaryWriter {
  createDirectory(path: string): Promise<void>;
  writeBinaryFile(path: string, data: ArrayBuffer): Promise<void>;
}

/**
 * Create every missing parent directory of a project-relative path, deepest last.
 *
 * Each level's failure is ignored: the overwhelmingly common cause is "it already exists", and there is
 * no portable way to distinguish that from a real error across the File System Access API and the cloud
 * backend. A genuine problem surfaces on the write that follows, where it can be reported honestly.
 */
export async function ensureProjectParentDirectory(
  storage: Pick<ProjectBinaryWriter, 'createDirectory'>,
  relativePath: string
): Promise<void> {
  const segments = relativePath.split('/');
  segments.pop();
  let accumulated = '';
  for (const segment of segments) {
    if (!segment) {
      continue;
    }
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    try {
      await storage.createDirectory(accumulated);
    } catch {
      // directory likely already exists
    }
  }
}

/** Write bytes to a project-relative path, creating the folders it needs first. */
export async function writeProjectBinaryFile(
  storage: ProjectBinaryWriter,
  relativePath: string,
  data: ArrayBuffer
): Promise<void> {
  await ensureProjectParentDirectory(storage, relativePath);
  await storage.writeBinaryFile(relativePath, data);
}
