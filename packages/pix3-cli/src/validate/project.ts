import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { isRecord } from './yaml-doc.ts';

/** Folders that are never project content. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.pix3', 'dist', '.vite', '.cache']);

export const SCENE_EXTENSION = '.pix3scene';

/**
 * A read-only inventory of a project folder: every file, by project-relative path.
 *
 * Existence checks go through this set rather than `fs.existsSync` on purpose: the set is exact
 * about case, so `res://Sprites/Coin.png` against `sprites/coin.png` is reported on every OS — the
 * browser build that serves it (and the FSA handle the editor reads through) is case-sensitive even
 * when the author's disk is not.
 */
export class ProjectFiles {
  readonly root: string;
  readonly files: readonly string[];
  private readonly fileSet: ReadonlySet<string>;
  private readonly textCache = new Map<string, string>();

  constructor(root: string) {
    this.root = resolve(root);
    this.files = walk(this.root, this.root).sort();
    this.fileSet = new Set(this.files);
  }

  has(projectPath: string): boolean {
    return this.fileSet.has(projectPath);
  }

  absolute(projectPath: string): string {
    return join(this.root, projectPath);
  }

  /** Project-relative path of an absolute one, or null when it is outside the project. */
  relativeOf(absolutePath: string): string | null {
    const rel = relative(this.root, resolve(absolutePath));
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return rel.split(sep).join('/');
  }

  readText(projectPath: string): string {
    const cached = this.textCache.get(projectPath);
    if (cached !== undefined) return cached;
    const text = readFileSync(this.absolute(projectPath), 'utf8');
    this.textCache.set(projectPath, text);
    return text;
  }

  scenes(): string[] {
    return this.files.filter(file => file.endsWith(SCENE_EXTENSION));
  }
}

const walk = (root: string, dir: string): string[] => {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      out.push(...walk(root, join(dir, entry.name)));
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return out;
};

/**
 * Project-relative path a scene reference points at, or `null` when it is not a project file
 * (`http(s):`, `data:`, `blob:`). Accepts `res://x`, `/x`, `./x` and `x` — the loader's
 * `ResourceManager.normalize` treats every one of them as project-relative.
 */
export const toProjectPath = (reference: string): string | null => {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'res') return null;
  const withoutScheme = scheme === 'res' ? trimmed.replace(/^res:\/\//i, '') : trimmed;
  const withoutQuery = withoutScheme.replace(/[?#].*$/, '');
  const segments: string[] = [];
  for (const segment of withoutQuery.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(decodeURIComponentSafe(segment));
  }
  return segments.length === 0 ? null : segments.join('/');
};

const decodeURIComponentSafe = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface ProjectManifestInfo {
  readonly targetPlatform?: string;
}

/** The bits of `pix3project.yaml` validation cares about; `{}` when absent or unreadable. */
export const readManifestInfo = (project: ProjectFiles): ProjectManifestInfo => {
  if (!project.has('pix3project.yaml')) return {};
  try {
    const data = parseYaml(project.readText('pix3project.yaml')) as unknown;
    if (!isRecord(data)) return {};
    return typeof data.targetPlatform === 'string' ? { targetPlatform: data.targetPlatform } : {};
  } catch {
    return {};
  }
};
