import { injectable, inject } from '@/fw/di';
import { ProjectService } from '@/services/project/ProjectService';

export interface AssetImportFailure {
  /** Original file name that failed to import. */
  readonly name: string;
  /** Human-readable error message. */
  readonly error: string;
}

export interface AssetImportResult {
  /** Project-relative paths of files that were written successfully. */
  readonly importedPaths: string[];
  /** Files that could not be imported, with their error message. */
  readonly failures: AssetImportFailure[];
}

/**
 * Copies user-provided files (from a file picker, OS drag-and-drop, or the
 * clipboard) into a project directory. Mirrors the direct-write approach used by
 * the asset tree's external-file-drop handling, with non-destructive collision
 * handling: when a name already exists it is auto-suffixed (e.g. `hero (1).png`)
 * so existing assets are never overwritten.
 */
@injectable()
export class AssetImportService {
  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  async importFiles(files: readonly File[], targetDirectory: string): Promise<AssetImportResult> {
    const importedPaths: string[] = [];
    const failures: AssetImportFailure[] = [];

    if (files.length === 0) {
      return { importedPaths, failures };
    }

    const directory = normalizeImportDirectory(targetDirectory);

    if (directory !== '.') {
      try {
        await this.projectService.createDirectory(directory);
      } catch {
        // Directory already exists — createDirectory is idempotent for existing paths.
      }
    }

    const usedNames = new Set<string>();
    try {
      const entries = await this.projectService.listDirectory(directory);
      for (const entry of entries) {
        usedNames.add(entry.name.toLowerCase());
      }
    } catch {
      // New/empty directory that can't be listed yet — nothing to collide with.
    }

    for (const file of files) {
      try {
        const uniqueName = resolveUniqueAssetName(file.name, usedNames);
        usedNames.add(uniqueName.toLowerCase());
        const fullPath = directory === '.' ? uniqueName : `${directory}/${uniqueName}`;

        if (isTextAsset(file)) {
          const content = await file.text();
          await this.projectService.writeFile(fullPath, content);
        } else {
          const buffer = await file.arrayBuffer();
          await this.projectService.writeBinaryFile(fullPath, buffer);
        }

        importedPaths.push(fullPath);
      } catch (error) {
        failures.push({
          name: file.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { importedPaths, failures };
  }
}

const TEXT_ASSET_EXTENSIONS =
  /\.(json|pix3scene|pix3anim|txt|md|csv|xml|svg|glsl|frag|vert|yml|yaml|ts|js)$/i;

/** Whether a file should be written as UTF-8 text rather than raw bytes. */
export function isTextAsset(file: File): boolean {
  return file.type.startsWith('text/') || TEXT_ASSET_EXTENSIONS.test(file.name);
}

/** Normalizes a target directory to the project convention (forward slashes, no leading `./`, `.` for root). */
export function normalizeImportDirectory(directory: string): string {
  const normalized = directory
    .replace(/\\+/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .trim();
  return normalized.length === 0 ? '.' : normalized;
}

/**
 * Returns a file name that does not collide (case-insensitively) with any name in
 * `usedNames`. On collision a ` (n)` suffix is inserted before the extension, e.g.
 * `hero.png` → `hero (1).png`. Dotfiles (`.gitignore`) are treated as having no
 * extension. `usedNames` is not mutated.
 */
export function resolveUniqueAssetName(name: string, usedNames: ReadonlySet<string>): string {
  if (!usedNames.has(name.toLowerCase())) {
    return name;
  }

  const dotIndex = name.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const base = hasExtension ? name.slice(0, dotIndex) : name;
  const extension = hasExtension ? name.slice(dotIndex) : '';

  let counter = 1;
  let candidate = `${base} (${counter})${extension}`;
  while (usedNames.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = `${base} (${counter})${extension}`;
  }
  return candidate;
}
