import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import { parse } from 'yaml';
import { SceneManager, UIControl2D } from '@pix3/runtime';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';

/** Directories scanned for project runtime scripts (mirrors ProjectBuildService). */
const PROJECT_SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;
/** Directory names never descended into during scene discovery. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'exports', '.git', '.yalc']);

/** A UIControl2D with a literal `label` and no `labelKey` — a localization gap. */
export interface UnlocalizedSceneLabel {
  scenePath: string;
  nodeId: string;
  nodeName: string;
  literal: string;
  /** Key the per-item Extract action will create (deduped against the default table). */
  suggestedKey: string;
  /** True when the node is addressable in the active scene graph, so Extract can
   *  set `labelKey` through the property operation. */
  extractable: boolean;
}

/** A key referenced by a script literal but absent from the default locale table. */
export interface MissingScriptKey {
  key: string;
  section: 'strings' | 'sprites';
  file: string;
  line: number;
}

export interface LocalizationExtractionReport {
  scannedScenes: number;
  scannedScripts: number;
  sceneLabels: UnlocalizedSceneLabel[];
  missingScriptKeys: MissingScriptKey[];
  /** Keys seeded as `""` placeholders per non-default locale by the extraction operation. */
  seededKeys: Record<string, string[]>;
}

/** Raw scene hit before key planning. */
export interface SceneLabelHit {
  nodeId: string;
  nodeName: string;
  literal: string;
}

/** Raw script localization-call hit. */
export interface ScriptKeyHit {
  fn: 'tr' | 'trSprite' | 'trPlural' | 'setTextKey';
  key: string;
  line: number;
}

/**
 * Project-wide localization gap scanner (the POT-extraction analog, design §4.5).
 * Read-only: finds UIControl2D `label:` literals without a `labelKey` in every
 * `.pix3scene` (the active scene is read from its live graph so unsaved edits are
 * honored) and `tr()`/`trSprite()`/`trPlural()`/`setTextKey()` string-literal keys
 * in project scripts that are missing from the default locale table. The report is
 * held here for the Localization panel; the undoable template seeding is applied
 * by `ExtractLocalizationKeysOperation` through `LocalizationEditorService`.
 */
@injectable()
export class LocalizationExtractionService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(LocalizationEditorService)
  private readonly localization!: LocalizationEditorService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  private report: LocalizationExtractionReport | null = null;
  private reportProjectId: string | null = null;

  getReport(): LocalizationExtractionReport | null {
    if (this.report && this.reportProjectId !== appState.project.id) return null;
    return this.report;
  }

  clearReport(): void {
    this.report = null;
    this.reportProjectId = null;
    this.bumpRevision();
  }

  /** Drop a scene-label item once it has been extracted (its gap is closed). */
  dismissSceneLabel(item: UnlocalizedSceneLabel): void {
    if (!this.report) return;
    this.report.sceneLabels = this.report.sceneLabels.filter(
      l => !(l.scenePath === item.scenePath && l.nodeId === item.nodeId)
    );
    this.bumpRevision();
  }

  /** Drop a missing-key item once it has been added to the default table. */
  dismissMissingKey(key: string): void {
    if (!this.report) return;
    this.report.missingScriptKeys = this.report.missingScriptKeys.filter(m => m.key !== key);
    this.bumpRevision();
  }

  /** Record what the extraction operation seeded, for the report summary. */
  setSeededKeys(seeded: Record<string, string[]>): void {
    if (!this.report) return;
    this.report.seededKeys = seeded;
    this.bumpRevision();
  }

  /** Run the project scan and store the report. Read-only (no table mutation). */
  async scan(): Promise<LocalizationExtractionReport> {
    const defaultLocale = this.localization.getDefaultLocale();
    const defaultStrings = new Map<string, string>();
    for (const key of this.localization.getAllKeys('strings')) {
      defaultStrings.set(key, this.localization.getEntry(defaultLocale, key, 'strings'));
    }
    const defaultSprites = new Set(this.localization.getAllKeys('sprites'));

    const { hitsByScene, scannedScenes } = await this.scanScenes();
    const sceneLabels = planSuggestedKeys(hitsByScene, defaultStrings);

    const { missingScriptKeys, scannedScripts } = await this.scanScripts(
      defaultStrings,
      defaultSprites
    );

    this.report = {
      scannedScenes,
      scannedScripts,
      sceneLabels,
      missingScriptKeys,
      seededKeys: {},
    };
    this.reportProjectId = appState.project.id;
    this.bumpRevision();
    return this.report;
  }

  // ---- scenes ---------------------------------------------------------------

  private async scanScenes(): Promise<{
    hitsByScene: Array<{ scenePath: string; extractable: boolean; hits: SceneLabelHit[] }>;
    scannedScenes: number;
  }> {
    const hitsByScene: Array<{ scenePath: string; extractable: boolean; hits: SceneLabelHit[] }> =
      [];

    const activeScenePath = this.getActiveScenePath();
    const scenePaths = await this.discoverFilesByExtension('.', '.pix3scene');
    let scannedScenes = 0;

    // The active scene is read from its live graph (unsaved edits are the truth
    // there, and only live nodes are addressable by the Extract property op).
    const activeGraph = this.sceneManager.getActiveSceneGraph();
    if (activeGraph && activeScenePath) {
      scannedScenes += 1;
      const hits: SceneLabelHit[] = [];
      for (const node of activeGraph.nodeMap.values()) {
        if (!(node instanceof UIControl2D)) continue;
        if (!node.label.trim() || node.labelKey.trim()) continue;
        hits.push({ nodeId: node.nodeId, nodeName: node.name, literal: node.label.trim() });
      }
      if (hits.length > 0) {
        hitsByScene.push({ scenePath: activeScenePath, extractable: true, hits });
      }
    }

    for (const scenePath of scenePaths) {
      if (normalizePath(scenePath) === activeScenePath) continue;
      scannedScenes += 1;
      try {
        const text = await this.storage.readTextFile(scenePath);
        const hits = scanSceneDefinitionText(text);
        if (hits.length > 0) {
          hitsByScene.push({ scenePath: normalizePath(scenePath), extractable: false, hits });
        }
      } catch {
        // Unreadable/unparsable scene — skip; the panel summary still counts it.
      }
    }

    return { hitsByScene, scannedScenes };
  }

  private getActiveScenePath(): string {
    const activeId = appState.scenes.activeSceneId;
    const descriptor = activeId ? appState.scenes.descriptors[activeId] : null;
    return descriptor ? normalizePath(descriptor.filePath) : '';
  }

  // ---- scripts --------------------------------------------------------------

  private async scanScripts(
    defaultStrings: ReadonlyMap<string, string>,
    defaultSprites: ReadonlySet<string>
  ): Promise<{ missingScriptKeys: MissingScriptKey[]; scannedScripts: number }> {
    const missing = new Map<string, MissingScriptKey>();
    let scannedScripts = 0;

    for (const dir of PROJECT_SCRIPT_DIRECTORIES) {
      const files = await this.discoverFilesByExtension(dir, '.ts');
      for (const file of files) {
        if (file.endsWith('.d.ts')) continue;
        scannedScripts += 1;
        let text: string;
        try {
          text = await this.storage.readTextFile(file);
        } catch {
          continue;
        }
        for (const hit of scanScriptText(text)) {
          const section = hit.fn === 'trSprite' ? 'sprites' : 'strings';
          const missingKey = resolveMissingKey(hit, defaultStrings, defaultSprites);
          if (!missingKey || missing.has(missingKey)) continue;
          missing.set(missingKey, { key: missingKey, section, file, line: hit.line });
        }
      }
    }

    return {
      missingScriptKeys: [...missing.values()].sort((a, b) => a.key.localeCompare(b.key)),
      scannedScripts,
    };
  }

  // ---- infrastructure -------------------------------------------------------

  private async discoverFilesByExtension(dir: string, extension: string): Promise<string[]> {
    const result: string[] = [];
    let entries: ReadonlyArray<{ name: string; kind: FileSystemHandleKind; path: string }>;
    try {
      entries = await this.storage.listDirectory(dir);
    } catch {
      return result;
    }
    for (const entry of entries) {
      if (entry.kind === 'file' && entry.path.endsWith(extension)) {
        result.push(entry.path);
      } else if (entry.kind === 'directory') {
        if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        result.push(...(await this.discoverFilesByExtension(entry.path, extension)));
      }
    }
    return result;
  }

  /** The report is UI state; reuse the localization revision counter the panel
   *  already subscribes to (same channel table edits use via mirrorSlice). */
  private bumpRevision(): void {
    appState.localization.revision += 1;
  }
}

// ---- pure scan helpers (exported for tests) ----------------------------------

interface SceneNodeDefinition {
  id?: unknown;
  name?: unknown;
  properties?: Record<string, unknown>;
  children?: unknown;
}

/** Find UIControl2D-style `label:` literals without a `labelKey` in scene YAML. */
export function scanSceneDefinitionText(text: string): SceneLabelHit[] {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return [];
  }
  const root = (parsed as { root?: unknown } | null)?.root;
  const hits: SceneLabelHit[] = [];
  walkSceneNodes(root, hits);
  return hits;
}

function walkSceneNodes(nodes: unknown, hits: SceneLabelHit[]): void {
  if (!Array.isArray(nodes)) return;
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as SceneNodeDefinition;
    const props = node.properties;
    if (props && typeof props === 'object') {
      const label = typeof props.label === 'string' ? props.label.trim() : '';
      const labelKey = typeof props.labelKey === 'string' ? props.labelKey.trim() : '';
      if (label && !labelKey && typeof node.id === 'string') {
        hits.push({
          nodeId: node.id,
          nodeName: typeof node.name === 'string' ? node.name : node.id,
          literal: label,
        });
      }
    }
    walkSceneNodes(node.children, hits);
  }
}

const SCRIPT_CALL_RE = /\b(tr|trSprite|trPlural|setTextKey)\s*\(\s*(['"`])([^'"`\r\n]+?)\2/g;

/** Find localization-call string-literal keys in script source. */
export function scanScriptText(text: string): ScriptKeyHit[] {
  const hits: ScriptKeyHit[] = [];
  SCRIPT_CALL_RE.lastIndex = 0;
  for (const match of text.matchAll(SCRIPT_CALL_RE)) {
    if (match[3].includes('${')) continue; // interpolated template literal — not a static key
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    hits.push({ fn: match[1] as ScriptKeyHit['fn'], key: match[3], line });
  }
  return hits;
}

/**
 * The key a hit requires but the default table lacks, or null when satisfied.
 * `trPlural` resolves through suffixed keys; `.other` is the mandatory fallback,
 * so that is what gets reported as missing.
 */
export function resolveMissingKey(
  hit: ScriptKeyHit,
  defaultStrings: ReadonlyMap<string, string>,
  defaultSprites: ReadonlySet<string>
): string | null {
  if (hit.fn === 'trSprite') {
    return defaultSprites.has(hit.key) ? null : hit.key;
  }
  if (hit.fn === 'trPlural') {
    const satisfied = ['other', 'one', 'few', 'many', 'two', 'zero'].some(suffix =>
      defaultStrings.has(`${hit.key}.${suffix}`)
    );
    return satisfied ? null : `${hit.key}.other`;
  }
  return defaultStrings.has(hit.key) ? null : hit.key;
}

/**
 * Assign a suggested key to every scene-label hit, deduped against the default
 * table and each other: identical literals share one key; a taken key with a
 * different value gets a numeric suffix; a key whose existing value equals the
 * literal is reused as-is.
 */
export function planSuggestedKeys(
  hitsByScene: ReadonlyArray<{ scenePath: string; extractable: boolean; hits: SceneLabelHit[] }>,
  defaultStrings: ReadonlyMap<string, string>
): UnlocalizedSceneLabel[] {
  const assignedByLiteral = new Map<string, string>();
  const taken = new Set(defaultStrings.keys());
  const labels: UnlocalizedSceneLabel[] = [];

  for (const scene of hitsByScene) {
    for (const hit of scene.hits) {
      let key = assignedByLiteral.get(hit.literal);
      if (!key) {
        const base = slugifyKey(hit.nodeName) || 'label';
        key = base;
        let counter = 2;
        while (taken.has(key) && defaultStrings.get(key) !== hit.literal) {
          key = `${base}.${counter}`;
          counter += 1;
        }
        taken.add(key);
        assignedByLiteral.set(hit.literal, key);
      }
      labels.push({
        scenePath: scene.scenePath,
        nodeId: hit.nodeId,
        nodeName: hit.nodeName,
        literal: hit.literal,
        suggestedKey: key,
        extractable: scene.extractable,
      });
    }
  }
  return labels;
}

/** "Play Button" → "play.button" (same shape the inspector Extract suggests). */
export function slugifyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

/** Strip `res://` / leading `./` so descriptor paths and discovered paths compare. */
function normalizePath(path: string): string {
  return path
    .replace(/^res:\/\//, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}
