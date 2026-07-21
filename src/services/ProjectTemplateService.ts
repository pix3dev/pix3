import { parse } from 'yaml';
import { injectable } from '@/fw/di';
import {
  DEFAULT_PROJECT_TYPE,
  DEFAULT_TARGET_PLATFORM,
  DEFAULT_VIEWPORT_BASE_HEIGHT,
  DEFAULT_VIEWPORT_BASE_WIDTH,
  PROJECT_TYPES,
  TARGET_PLATFORMS,
  type ProjectType,
  type TargetPlatform,
} from '@/core/ProjectManifest';

/**
 * Bundled project templates. Each template lives under
 * `src/templates/projects/<id>/` with:
 *  - `template.yaml` — metadata (title, description, projectType, viewport, …)
 *  - `cover.png` — card artwork for the create-project wizard
 *  - `files/**` — the file tree copied verbatim into a new project
 *
 * Empty directories cannot be expressed by bundled files; list them in
 * `template.yaml` under `directories:`.
 */

const TEMPLATE_META_MODULES = import.meta.glob('../templates/projects/*/template.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Lazy (not eager): template file CONTENTS are only needed at project-creation
// time (`ProjectService.createProjectStructure`), never for the template
// picker list — eagerly bundling every template's every file into the main
// chunk cost ~85 KB for a feature most sessions never touch.
const TEMPLATE_TEXT_MODULES = import.meta.glob(
  '../templates/projects/*/files/**/*.{pix3scene,ts,md,yaml,yml,json,txt}',
  {
    query: '?raw',
    import: 'default',
  }
) as Record<string, () => Promise<string>>;

const TEMPLATE_BINARY_MODULES = import.meta.glob(
  '../templates/projects/*/files/**/*.{png,jpg,jpeg,webp,glb,gltf,mp3,ogg,wav}',
  {
    query: '?url',
    import: 'default',
    eager: true,
  }
) as Record<string, string>;

const TEMPLATE_COVER_MODULES = import.meta.glob('../templates/projects/*/cover.png', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Agent-workflow overlay copied into every new project: AGENTS.md/CLAUDE.md,
 * the design/ folder readme, and bundled agent skills. Sources live under
 * `src/templates/agent/` — glob patterns cannot match dot-directories, so the
 * skills tree is stored as `agent/skills/**` and remapped to `.claude/skills/**`.
 */
// Lazy: only read at project-creation time via `getAgentOverlayFiles()`.
const AGENT_OVERLAY_MODULES = import.meta.glob('../templates/agent/**/*.{md,json}', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/**
 * Same dot-file limitation as the skills tree: the project .gitignore is
 * stored as `agent/gitignore.txt` and written to the project root as
 * `.gitignore` (keeps the ephemeral `.pix3/preview-session.json` agent token
 * out of git). The wildcard is required — Vite's import-glob rejects patterns
 * without any glob magic.
 */
const AGENT_GITIGNORE_MODULES = import.meta.glob('../templates/agent/gitignore*', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/**
 * Engine capability docs bundled into projects so agents can work offline.
 * Lazy: these are ~65 KB of markdown only needed at project-creation time.
 */
const AGENT_DOC_REFERENCE_MODULES = import.meta.glob(
  '../../docs/{nodes-and-systems,node-types-reference}.md',
  {
    query: '?raw',
    import: 'default',
  }
) as Record<string, () => Promise<string>>;

const AGENT_OVERLAY_MARKER = '/templates/agent/';
const AGENT_SKILLS_PREFIX = 'skills/';
const AGENT_SKILLS_TARGET_PREFIX = '.claude/skills/';
const AGENT_DOC_REFERENCES_TARGET = '.claude/skills/pix3-game-dev/references/';

export interface ProjectTemplate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly projectType: ProjectType;
  readonly targetPlatform: TargetPlatform;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly coverUrl: string | null;
  readonly order: number;
  /**
   * Project-relative path (no `res://`) of the scene a build / "Start Game"
   * boots into — becomes the manifest's `defaultExportScenePath`. Undefined
   * falls back to `main.pix3scene`. Used by templates whose entry scene (e.g. a
   * menu) differs from the editor startup scene.
   */
  readonly entryScenePath?: string;
  /** Extra empty directories to create (bundles cannot carry empty folders). */
  readonly directories: readonly string[];
  /** Project-relative path → bundled asset URL (fetched at copy time). */
  readonly binaryFiles: ReadonlyMap<string, string>;
}

export const DEFAULT_PROJECT_TEMPLATE_ID = 'empty-3d';

const TEMPLATE_DIR_PATTERN = /\/projects\/([^/]+)\//;
const TEMPLATE_FILES_MARKER = '/files/';

const extractTemplateId = (modulePath: string): string | null =>
  TEMPLATE_DIR_PATTERN.exec(modulePath)?.[1] ?? null;

const extractProjectRelativePath = (modulePath: string): string | null => {
  const markerIndex = modulePath.indexOf(TEMPLATE_FILES_MARKER);
  if (markerIndex < 0) {
    return null;
  }
  return modulePath.slice(markerIndex + TEMPLATE_FILES_MARKER.length);
};

const asPositiveInt = (value: unknown, fallback: number): number => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : fallback;
};

@injectable()
export class ProjectTemplateService {
  private templates: ProjectTemplate[] | null = null;
  private readonly templateTextFilesCache = new Map<
    string,
    Promise<ReadonlyMap<string, string>>
  >();
  private agentOverlayFilesPromise: Promise<ReadonlyMap<string, string>> | null = null;

  getTemplates(): readonly ProjectTemplate[] {
    if (!this.templates) {
      this.templates = this.buildTemplates();
    }
    return this.templates;
  }

  getTemplate(id: string): ProjectTemplate | null {
    return this.getTemplates().find(template => template.id === id) ?? null;
  }

  getDefaultTemplate(): ProjectTemplate {
    const templates = this.getTemplates();
    const preferred = templates.find(template => template.id === DEFAULT_PROJECT_TEMPLATE_ID);
    const fallback = preferred ?? templates[0];
    if (!fallback) {
      throw new Error('No project templates are bundled with the editor.');
    }
    return fallback;
  }

  /**
   * Project-relative path → file contents for a template's `files/**` tree.
   * Lazy-loaded and cached per template id — only needed when the template is
   * actually applied to a new project, not when listing templates.
   */
  async getTemplateTextFiles(id: string): Promise<ReadonlyMap<string, string>> {
    let cached = this.templateTextFilesCache.get(id);
    if (!cached) {
      cached = this.loadTemplateTextFiles(id);
      this.templateTextFilesCache.set(id, cached);
    }
    return cached;
  }

  private async loadTemplateTextFiles(id: string): Promise<ReadonlyMap<string, string>> {
    const entries: Array<[string, () => Promise<string>]> = [];
    for (const [modulePath, loader] of Object.entries(TEMPLATE_TEXT_MODULES)) {
      if (extractTemplateId(modulePath) !== id) {
        continue;
      }
      const relativePath = extractProjectRelativePath(modulePath);
      if (!relativePath) {
        continue;
      }
      entries.push([relativePath, loader]);
    }
    const contents = await Promise.all(entries.map(([, loader]) => loader()));
    return new Map(entries.map(([relativePath], index) => [relativePath, contents[index]]));
  }

  private buildTemplates(): ProjectTemplate[] {
    const binaryByTemplate = this.groupFilesByTemplate(TEMPLATE_BINARY_MODULES);
    const coversByTemplate = new Map<string, string>();
    for (const [modulePath, url] of Object.entries(TEMPLATE_COVER_MODULES)) {
      const id = extractTemplateId(modulePath);
      if (id) {
        coversByTemplate.set(id, url);
      }
    }

    const templates: ProjectTemplate[] = [];
    for (const [modulePath, rawMeta] of Object.entries(TEMPLATE_META_MODULES)) {
      const id = extractTemplateId(modulePath);
      if (!id) {
        continue;
      }

      let meta: Record<string, unknown> = {};
      try {
        const parsed = parse(rawMeta) as unknown;
        if (parsed && typeof parsed === 'object') {
          meta = parsed as Record<string, unknown>;
        }
      } catch (error) {
        console.warn(`[ProjectTemplateService] Failed to parse template.yaml for "${id}":`, error);
      }

      const projectTypeRaw = typeof meta.projectType === 'string' ? meta.projectType : '';
      const targetPlatformRaw = typeof meta.targetPlatform === 'string' ? meta.targetPlatform : '';
      const viewport =
        meta.viewport && typeof meta.viewport === 'object'
          ? (meta.viewport as Record<string, unknown>)
          : {};
      const directories = Array.isArray(meta.directories)
        ? meta.directories.filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
        : [];
      const entrySceneRaw = typeof meta.entryScene === 'string' ? meta.entryScene.trim() : '';
      const entryScenePath = entrySceneRaw ? entrySceneRaw.replace(/^res:\/\//i, '') : undefined;

      templates.push({
        id,
        title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : id,
        description: typeof meta.description === 'string' ? meta.description.trim() : '',
        projectType: (PROJECT_TYPES as readonly string[]).includes(projectTypeRaw)
          ? (projectTypeRaw as ProjectType)
          : DEFAULT_PROJECT_TYPE,
        targetPlatform: (TARGET_PLATFORMS as readonly string[]).includes(targetPlatformRaw)
          ? (targetPlatformRaw as TargetPlatform)
          : DEFAULT_TARGET_PLATFORM,
        viewport: {
          width: asPositiveInt(viewport.width, DEFAULT_VIEWPORT_BASE_WIDTH),
          height: asPositiveInt(viewport.height, DEFAULT_VIEWPORT_BASE_HEIGHT),
        },
        coverUrl: coversByTemplate.get(id) ?? null,
        order: asPositiveInt(meta.order, 1000),
        entryScenePath,
        directories,
        binaryFiles: binaryByTemplate.get(id) ?? new Map(),
      });
    }

    templates.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    return templates;
  }

  /**
   * Project-relative path → contents for the agent overlay written into every
   * new project (AGENTS.md, CLAUDE.md, design/README.md, .claude/skills/**).
   * Lazy-loaded and cached — only needed at project-creation time.
   */
  async getAgentOverlayFiles(): Promise<ReadonlyMap<string, string>> {
    if (!this.agentOverlayFilesPromise) {
      this.agentOverlayFilesPromise = this.loadAgentOverlayFiles();
    }
    return this.agentOverlayFilesPromise;
  }

  private async loadAgentOverlayFiles(): Promise<ReadonlyMap<string, string>> {
    const entries: Array<[string, () => Promise<string>]> = [];

    for (const [modulePath, loader] of Object.entries(AGENT_OVERLAY_MODULES)) {
      const markerIndex = modulePath.indexOf(AGENT_OVERLAY_MARKER);
      if (markerIndex < 0) {
        continue;
      }
      const relativePath = modulePath.slice(markerIndex + AGENT_OVERLAY_MARKER.length);
      const targetPath = relativePath.startsWith(AGENT_SKILLS_PREFIX)
        ? AGENT_SKILLS_TARGET_PREFIX + relativePath.slice(AGENT_SKILLS_PREFIX.length)
        : relativePath;
      entries.push([targetPath, loader]);
    }

    for (const [modulePath, loader] of Object.entries(AGENT_DOC_REFERENCE_MODULES)) {
      const fileName = modulePath.slice(modulePath.lastIndexOf('/') + 1);
      entries.push([AGENT_DOC_REFERENCES_TARGET + fileName, loader]);
    }

    for (const loader of Object.values(AGENT_GITIGNORE_MODULES)) {
      entries.push(['.gitignore', loader]);
    }

    const contents = await Promise.all(entries.map(([, loader]) => loader()));
    const files = new Map<string, string>();
    entries.forEach(([targetPath], index) => files.set(targetPath, contents[index]));
    return files;
  }

  private groupFilesByTemplate(modules: Record<string, string>): Map<string, Map<string, string>> {
    const grouped = new Map<string, Map<string, string>>();
    for (const [modulePath, contents] of Object.entries(modules)) {
      const id = extractTemplateId(modulePath);
      const relativePath = extractProjectRelativePath(modulePath);
      if (!id || !relativePath) {
        continue;
      }

      let files = grouped.get(id);
      if (!files) {
        files = new Map();
        grouped.set(id, files);
      }
      files.set(relativePath, contents);
    }
    return grouped;
  }
}
