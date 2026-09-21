import type { ProjectStorageService } from '@/services/project/ProjectStorageService';

/**
 * How much project SCRIPT source may ride along in a Flow turn's opening message. The scripts of a
 * recipe are 20–56 KB (the bouncer is the heavy end) and they land in the conversation's cached
 * prefix, which is far cheaper than the ten round-trips the agent otherwise spends reading them
 * back file by file.
 *
 * Scenes are deliberately NOT inlined any more. Measured on the bouncer recipe: scripts + scenes
 * came to 92K chars / 2 598 lines in the first message and the model sat in "Thinking…" for two
 * and a half minutes before its first tool call. The 30K of scene YAML was the part that bought
 * nothing: scene edits go through `set_property` / `create_node` / `move_node` (never
 * `str_replace`), and `scene_tree` returns the structure in one cheap call.
 */
const PROJECT_MAP_BUDGET_CHARS = 60_000;
/** Fence + path heading around each inlined file, charged against the budget. */
const SECTION_OVERHEAD = 64;
/** Where project scripts live — mirrors the agent's own inventory scan. */
const SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;

/** Storage surface the map needs — a subset of {@link ProjectStorageService}, so tests can fake it. */
export type ProjectMapStorage = Pick<ProjectStorageService, 'listDirectory' | 'readTextFile'>;

/**
 * The scripts of the open project, inlined byte-for-byte, plus the list of its scene files.
 *
 * Measured on a first increment: 22 of 55 model round-trips (~170 s of a ~460 s turn) were the agent
 * reading a project it had just generated — ten `fs_read`s plus `scene_tree`/`fs_list`/`find_nodes`
 * rebuilding a map that already existed. Handing the scripts over up front costs ~10–14K tokens
 * once, in the cached prefix, and takes the reads off the critical path.
 *
 * Byte-for-byte matters: these are `str_replace` anchors. A summary would force a re-read. Scenes
 * are named, not inlined — see {@link PROJECT_MAP_BUDGET_CHARS} for the measurement behind that.
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
  const scenes = await listScenes(storage);

  if (sections.length === 0 && scenes.length === 0) {
    return '';
  }
  const note =
    skipped.length > 0
      ? `\n\nToo large to inline, \`fs_read\` them if you need them: ${skipped.join(', ')}.`
      : '';
  const sceneNote =
    scenes.length > 0
      ? [
          '',
          `Scene files (structure via \`scene_tree\`, edits via \`set_property\` / \`create_node\` /`,
          `\`move_node\` — not inlined, and not for \`str_replace\`): ${scenes.map(path => `\`${path}\``).join(', ')}.`,
        ].join('\n')
      : '';
  return [
    '## Project map — the current contents of every script',
    '',
    'This is the live text of these files, byte-for-byte. Do **not** `fs_read` any of them before',
    'your first edit; you would get back exactly what is below. After an edit, `str_replace`',
    'returns the updated neighbourhood, so you do not need to re-read them afterwards either.',
    '',
    ...sections,
    sceneNote,
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
