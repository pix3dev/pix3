import type { FileDescriptor } from '@/services/project/FileSystemAPIService';
import type { ProjectService } from '@/services/project/ProjectService';

/** Recursive stats for a project directory (nested files + folders). */
export interface DirectoryStats {
  /** Total byte size of all nested files. */
  readonly sizeBytes: number;
  /** Total number of nested entries (files and directories). */
  readonly itemCount: number;
}

/** Minimal surface the walk needs — keeps callers testable. */
type DirectoryLister = Pick<ProjectService, 'listDirectory'>;

function normalizePath(path: string): string {
  const normalized = path
    .replace(/\\+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return normalized || '.';
}

/**
 * Same exclusion rules the asset tree uses: dot-entries and `node_modules`
 * anywhere in the path are ignored.
 */
function shouldExcludeEntry(entry: FileDescriptor): boolean {
  const normalizedPath = normalizePath(entry.path);
  const pathSegments = normalizedPath.split('/').filter(segment => segment.length > 0);

  if (entry.name.startsWith('.')) {
    return true;
  }

  if (entry.name === 'node_modules') {
    return true;
  }

  if (pathSegments.some(segment => segment.startsWith('.'))) {
    return true;
  }

  if (pathSegments.includes('node_modules')) {
    return true;
  }

  return false;
}

async function listDirectory(
  projectService: DirectoryLister,
  path: string
): Promise<FileDescriptor[]> {
  try {
    const entries = await projectService.listDirectory(path);
    return entries.filter(entry => !shouldExcludeEntry(entry));
  } catch {
    return [];
  }
}

/**
 * Recursively walk `path`, summing file sizes and counting nested entries.
 * Mirrors the logic that formerly lived in `AssetTree.getDirectoryContentSize`.
 */
export async function computeDirectoryStats(
  projectService: DirectoryLister,
  path: string
): Promise<DirectoryStats> {
  const entries = await listDirectory(projectService, path);
  let sizeBytes = 0;
  let itemCount = 0;

  for (const entry of entries) {
    itemCount += 1;
    if (entry.kind === 'directory') {
      const nested = await computeDirectoryStats(projectService, entry.path);
      sizeBytes += nested.sizeBytes;
      itemCount += nested.itemCount;
      continue;
    }

    sizeBytes += entry.size ?? 0;
  }

  return { sizeBytes, itemCount };
}
