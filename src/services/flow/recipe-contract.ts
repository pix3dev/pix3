import { parse, parseDocument, isSeq, isMap } from 'yaml';

/**
 * The machine-readable half of a Flow recipe: the `design/recipe.md` contract
 * (`.plans/flow-recipes-contract.md` §4) plus the scene surgery the expander performs against it.
 *
 * Everything here is pure text/YAML work with no DI and no I/O, for two reasons. It runs **before
 * the project's first scene is ever loaded** — patching the copied files on disk rather than
 * mutating a live scene graph is what keeps the expander free of races, operations and undo entries
 * (contract §5) — and it is the layer most likely to drift as recipes are authored, so it has to be
 * testable without a browser, a project or a model.
 */

/** One declared tuning point: a property on a node (or on a component of that node). */
export interface RecipeTunable {
  readonly key: string;
  /** Stable node id inside the recipe's scenes. */
  readonly node: string;
  /** Component type (`user:PlayerController`) when the value lives in a component's config. */
  readonly component?: string;
  readonly property: string;
  readonly min?: number;
  readonly max?: number;
  readonly default?: unknown;
}

/** A neutral placeholder sprite and the role it plays, from the `## Placeholders` table. */
export interface RecipePlaceholder {
  readonly role: string;
  /** Project-relative file path (`sprites/ph-player.png`). */
  readonly file: string;
  /** Node id or prefab the sprite is used by (documentation only — the tint works on the file). */
  readonly target: string;
}

/**
 * Pull the fenced YAML block that declares `tunables:` out of `design/recipe.md`.
 *
 * Scans every fenced block rather than trusting a heading, because the heading text is the one part
 * of the contract a recipe author is most likely to reword; the `tunables:` key is not. Malformed
 * YAML yields an empty map — an unparseable recipe must degrade to "no tunables are declared", so
 * the project still expands, rather than failing the whole flow.
 */
export const parseRecipeTunables = (markdown: string): Map<string, RecipeTunable> => {
  const result = new Map<string, RecipeTunable>();
  for (const block of fencedBlocks(markdown)) {
    if (!/^\s*tunables\s*:/m.test(block)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parse(block);
    } catch {
      continue;
    }
    const tunables = (parsed as { tunables?: unknown } | null)?.tunables;
    if (!tunables || typeof tunables !== 'object') {
      continue;
    }
    for (const [key, raw] of Object.entries(tunables as Record<string, unknown>)) {
      const tunable = toTunable(key, raw);
      if (tunable) {
        result.set(key, tunable);
      }
    }
  }
  return result;
};

const toTunable = (key: string, raw: unknown): RecipeTunable | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const node = typeof entry.node === 'string' ? entry.node.trim() : '';
  const property = typeof entry.property === 'string' ? entry.property.trim() : '';
  if (!node || !property) {
    return null;
  }
  const component = typeof entry.component === 'string' ? entry.component.trim() : undefined;
  return {
    key,
    node,
    property,
    ...(component ? { component } : {}),
    ...(typeof entry.min === 'number' ? { min: entry.min } : {}),
    ...(typeof entry.max === 'number' ? { max: entry.max } : {}),
    ...('default' in entry ? { default: entry.default } : {}),
  };
};

/** Rows of the `## Placeholders` markdown table (`role | file | node/prefab`). */
export const parseRecipePlaceholders = (markdown: string): RecipePlaceholder[] => {
  const section = markdownSection(markdown, 'Placeholders');
  if (!section) {
    return [];
  }
  const placeholders: RecipePlaceholder[] = [];
  for (const line of section.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map(cell => cell.trim());
    if (cells.length < 2) continue;
    const [role, file, target = ''] = cells;
    // Skip the header row and its `---` separator.
    if (!file || /^-{2,}$/.test(file) || /^file$/i.test(file)) continue;
    placeholders.push({
      role: role.toLowerCase().replace(/`/g, ''),
      file: file.replace(/[`*]/g, '').replace(/^res:\/\//i, '').trim(),
      target: target.replace(/[`*]/g, ''),
    });
  }
  return placeholders;
};

/** Body of a `## <title>` section, up to the next heading of the same-or-higher level. */
const markdownSection = (markdown: string, title: string): string | null => {
  const pattern = new RegExp(`^#{1,4}\\s*${title}\\s*$`, 'im');
  const match = pattern.exec(markdown);
  if (!match) {
    return null;
  }
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = /^#{1,4}\s+\S/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
};

function* fencedBlocks(markdown: string): Generator<string> {
  const fence = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    yield match[1];
  }
}

// -- applying a brief's tunables --------------------------------------------

export interface AppliedTunable {
  readonly tunable: RecipeTunable;
  readonly value: number | string | boolean;
  /** True when the requested number was outside the declared range and was pulled back into it. */
  readonly clamped: boolean;
  /** The value the brief asked for, when it differs from {@link value}. */
  readonly requested?: number | string | boolean;
}

export interface TunableResolution {
  readonly applied: readonly AppliedTunable[];
  /** Keys the recipe does not declare. Recorded in `design/brief.md`, never guessed at. */
  readonly unknown: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
  /** Declared keys whose requested value had the wrong type to be usable. */
  readonly rejected: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
}

/**
 * Match a brief's `tunables` against what the recipe declares.
 *
 * Three outcomes, and the split is the whole point: a declared key is clamped into its documented
 * range and applied; an **unknown key is never guessed at** — a model that invents
 * `enemySpawnRate` for a recipe with no spawner must not have that silently written into some
 * plausible-looking node — it is handed to the agent as text in `design/brief.md`, which is exactly
 * the kind of judgement the agent's first increment exists to make; and a declared key whose value
 * has the wrong type is rejected rather than coerced.
 */
export const resolveTunables = (
  requested: Readonly<Record<string, unknown>>,
  declared: ReadonlyMap<string, RecipeTunable>
): TunableResolution => {
  const applied: AppliedTunable[] = [];
  const unknown: Array<{ key: string; value: unknown }> = [];
  const rejected: Array<{ key: string; reason: string }> = [];

  for (const [key, value] of Object.entries(requested ?? {})) {
    const tunable = declared.get(key);
    if (!tunable) {
      unknown.push({ key, value });
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        rejected.push({ key, reason: 'not a finite number' });
        continue;
      }
      const clampedValue = clampTunable(tunable, value);
      applied.push({
        tunable,
        value: clampedValue,
        clamped: clampedValue !== value,
        ...(clampedValue !== value ? { requested: value } : {}),
      });
      continue;
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
      applied.push({ tunable, value, clamped: false });
      continue;
    }
    rejected.push({ key, reason: `unsupported value type (${typeof value})` });
  }

  return { applied, unknown, rejected };
};

/** Pull a number into the tunable's declared `min`/`max` (either bound may be absent). */
export const clampTunable = (tunable: RecipeTunable, value: number): number => {
  let result = value;
  if (typeof tunable.min === 'number') {
    result = Math.max(tunable.min, result);
  }
  if (typeof tunable.max === 'number') {
    result = Math.min(tunable.max, result);
  }
  return result;
};

// -- scene patching ----------------------------------------------------------

export interface ScenePatch {
  /** Stable node id to patch. */
  readonly node: string;
  /** Component type when the value lives in a component's `config`. */
  readonly component?: string;
  readonly property: string;
  readonly value: unknown;
}

export interface ScenePatchResult {
  /** The scene text, re-serialized only when something actually changed. */
  readonly text: string;
  readonly applied: readonly ScenePatch[];
  /** Patches whose node (or component) is not in this scene — normal when a project has several. */
  readonly missing: readonly ScenePatch[];
}

/**
 * Set properties on nodes of a `.pix3scene`, addressing them by their stable `id`.
 *
 * Edits the YAML **document** rather than a re-serialized plain object so the recipe's comments,
 * key order and formatting survive: these files are read by humans and by the agent, and a scene
 * that silently lost its explanatory header on project creation would be a bad first impression and
 * a worse diff. An unmatched node is reported, never created — the id space belongs to the recipe.
 */
export const applyScenePatches = (
  sceneText: string,
  patches: readonly ScenePatch[]
): ScenePatchResult => {
  if (patches.length === 0) {
    return { text: sceneText, applied: [], missing: [] };
  }
  const doc = parseDocument(sceneText);
  if (doc.errors.length > 0) {
    return { text: sceneText, applied: [], missing: patches };
  }
  const js = doc.toJS() as unknown;
  const applied: ScenePatch[] = [];
  const missing: ScenePatch[] = [];

  for (const patch of patches) {
    const nodePath = findNodePath(js, patch.node);
    if (!nodePath) {
      missing.push(patch);
      continue;
    }
    const targetPath = patch.component
      ? componentConfigPath(js, nodePath, patch.component)
      : [...nodePath, 'properties'];
    if (!targetPath) {
      missing.push(patch);
      continue;
    }
    doc.setIn([...targetPath, patch.property], patch.value);
    applied.push(patch);
  }

  return { text: applied.length > 0 ? String(doc) : sceneText, applied, missing };
};

type NodePath = ReadonlyArray<string | number>;

/** Depth-first search for a node with `id`, returning the index path into the document. */
const findNodePath = (scene: unknown, nodeId: string): NodePath | null => {
  const root = (scene as { root?: unknown } | null)?.root;
  if (Array.isArray(root)) {
    for (let index = 0; index < root.length; index += 1) {
      const found = walkNode(root[index], ['root', index], nodeId);
      if (found) return found;
    }
    return null;
  }
  if (root && typeof root === 'object') {
    return walkNode(root, ['root'], nodeId);
  }
  return null;
};

const walkNode = (node: unknown, path: NodePath, nodeId: string): NodePath | null => {
  if (!node || typeof node !== 'object') {
    return null;
  }
  const record = node as Record<string, unknown>;
  if (record.id === nodeId) {
    return path;
  }
  const children = record.children;
  if (Array.isArray(children)) {
    for (let index = 0; index < children.length; index += 1) {
      const found = walkNode(children[index], [...path, 'children', index], nodeId);
      if (found) return found;
    }
  }
  return null;
};

/** Path to a component's `config` map, matched on component `type` (falling back to its `id`). */
const componentConfigPath = (
  scene: unknown,
  nodePath: NodePath,
  component: string
): NodePath | null => {
  const node = valueAt(scene, nodePath) as Record<string, unknown> | null;
  const components = node?.components;
  if (!Array.isArray(components)) {
    return null;
  }
  const index = components.findIndex(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    return record.type === component || record.id === component;
  });
  return index >= 0 ? [...nodePath, 'components', index, 'config'] : null;
};

const valueAt = (root: unknown, path: NodePath): unknown => {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
};

/** True when a parsed YAML document looks like a scene we can patch (used by callers to skip files). */
export const looksLikeScene = (sceneText: string): boolean => {
  try {
    const doc = parseDocument(sceneText);
    if (doc.errors.length > 0) return false;
    const root = doc.get('root');
    return isSeq(root) || isMap(root);
  } catch {
    return false;
  }
};

// -- palette → roles ---------------------------------------------------------

/**
 * Which palette colour a placeholder role gets.
 *
 * Fixed, ordered assignment rather than anything clever: the palette arrives sorted by coverage
 * (see `extractPalette`), so index 0 is the reference's dominant colour — right for the background
 * and wrong for the player, who needs to pop against it. The player therefore takes the *last*
 * (least-covering, usually the accent) colour, hazards the second accent, and everything else walks
 * the middle of the ramp. Same brief in, same colours out.
 */
export const paletteColorForRole = (role: string, palette: readonly string[]): string | null => {
  if (palette.length === 0) {
    return null;
  }
  const last = palette[palette.length - 1];
  const at = (index: number): string => palette[Math.min(index, palette.length - 1)];
  switch (normalizeRole(role)) {
    case 'background':
      return palette[0];
    case 'player':
      return last;
    case 'enemy':
    case 'obstacle':
    case 'hazard':
      return palette.length > 1 ? palette[palette.length - 2] : last;
    case 'collectible':
    case 'pickup':
      return at(1);
    case 'ui':
    case 'hud':
      return at(2);
    default:
      return at(1);
  }
};

const normalizeRole = (role: string): string => role.trim().toLowerCase().replace(/[\s_-]+/g, '');
