import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { isRecord } from '../validate/yaml-doc.ts';

/**
 * `pix3 tree` model: a `.pix3scene` read as plain YAML — no loader, no hydration, no project code —
 * reduced to what an agent needs to find its way around a scene without reading the whole file.
 *
 * Defaults (for `--props`) are an input, not computed here: they need the runtime's node classes,
 * which live in the smoke bundle (`defaults.ts`). Without them every authored property is shown.
 */

export interface TreeComponent {
  readonly type: string;
  readonly id?: string;
  readonly enabled: boolean;
}

export interface TreeInstance {
  /** As written (`res://…`). */
  readonly path: string;
  /** The prefab's own root type/name, when the prefab file could be read. */
  readonly rootType?: string;
  readonly rootName?: string;
  /** Overrides of nodes INSIDE the prefab: every `overrides.byLocalId.*.properties` key. */
  readonly overrides: number;
  /** The instance node's own `properties` keys (applied to the prefab root). */
  readonly properties: number;
}

export interface TreeNode {
  readonly id: string;
  /** Authored `type:` (for an instance: the prefab root's, or null when unreadable). */
  readonly type: string | null;
  readonly name?: string;
  readonly depth: number;
  readonly position?: readonly number[];
  readonly size?: readonly [number, number];
  /** `horizontalAlign/verticalAlign`, only when `layout.enabled`. */
  readonly layout?: string;
  /** `properties.visible: false` (hidden in the editor). */
  readonly hidden?: boolean;
  /** Caption of a label/button (`properties.label`). */
  readonly text?: string;
  readonly groups?: readonly string[];
  readonly components: readonly TreeComponent[];
  readonly instance?: TreeInstance;
  /** Non-default properties (`--props`), flattened one level (`transform.scale`). */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Printed only as an ancestor of a `--types` match. */
  readonly context?: boolean;
  /** Descendants not shown because of `--depth`. */
  readonly hiddenBelow?: number;
  readonly children: readonly TreeNode[];
}

/** Per authored type: file key path → default value (plain JSON), from `defaults.ts`. */
export type TypeDefaults = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface TreeOptions {
  readonly depth?: number;
  readonly types?: readonly string[];
  readonly props?: boolean;
  readonly defaults?: TypeDefaults;
  /** Reads a prefab (`instance:` target, project-relative) — for its root type and name. */
  readonly readPrefab?: (projectPath: string) => string | null;
}

export class SceneParseError extends Error {}

export const parseSceneText = (text: string): Record<string, unknown> => {
  let data: unknown;
  try {
    data = parseYaml(text, { maxAliasCount: 1000 }) as unknown;
  } catch (error) {
    throw new SceneParseError(
      `not valid YAML: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`
    );
  }
  if (!isRecord(data) || !Array.isArray(data.root)) {
    throw new SceneParseError('not a .pix3scene (no `root:` list)');
  }
  return data;
};

export const readSceneFile = (absolutePath: string): Record<string, unknown> =>
  parseSceneText(readFileSync(absolutePath, 'utf8'));

/** `res://a/b.pix3scene` → `a/b.pix3scene` (null for other schemes). */
export const resToProjectPath = (reference: string): string | null => {
  const trimmed = reference.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'res') return null;
  return trimmed.replace(/^res:\/\//i, '').replace(/^\/+/, '') || null;
};

const numbers = (value: unknown): number[] | null => {
  if (Array.isArray(value) && value.every(v => typeof v === 'number')) return value as number[];
  if (isRecord(value) && typeof value.x === 'number' && typeof value.y === 'number') {
    return ['x', 'y', 'z', 'w']
      .filter(a => typeof value[a] === 'number')
      .map(a => value[a] as number);
  }
  return null;
};

const round = (value: number): number => Math.round(value * 1e4) / 1e4;

const plain = (value: unknown): unknown => {
  if (typeof value === 'number') return round(value);
  const vector = numbers(value);
  if (vector) return vector.map(round);
  return value;
};

const looksLikeColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value);

const expandColor = (hex: string): string =>
  hex.length === 4
    ? `#${[...hex.slice(1)].map(c => c + c).join('')}`.toLowerCase()
    : hex.toLowerCase();

/** Authored value equals the type's default (vectors by value, colours by hex, numbers ±1e-6). */
export const isDefaultValue = (authored: unknown, fallback: unknown): boolean => {
  if (fallback === undefined) return false;
  const a = plain(authored);
  const b = plain(fallback);
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => isDefaultValue(v, b[i]));
  }
  if (looksLikeColor(a) && looksLikeColor(b)) return expandColor(a) === expandColor(b);
  if (a === null || typeof a !== 'object') return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
};

/** Keys the summary line already shows (never repeated under `--props`). */
const SUMMARY_KEYS = new Set(['transform.position', 'position', 'width', 'height', 'label']);

/** `properties:` flattened one level: `transform: { scale }` → `transform.scale`. */
const flatten = (properties: Record<string, unknown>): Array<[string, unknown]> => {
  const out: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(properties)) {
    const isTextureRef = isRecord(value) && typeof value.url === 'string';
    if (isRecord(value) && !isTextureRef && numbers(value) === null) {
      for (const [nested, nestedValue] of Object.entries(value))
        out.push([`${key}.${nested}`, nestedValue]);
    } else {
      out.push([key, value]);
    }
  }
  return out;
};

const nonDefaultProps = (
  properties: Record<string, unknown>,
  defaults: Readonly<Record<string, unknown>> | undefined,
  layoutShown: boolean,
  hiddenShown: boolean
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [path, value] of flatten(properties)) {
    if (SUMMARY_KEYS.has(path)) continue;
    if (
      layoutShown &&
      (path === 'layout.enabled' ||
        path === 'layout.horizontalAlign' ||
        path === 'layout.verticalAlign')
    )
      continue;
    if (hiddenShown && path === 'visible') continue;
    const fallback = defaults?.[path];
    if (defaults && isDefaultValue(value, fallback)) continue;
    out[path] = plain(value);
  }
  return out;
};

/**
 * The two counts an instance line shows, kept apart: `overrides` reaches into the prefab
 * (`overrides.byLocalId`), `properties` is the instance node's own block. They used to be one
 * number, so an instance with `properties: { visible: false }` and no `overrides:` block read
 * "(1 override)" — and an agent went looking for an override block that did not exist.
 */
const countInstanceEdits = (
  definition: Record<string, unknown>
): { overrides: number; properties: number } => {
  const properties = isRecord(definition.properties)
    ? Object.keys(definition.properties).length
    : 0;
  let overrides = 0;
  const byLocalId = isRecord(definition.overrides) ? definition.overrides.byLocalId : undefined;
  if (isRecord(byLocalId)) {
    for (const entry of Object.values(byLocalId)) {
      overrides +=
        isRecord(entry) && isRecord(entry.properties) ? Object.keys(entry.properties).length : 1;
    }
  }
  return { overrides, properties };
};

const prefabRoot = (
  reference: string,
  readPrefab: TreeOptions['readPrefab']
): { type?: string; name?: string } => {
  const projectPath = resToProjectPath(reference);
  if (!projectPath || !readPrefab) return {};
  const text = readPrefab(projectPath);
  if (text === null) return {};
  try {
    const root = parseSceneText(text).root as unknown[];
    const first = root[0];
    if (!isRecord(first)) return {};
    return {
      ...(typeof first.type === 'string' ? { type: first.type } : {}),
      ...(typeof first.name === 'string' ? { name: first.name } : {}),
    };
  } catch {
    return {};
  }
};

const normalizeType = (type: string): string => type.toLowerCase().replace(/[^a-z0-9]/g, '');

const countDescendants = (definition: Record<string, unknown>): number => {
  const children = Array.isArray(definition.children) ? definition.children : [];
  return children.reduce<number>(
    (sum, child) => sum + (isRecord(child) ? 1 + countDescendants(child) : 0),
    0
  );
};

/** Build the tree of one parsed scene. */
export const buildTree = (
  scene: Record<string, unknown>,
  options: TreeOptions = {}
): TreeNode[] => {
  const wanted =
    options.types && options.types.length > 0 ? new Set(options.types.map(normalizeType)) : null;

  const build = (definition: unknown, depth: number): TreeNode | null => {
    if (!isRecord(definition)) return null;
    const properties = isRecord(definition.properties) ? definition.properties : {};
    const instancePath = typeof definition.instance === 'string' ? definition.instance : undefined;
    const root = instancePath ? prefabRoot(instancePath, options.readPrefab) : {};
    const type = typeof definition.type === 'string' ? definition.type : (root.type ?? null);
    const transform = isRecord(properties.transform) ? properties.transform : {};
    const position = numbers(transform.position ?? properties.position);
    const width = properties.width;
    const height = properties.height;
    const layout = isRecord(properties.layout) ? properties.layout : null;
    const layoutText =
      layout && layout.enabled === true
        ? `${String(layout.horizontalAlign ?? 'none')}/${String(layout.verticalAlign ?? 'none')}`
        : undefined;
    const hidden = properties.visible === false;
    const components: TreeComponent[] = (
      Array.isArray(definition.components) ? definition.components : []
    )
      .filter(isRecord)
      .filter(component => typeof component.type === 'string')
      .map(component => ({
        type: component.type as string,
        ...(typeof component.id === 'string' ? { id: component.id } : {}),
        enabled: component.enabled !== false,
      }));
    const groups = Array.isArray(definition.groups)
      ? definition.groups.filter((g): g is string => typeof g === 'string')
      : [];

    const childDefinitions = Array.isArray(definition.children) ? definition.children : [];
    const atDepthLimit = options.depth !== undefined && depth >= options.depth;
    const children = atDepthLimit
      ? []
      : childDefinitions
          .map(child => build(child, depth + 1))
          .filter((c): c is TreeNode => c !== null);
    const matches =
      wanted === null ||
      (type !== null && wanted.has(normalizeType(type))) ||
      (instancePath !== undefined && wanted.has('instance')) ||
      components.some(c => wanted.has(normalizeType(c.type)));
    if (!matches && children.length === 0) return null;

    const props =
      options.props === true
        ? instancePath
          ? Object.fromEntries(
              flatten(properties)
                .filter(([key]) => !(hidden && key === 'visible') && !SUMMARY_KEYS.has(key))
                .map(([key, value]) => [key, plain(value)])
            )
          : nonDefaultProps(
              properties,
              type ? options.defaults?.[type] : undefined,
              layoutText !== undefined,
              hidden
            )
        : undefined;
    const hiddenBelow = atDepthLimit ? countDescendants(definition) : 0;
    return {
      id: typeof definition.id === 'string' ? definition.id : '?',
      type,
      ...(typeof definition.name === 'string' ? { name: definition.name } : {}),
      depth,
      ...(position ? { position: position.map(round) } : {}),
      ...(typeof width === 'number' && typeof height === 'number'
        ? { size: [round(width), round(height)] as const }
        : {}),
      ...(layoutText ? { layout: layoutText } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(typeof properties.label === 'string' ? { text: properties.label } : {}),
      ...(groups.length > 0 ? { groups } : {}),
      components,
      ...(instancePath
        ? {
            instance: {
              path: instancePath,
              ...(root.type ? { rootType: root.type } : {}),
              ...(root.name ? { rootName: root.name } : {}),
              ...countInstanceEdits(definition),
            },
          }
        : {}),
      ...(props && Object.keys(props).length > 0 ? { props } : {}),
      ...(matches ? {} : { context: true }),
      ...(hiddenBelow > 0 ? { hiddenBelow } : {}),
      children,
    };
  };

  return (scene.root as unknown[])
    .map(node => build(node, 0))
    .filter((n): n is TreeNode => n !== null);
};

// --- Formatting -----------------------------------------------------------------------------------

const quote = (text: string, max = 40): string => {
  const oneLine = text.replace(/\s+/g, ' ');
  return JSON.stringify(oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine);
};

export const formatValue = (value: unknown): string => {
  if (typeof value === 'string')
    return /^[\w#./:-]+$/.test(value) && value.length > 0 ? value : quote(value, 60);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  const vector = numbers(value);
  if (vector) return `(${vector.map(round).join(',')})`;
  if (isRecord(value) && typeof value.url === 'string') return value.url;
  const json = JSON.stringify(value) ?? String(value);
  return json.length > 80 ? `${json.slice(0, 79)}…` : json;
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export const formatNodeLine = (node: TreeNode): string => {
  const parts: string[] = [];
  const head = `${node.type ?? (node.instance ? 'Instance' : '?')}#${node.id}`;
  parts.push(
    node.name !== undefined && node.name !== node.id ? `${head} ${quote(node.name)}` : head
  );
  if (node.instance) {
    const { overrides, properties } = node.instance;
    const edits = [
      ...(overrides > 0 ? [plural(overrides, 'override')] : []),
      ...(properties > 0 ? [`${properties} ${properties === 1 ? 'property' : 'properties'}`] : []),
    ];
    parts.push(
      `↳ instance ${node.instance.path} (${edits.length > 0 ? edits.join(', ') : 'no overrides'})`
    );
  }
  if (node.text !== undefined) parts.push(`text=${quote(node.text, 28)}`);
  if (node.position && node.position.some(v => v !== 0))
    parts.push(`pos=(${node.position.join(',')})`);
  if (node.size) parts.push(`size=${node.size[0]}x${node.size[1]}`);
  if (node.layout) parts.push(`layout=${node.layout}`);
  if (node.hidden) parts.push('hidden');
  if (node.groups) parts.push(`groups=[${node.groups.join(',')}]`);
  let line = parts.join(' ');
  if (node.components.length > 0) {
    line += `  components=[${node.components.map(c => (c.enabled ? c.type : `${c.type}(off)`)).join(', ')}]`;
  }
  if (node.hiddenBelow) line += `  … +${node.hiddenBelow} below`;
  return line;
};

export const formatTree = (nodes: readonly TreeNode[]): string => {
  const lines: string[] = [];
  const visit = (node: TreeNode): void => {
    const indent = '  '.repeat(node.depth);
    lines.push(`${indent}${node.context ? '· ' : ''}${formatNodeLine(node)}`);
    if (node.props) {
      const props = Object.entries(node.props).map(
        ([key, value]) => `${key}=${formatValue(value)}`
      );
      if (props.length > 0) lines.push(`${indent}    ${props.join(' ')}`);
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
};

export const countTreeNodes = (nodes: readonly TreeNode[]): number =>
  nodes.reduce((sum, node) => sum + 1 + countTreeNodes(node.children), 0);

/** Every authored type in a scene (for fetching defaults once). */
export const sceneTypes = (scene: Record<string, unknown>): string[] => {
  const types = new Set<string>();
  const visit = (definition: unknown): void => {
    if (!isRecord(definition)) return;
    if (typeof definition.type === 'string') types.add(definition.type);
    if (Array.isArray(definition.children)) definition.children.forEach(visit);
  };
  (scene.root as unknown[]).forEach(visit);
  return [...types].sort();
};

// --- Project overview -----------------------------------------------------------------------------

export interface SceneSummary {
  readonly path: string;
  readonly kind: 'scene' | 'prefab' | 'overlay';
  readonly entry: boolean;
  readonly nodes: number;
  readonly types: Readonly<Record<string, number>>;
  readonly components: Readonly<Record<string, number>>;
  readonly instances: readonly string[];
  readonly error?: string;
}

export const summarizeScene = (
  path: string,
  text: string
): Omit<SceneSummary, 'kind' | 'entry'> => {
  let scene: Record<string, unknown>;
  try {
    scene = parseSceneText(text);
  } catch (error) {
    return {
      path,
      nodes: 0,
      types: {},
      components: {},
      instances: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const types: Record<string, number> = {};
  const components: Record<string, number> = {};
  const instances = new Set<string>();
  let nodes = 0;
  const visit = (definition: unknown): void => {
    if (!isRecord(definition)) return;
    nodes += 1;
    if (typeof definition.instance === 'string') {
      const target = resToProjectPath(definition.instance);
      if (target) instances.add(target);
    } else if (typeof definition.type === 'string') {
      types[definition.type] = (types[definition.type] ?? 0) + 1;
    }
    if (Array.isArray(definition.components)) {
      for (const component of definition.components) {
        if (isRecord(component) && typeof component.type === 'string') {
          components[component.type] = (components[component.type] ?? 0) + 1;
        }
      }
    }
    if (Array.isArray(definition.children)) definition.children.forEach(visit);
  };
  (scene.root as unknown[]).forEach(visit);
  return { path, nodes, types, components, instances: [...instances].sort() };
};

const byCount = (counts: Readonly<Record<string, number>>): Array<[string, number]> =>
  Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

export const formatSceneSummary = (summary: SceneSummary, width: number): string => {
  const label = `${summary.path}${summary.entry ? ' *' : ''}`.padEnd(width);
  if (summary.error) return `${label}  UNPARSABLE: ${summary.error}`;
  const types = byCount(summary.types)
    .map(([type, count]) => (count > 1 ? `${type}×${count}` : type))
    .join(' ');
  const parts = [
    `${label}  ${summary.kind.padEnd(7)} ${String(summary.nodes).padStart(3)} ${summary.nodes === 1 ? 'node ' : 'nodes'}  ${types}`,
  ];
  const components = Object.keys(summary.components).sort();
  if (components.length > 0)
    parts.push(`${' '.repeat(width + 2)}components: ${components.join(' ')}`);
  if (summary.instances.length > 0)
    parts.push(`${' '.repeat(width + 2)}instances: ${summary.instances.join(' ')}`);
  return parts.join('\n');
};
