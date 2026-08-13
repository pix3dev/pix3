import type { ProjectStorageService } from '@/services/project/ProjectStorageService';

/**
 * How much project source may ride along in a Flow turn's opening message. A whole recipe is ~40 KB
 * (~10K tokens) and it lands in the cached prefix, which is far cheaper than the ten round-trips the
 * agent otherwise spends reading it back file by file.
 */
const PROJECT_MAP_BUDGET_CHARS = 90_000;
/** Fence + path heading around each inlined file, charged against the budget. */
const SECTION_OVERHEAD = 64;
/** Where project scripts live — mirrors the agent's own inventory scan. */
const SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;

/** Storage surface the map needs — a subset of {@link ProjectStorageService}, so tests can fake it. */
export type ProjectMapStorage = Pick<ProjectStorageService, 'listDirectory' | 'readTextFile'>;

/**
 * The scripts and scenes of the open project, inlined byte-for-byte.
 *
 * Measured on a first increment: 22 of 55 model round-trips (~170 s of a ~460 s turn) were the agent
 * reading a project it had just generated — ten `fs_read`s plus `scene_tree`/`fs_list`/`find_nodes`
 * rebuilding a map that already existed. Handing it over up front costs ~10K tokens once, in the
 * cached prefix, and takes the reads off the critical path.
 *
 * Byte-for-byte matters: these are `str_replace` anchors. A summary would force a re-read.
 */
export const buildProjectMap = async (storage: ProjectMapStorage): Promise<string> => {
  const sections: string[] = [];
  const skipped: string[] = [];
  let budget = PROJECT_MAP_BUDGET_CHARS;

  const readOptional = async (path: string): Promise<string | null> => {
    try {
      return await storage.readTextFile(path);
    } catch {
      return null;
    }
  };

  const add = (path: string, language: string, contents: string): void => {
    if (contents.length + SECTION_OVERHEAD > budget) {
      skipped.push(path);
      return;
    }
    budget -= contents.length + SECTION_OVERHEAD;
    sections.push(`### ${path}\n\`\`\`${language}\n${contents.replace(/\s+$/, '')}\n\`\`\``);
  };

  for (const path of await listScripts(storage)) {
    const contents = await readOptional(path);
    if (contents) add(path, 'ts', contents);
  }
  for (const path of await listScenes(storage)) {
    const contents = await readOptional(path);
    if (contents) add(path, 'yaml', contents);
  }

  if (sections.length === 0) {
    return '';
  }
  const note =
    skipped.length > 0
      ? `\n\nToo large to inline, \`fs_read\` them if you need them: ${skipped.join(', ')}.`
      : '';
  return [
    '## Project map — the current contents of every script and scene',
    '',
    'This is the live text of these files, byte-for-byte. Do **not** `fs_read` any of them before',
    'your first edit; you would get back exactly what is below. After an edit, `str_replace`',
    'returns the updated neighbourhood, so you do not need to re-read them afterwards either.',
    '',
    ...sections,
    note,
  ].join('\n');
};

/** Every project script file, in the same directories the agent's own inventory scans. */
const listScripts = async (storage: ProjectMapStorage): Promise<string[]> => {
  const found: string[] = [];
  for (const directory of SCRIPT_DIRECTORIES) {
    let entries;
    try {
      entries = await storage.listDirectory(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.kind === 'file' && /\.(ts|js)$/i.test(entry.name)) {
        found.push(entry.path);
      }
    }
  }
  return found;
};

/** Every `.pix3scene` under `scenes/` (prefabs live below it). */
const listScenes = async (storage: ProjectMapStorage): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await storage.listDirectory(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        await walk(entry.path, depth + 1);
      } else if (entry.name.endsWith('.pix3scene')) {
        found.push(entry.path);
      }
    }
  };
  await walk('scenes', 0);
  return found;
};
