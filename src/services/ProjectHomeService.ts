import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { FileSystemAPIService, type FileDescriptor } from '@/services/FileSystemAPIService';
import { SceneThumbnailGenerator } from '@/services/SceneThumbnailGenerator';
import { ThumbnailCacheService } from '@/services/ThumbnailCacheService';

/** A scene surfaced on the Project Home grid. */
export interface HomeSceneEntry {
  /** Project-relative path, e.g. `src/assets/scenes/main.pix3scene`. */
  path: string;
  /** `res://`-prefixed resource id used to open the scene. */
  resourceId: string;
  /** File name without extension. */
  name: string;
  /** True when this is the project's main/export scene. */
  isMain: boolean;
  /** Heuristic: a scene that is neither main nor referenced as a startup target. */
  isDraft: boolean;
  /** Node count parsed from the scene YAML. */
  nodeCount: number;
  /** File modification time (ms since epoch). */
  modifiedAt: number;
  /** File size in bytes (used for thumbnail cache keying). */
  sizeBytes: number;
}

export type ChecklistAction = 'draft-gdd' | 'add-script' | 'invite';

export interface HomeChecklistItem {
  id: string;
  label: string;
  done: boolean;
  /** Action shown when the item is not done. */
  action?: ChecklistAction;
}

export type GddSectionStatus = 'ready' | 'draft' | 'empty';

export interface GddSection {
  title: string;
  status: GddSectionStatus;
}

export interface HomeGddInfo {
  /** Project-relative path of the GDD file. */
  path: string;
  /** Modification time (ms). */
  modifiedAt: number;
  sections: GddSection[];
}

export interface HomeAtAGlance {
  assetCount: number;
  assetBytes: number;
  scriptCount: number;
  locales: string[];
  lastBuild: string | null;
}

export interface HomeActivityEntry {
  icon: string;
  text: string;
  /** Timestamp (ms) used to render a relative label. */
  when: number;
}

export interface ProjectHomeData {
  projectName: string;
  scenes: HomeSceneEntry[];
  mainScenePath: string | null;
  hasSession: boolean;
  gdd: HomeGddInfo | null;
  checklist: HomeChecklistItem[];
  atAGlance: HomeAtAGlance;
  activity: HomeActivityEntry[];
}

const RES_PREFIX = 'res://';
const PRUNED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.yalc',
  '.pix3',
  '.cache',
  'coverage',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ktx2', 'basis']);
const AUDIO_EXTS = new Set(['mp3', 'ogg', 'wav', 'm4a', 'flac']);
const MODEL_EXTS = new Set(['gltf', 'glb', 'fbx', 'obj']);
const FONT_EXTS = new Set(['ttf', 'otf', 'woff', 'woff2']);
const GDD_CANDIDATES = [
  'design/gdd.md',
  'design/GDD.md',
  'design/game-design.md',
  'docs/gdd.md',
  'docs/GDD.md',
  'GDD.md',
  'gdd.md',
];
const MAX_WALK_DEPTH = 8;

interface WalkedFile {
  path: string;
  name: string;
  size: number;
}

/**
 * Aggregates the read-only data the Project Home dashboard renders: the scene
 * index, onboarding checklist, GDD summary, at-a-glance stats and a derived
 * activity feed. It is intentionally defensive — every accessor degrades to an
 * empty/neutral value rather than throwing, so the Home tab always renders even
 * on a half-hydrated or permission-restricted project.
 */
@injectable()
export class ProjectHomeService {
  @inject(FileSystemAPIService)
  private readonly fileSystem!: FileSystemAPIService;

  @inject(SceneThumbnailGenerator)
  private readonly sceneThumbnails!: SceneThumbnailGenerator;

  @inject(ThumbnailCacheService)
  private readonly thumbnailCache!: ThumbnailCacheService;

  /** In-memory thumbnail cache, keyed by path::mtime::size. */
  private readonly thumbnailMem = new Map<string, string>();

  /** Gather the full Home snapshot. Never throws. */
  async load(): Promise<ProjectHomeData> {
    const projectName = appState.project.projectName ?? 'Untitled Project';
    const mainScenePath = this.getMainScenePath();

    const files = await this.walkProject();

    const scenes = await this.buildSceneIndex(files, mainScenePath);
    const atAGlance = this.buildAtAGlance(files);
    const gdd = await this.loadGdd(files);
    const checklist = this.buildChecklist({ scenes, atAGlance, gdd, mainScenePath });
    const activity = this.buildActivity(scenes);

    return {
      projectName,
      scenes,
      mainScenePath,
      hasSession: this.hasSession(),
      gdd,
      checklist,
      atAGlance,
      activity,
    };
  }

  /** Resolve the main scene as a project-relative path, or null. */
  getMainScenePath(): string | null {
    const configured = appState.project.manifest?.defaultExportScenePath?.trim();
    if (configured) {
      return this.stripRes(configured);
    }
    return null;
  }

  /** Convert a project-relative path to the `res://` resource id used to open it. */
  toResourceId(relativePath: string): string {
    const normalized = this.stripRes(relativePath).replace(/^\/+/, '');
    return `${RES_PREFIX}${normalized}`;
  }

  /**
   * Return a rendered thumbnail (data URL) for a scene, or null. Reads the shared
   * thumbnail cache first (populated by the asset browser and prior Home visits)
   * and only renders a fresh one on a miss, so repeated Home refreshes are cheap.
   */
  async getSceneThumbnail(scene: HomeSceneEntry): Promise<string | null> {
    const key = `${scene.path.replace(/\\/g, '/')}::${scene.modifiedAt}::${scene.sizeBytes}`;
    const inMem = this.thumbnailMem.get(key);
    if (inMem) return inMem;
    try {
      const cached = await this.thumbnailCache.get(key);
      if (cached) {
        this.thumbnailMem.set(key, cached);
        return cached;
      }
      const blob = await this.fileSystem.readBlob(scene.resourceId);
      const url = await this.sceneThumbnails.generate(blob, scene.resourceId);
      this.thumbnailMem.set(key, url);
      void this.thumbnailCache.set(key, url);
      return url;
    } catch {
      return null;
    }
  }

  /** True when the current project has a persisted tab session to restore. */
  hasSession(): boolean {
    const projectId = appState.project.id;
    if (!projectId) return false;
    try {
      const raw = localStorage.getItem(`pix3.projectTabs:${projectId}`);
      if (!raw) return false;
      const session = JSON.parse(raw) as { tabs?: unknown[] };
      return Array.isArray(session.tabs) && session.tabs.length > 0;
    } catch {
      return false;
    }
  }

  private async buildSceneIndex(
    files: WalkedFile[],
    mainScenePath: string | null
  ): Promise<HomeSceneEntry[]> {
    const sceneFiles = files.filter(f => f.name.toLowerCase().endsWith('.pix3scene'));
    const entries: HomeSceneEntry[] = [];

    for (const file of sceneFiles) {
      const relative = this.stripRes(file.path);
      const isMain = mainScenePath !== null && this.samePath(relative, mainScenePath);
      let nodeCount = 0;
      let modifiedAt = 0;
      try {
        const handle = await this.fileSystem.getFileHandle(this.toResourceId(relative));
        const osFile = await handle.getFile();
        modifiedAt = osFile.lastModified;
        nodeCount = this.countNodes(await osFile.text());
      } catch {
        // Leave defaults; a scene that can't be read still shows as a card.
      }
      entries.push({
        path: relative,
        resourceId: this.toResourceId(relative),
        name: this.baseName(file.name),
        isMain,
        isDraft: !isMain && nodeCount > 0 && nodeCount < 8,
        nodeCount,
        modifiedAt,
        sizeBytes: file.size,
      });
    }

    entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return entries;
  }

  private buildAtAGlance(files: WalkedFile[]): HomeAtAGlance {
    let assetCount = 0;
    let assetBytes = 0;
    let scriptCount = 0;

    for (const file of files) {
      const ext = this.ext(file.name);
      const lower = file.name.toLowerCase();
      if (IMAGE_EXTS.has(ext) || AUDIO_EXTS.has(ext) || MODEL_EXTS.has(ext) || FONT_EXTS.has(ext)) {
        assetCount += 1;
        assetBytes += file.size;
      } else if (
        ext === 'ts' &&
        !lower.endsWith('.spec.ts') &&
        !lower.endsWith('.test.ts') &&
        !lower.endsWith('.d.ts')
      ) {
        scriptCount += 1;
      }
    }

    return {
      assetCount,
      assetBytes,
      scriptCount,
      locales: appState.project.manifest?.localization?.locales ?? [],
      lastBuild: null,
    };
  }

  private buildChecklist(input: {
    scenes: HomeSceneEntry[];
    atAGlance: HomeAtAGlance;
    gdd: HomeGddInfo | null;
    mainScenePath: string | null;
  }): HomeChecklistItem[] {
    const { scenes, atAGlance, gdd, mainScenePath } = input;
    const hasMainScene = mainScenePath !== null || scenes.some(s => s.isMain) || scenes.length > 0;
    const isShared = appState.project.backend === 'cloud';

    return [
      { id: 'create-project', label: 'Create project', done: true },
      { id: 'import-assets', label: 'Import first assets', done: atAGlance.assetCount > 0 },
      { id: 'main-scene', label: 'Create a main scene', done: hasMainScene },
      {
        id: 'gdd',
        label: 'Write the game design doc',
        done: gdd !== null,
        action: 'draft-gdd',
      },
      {
        id: 'game-logic',
        label: 'Add game logic (a script)',
        done: atAGlance.scriptCount > 0,
        action: 'add-script',
      },
      {
        id: 'share',
        label: 'Share with the team',
        done: isShared,
        action: 'invite',
      },
    ];
  }

  private buildActivity(scenes: HomeSceneEntry[]): HomeActivityEntry[] {
    // No persistent operation journal exists yet; derive an honest feed from the
    // most recently modified scenes so the panel reflects real project state.
    return scenes
      .filter(s => s.modifiedAt > 0)
      .slice(0, 5)
      .map(scene => ({
        icon: 'film',
        text: `Scene ${scene.name} was last edited`,
        when: scene.modifiedAt,
      }));
  }

  private async loadGdd(files: WalkedFile[]): Promise<HomeGddInfo | null> {
    const byPath = new Map(files.map(f => [this.stripRes(f.path).toLowerCase(), f] as const));
    for (const candidate of GDD_CANDIDATES) {
      const match = byPath.get(candidate.toLowerCase());
      if (!match) continue;
      try {
        const relative = this.stripRes(match.path);
        const handle = await this.fileSystem.getFileHandle(this.toResourceId(relative));
        const osFile = await handle.getFile();
        const text = await osFile.text();
        return {
          path: relative,
          modifiedAt: osFile.lastModified,
          sections: this.parseGddSections(text),
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  private parseGddSections(markdown: string): GddSection[] {
    const lines = markdown.split(/\r?\n/);
    const sections: GddSection[] = [];
    let current: { title: string; body: string[] } | null = null;

    const flush = () => {
      if (!current) return;
      const body = current.body.join('\n').trim();
      let status: GddSectionStatus = 'ready';
      if (body.length === 0) {
        status = 'empty';
      } else if (body.length < 80 || /\bTODO\b|\bTBD\b|placeholder|<.*>/i.test(body)) {
        status = 'draft';
      }
      sections.push({ title: current.title, status });
      current = null;
    };

    for (const line of lines) {
      const heading = /^##\s+(.*)$/.exec(line.trim());
      if (heading) {
        flush();
        current = { title: heading[1].trim(), body: [] };
      } else if (current) {
        current.body.push(line);
      }
    }
    flush();
    return sections.slice(0, 8);
  }

  private async walkProject(): Promise<WalkedFile[]> {
    if (!this.fileSystem.getProjectDirectory()) {
      return [];
    }
    const out: WalkedFile[] = [];
    await this.walkDirectory('.', 0, out);
    return out;
  }

  private async walkDirectory(path: string, depth: number, out: WalkedFile[]): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;
    let entries: FileDescriptor[];
    try {
      entries = await this.fileSystem.listDirectory(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        if (PRUNED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await this.walkDirectory(entry.path, depth + 1, out);
      } else {
        out.push({ path: entry.path, name: entry.name, size: entry.size ?? 0 });
      }
    }
  }

  private countNodes(yaml: string): number {
    const matches = yaml.match(/^\s*-\s+id:\s/gm);
    return matches ? matches.length : 0;
  }

  private stripRes(path: string): string {
    let p = path.startsWith(RES_PREFIX) ? path.slice(RES_PREFIX.length) : path;
    p = p.replace(/^\.\//, '').replace(/^\/+/, '');
    return p;
  }

  private samePath(a: string, b: string): boolean {
    return this.stripRes(a).replace(/\\/g, '/') === this.stripRes(b).replace(/\\/g, '/');
  }

  private baseName(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '');
  }

  private ext(fileName: string): string {
    const idx = fileName.lastIndexOf('.');
    return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
  }
}
