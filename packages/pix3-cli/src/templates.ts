import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Project templates, read straight from disk.
 *
 * One source of truth (plan §5 A, risk #7 — "copy at build time"): the editor bundles
 * `src/templates/projects/` through Vite globs, and this package reads the same folders.
 *  - Published package: `prepack` copies each template's `template.yaml` + `files/` into
 *    `<package>/templates/` (gitignored), which is what ships in the tarball.
 *  - Repo checkout (`node packages/pix3-cli/src/index.ts`): the templates are read from
 *    `<repo>/src/templates/projects/` directly, so editing a recipe needs no rebuild, and a
 *    leftover `templates/` copy in the checkout can never shadow the source.
 *
 * The metadata parsing mirrors `ProjectTemplateService.buildTemplates` in the editor (same
 * defaults, same `hidden`, same `entryScene` → `defaultExportScenePath` handling);
 * `src/templates/projects/cli-manifest.spec.ts` holds the two to the same answer.
 */

type ProjectType = '2d' | '3d';
export type TargetPlatform = 'mobile' | 'desktop' | 'universal';

const PROJECT_TYPES: readonly string[] = ['2d', '3d'];
const TARGET_PLATFORMS: readonly string[] = ['mobile', 'desktop', 'universal'];
const DEFAULT_PROJECT_TYPE: ProjectType = '3d';
const DEFAULT_TARGET_PLATFORM: TargetPlatform = 'universal';
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;

export interface TemplateInfo {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly projectType: ProjectType;
  readonly targetPlatform: TargetPlatform;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly order: number;
  readonly hidden: boolean;
  /** Ships `design/recipe.md` — part of the Flow recipe catalog (see `recipes.spec.ts`). */
  readonly isRecipe: boolean;
  /** Project-relative, no `res://`. */
  readonly entryScenePath?: string;
  readonly directories: readonly string[];
  /** Absolute path of the template's `files/` tree. */
  readonly filesDir: string;
}

const packageRootDir = (): string => fileURLToPath(new URL('..', import.meta.url));

/**
 * `<repo>/src/templates/projects` when this package runs from inside the pix3 monorepo, else null.
 * "Inside" is proven, not guessed from a relative path: the repo root must hold
 * `packages/pix3-cli` = this package. An installed copy under `node_modules/@pix3/cli` never
 * matches, whatever happens to sit two levels up.
 */
const repoTemplatesDir = (): string | null => {
  const packageRoot = packageRootDir();
  const repoRoot = join(packageRoot, '..', '..');
  const templates = join(repoRoot, 'src', 'templates', 'projects');
  const isRepoCheckout =
    resolve(repoRoot, 'packages', 'pix3-cli') === resolve(packageRoot) &&
    existsSync(join(repoRoot, 'packages', 'pix3-runtime'));
  return isRepoCheckout && existsSync(templates) ? templates : null;
};

/** Candidate template roots: the repo's own folder in a checkout, the packaged copy otherwise. */
const templateRootCandidates = (): string[] => {
  const repo = repoTemplatesDir();
  return repo ? [repo] : [join(packageRootDir(), 'templates')];
};

/** `PIX3_TEMPLATES_DIR` overrides the lookup (tests, or trying a template folder in progress). */
export const resolveTemplatesRoot = (): string => {
  const override = process.env.PIX3_TEMPLATES_DIR;
  if (override) return override;
  for (const candidate of templateRootCandidates()) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  throw new Error(
    `No project templates found in ${templateRootCandidates().join(', ')}. ` +
      'The package is incomplete — reinstall it (published builds carry a templates/ copy).'
  );
};

const asPositiveInt = (value: unknown, fallback: number): number => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : fallback;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const readTemplate = (root: string, id: string): TemplateInfo | null => {
  const dir = join(root, id);
  const metaPath = join(dir, 'template.yaml');
  const filesDir = join(dir, 'files');
  if (!existsSync(metaPath) || !existsSync(filesDir)) return null;

  let meta: Record<string, unknown> = {};
  try {
    meta = asRecord(parse(readFileSync(metaPath, 'utf8')));
  } catch (error) {
    process.stderr.write(`pix3: failed to parse ${metaPath}: ${String(error)}\n`);
  }

  const projectTypeRaw = typeof meta.projectType === 'string' ? meta.projectType : '';
  const targetPlatformRaw = typeof meta.targetPlatform === 'string' ? meta.targetPlatform : '';
  const viewport = asRecord(meta.viewport);
  const entrySceneRaw = typeof meta.entryScene === 'string' ? meta.entryScene.trim() : '';
  const entryScenePath = entrySceneRaw ? entrySceneRaw.replace(/^res:\/\//i, '') : undefined;

  return {
    id,
    title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : id,
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    projectType: PROJECT_TYPES.includes(projectTypeRaw)
      ? (projectTypeRaw as ProjectType)
      : DEFAULT_PROJECT_TYPE,
    targetPlatform: TARGET_PLATFORMS.includes(targetPlatformRaw)
      ? (targetPlatformRaw as TargetPlatform)
      : DEFAULT_TARGET_PLATFORM,
    viewport: {
      width: asPositiveInt(viewport.width, DEFAULT_VIEWPORT.width),
      height: asPositiveInt(viewport.height, DEFAULT_VIEWPORT.height),
    },
    order: asPositiveInt(meta.order, 1000),
    hidden: meta.hidden === true,
    isRecipe: existsSync(join(filesDir, 'design', 'recipe.md')),
    ...(entryScenePath ? { entryScenePath } : {}),
    directories: Array.isArray(meta.directories)
      ? meta.directories.filter((d): d is string => typeof d === 'string' && d.length > 0)
      : [],
    filesDir,
  };
};

/** Every template, hidden ones included, in the editor's order (`order`, then title). */
export const listTemplates = (root: string = resolveTemplatesRoot()): TemplateInfo[] =>
  readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => readTemplate(root, entry.name))
    .filter((template): template is TemplateInfo => template !== null)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

/**
 * Resolve what the user typed: an exact id (`recipe-tapper-2d`, hidden templates included — like
 * the editor, `hidden` keeps a template out of lists, not out of reach), else the short recipe
 * name the site uses (`tapper` → the one visible `recipe-tapper-*`). Ambiguity is an error, never
 * a guess.
 */
export const resolveTemplate = (
  query: string,
  templates: readonly TemplateInfo[]
): { template: TemplateInfo } | { error: string } => {
  const exact = templates.find(t => t.id === query);
  if (exact) return { template: exact };
  const visible = templates.filter(t => !t.hidden);
  const prefixed = visible.filter(
    t => t.id === `recipe-${query}` || t.id.startsWith(`recipe-${query}-`)
  );
  if (prefixed.length === 1) return { template: prefixed[0] };
  if (prefixed.length > 1) {
    return { error: `"${query}" is ambiguous: ${prefixed.map(t => t.id).join(', ')}.` };
  }
  return {
    error: `Unknown recipe or template "${query}". Run \`pix3 new\` to list them.`,
  };
};

/** First sentence of a template description — the "one line" of the list. */
export const oneLine = (description: string): string => {
  const flat = description.replace(/\s+/g, ' ').trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(flat);
  return match ? match[1] : flat;
};
