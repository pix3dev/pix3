import * as runtime from '@pix3/runtime';
import {
  CURRENT_SCENE_FORMAT_VERSION,
  describeUnknownNodeType,
  getSceneNodeDiskFormat,
  INSTANCE_TRANSFORM_KEYS,
  isEmojiOnlyText,
  isTextProperty,
  normalizeNodeTypeName,
  resolveSceneDiskKey,
  resolveSceneNodeType,
  SCENE_COMPONENT_DEFINITION_KEYS,
  SCENE_DOCUMENT_KEYS,
  SCENE_NODE_DEFINITION_KEYS,
  suggestSceneNodeType,
  type PropertyDefinition,
  type PropertySchema,
  type SceneDiskKeyRule,
  type SceneNodeDiskFormat,
  type ScriptRegistry,
} from '@pix3/runtime';

import { diagnostic, type Diagnostic, type DiagnosticInput } from './diagnostics.ts';
import { toProjectPath, type ProjectFiles } from './project.ts';
import { nearest } from './suggest.ts';
import type { UserScriptIndex } from './user-scripts.ts';
import { checkDiskKindValue, checkPropertyValue, isResourceProperty } from './values.ts';
import {
  formatPath,
  isRecord,
  parseYamlWithLines,
  type DocPath,
  type ParsedYaml,
} from './yaml-doc.ts';

/**
 * Level 1 of `pix3 validate`: everything that can be decided from the files alone.
 *
 * The promise, stated precisely: **no project code runs and no DOM is needed.** Node types and
 * `core:` components are checked against the runtime's static `getPropertySchema()`s and the
 * disk-format table (`@pix3/runtime` `scene-disk-format.ts`); `user:` components are checked for
 * existence only, by reading `scripts/` — their property schema belongs to the user's TypeScript
 * class and is level 2's business.
 */

export interface Level1Environment {
  readonly project: ProjectFiles;
  /** `core:` components (`registerBuiltInScripts`). */
  readonly registry: ScriptRegistry;
  readonly userScripts: UserScriptIndex;
  readonly prefabs: PrefabCache;
}

export interface SceneCheckResult {
  readonly diagnostics: Diagnostic[];
  /** Every `res://` / resource path the scene references, project-relative (for unused assets). */
  readonly references: ReadonlySet<string>;
  /** Parsed document (null when the YAML did not parse). */
  readonly parsed: ParsedYaml | null;
  /** Whether any node carries a `user:` component. */
  readonly usesUserComponents: boolean;
}

// --- Schemas -------------------------------------------------------------------------------------

type SchemaClass = { getPropertySchema(): PropertySchema };

const runtimeExports = runtime as unknown as Record<string, unknown>;
const schemaCache = new Map<string, readonly PropertyDefinition[]>();

/** Static schema of a canonical scene type (DOM-free: a class's static method). */
export const schemaForType = (format: SceneNodeDiskFormat): readonly PropertyDefinition[] => {
  const cached = schemaCache.get(format.type);
  if (cached) return cached;
  const exported = runtimeExports[format.classExport] as Partial<SchemaClass> | undefined;
  const properties =
    typeof exported?.getPropertySchema === 'function'
      ? exported.getPropertySchema().properties
      : [];
  schemaCache.set(format.type, properties);
  return properties;
};

// --- Prefabs -------------------------------------------------------------------------------------

export type PrefabInfo =
  | { readonly ok: true; readonly roots: readonly unknown[] }
  | { readonly ok: false; readonly reason: 'missing' | 'unparsable' };

/** Prefab files read on demand (a validated scene's prefabs need not be in the validated set). */
export class PrefabCache {
  private readonly cache = new Map<string, PrefabInfo>();

  constructor(private readonly project: ProjectFiles) {}

  get(projectPath: string): PrefabInfo {
    const cached = this.cache.get(projectPath);
    if (cached) return cached;
    let info: PrefabInfo;
    if (!this.project.has(projectPath)) {
      info = { ok: false, reason: 'missing' };
    } else {
      const parsed = parseYamlWithLines(this.project.readText(projectPath));
      if ('errors' in parsed || !isRecord(parsed.data)) {
        info = { ok: false, reason: 'unparsable' };
      } else {
        const root = parsed.data.root;
        info = { ok: true, roots: Array.isArray(root) ? root : [] };
      }
    }
    this.cache.set(projectPath, info);
    return info;
  }

  /** Project paths of every `instance:` anywhere in a prefab's tree. */
  instanceTargets(projectPath: string): string[] {
    const info = this.get(projectPath);
    if (!info.ok) return [];
    const targets: string[] = [];
    const visit = (value: unknown): void => {
      if (!isRecord(value)) return;
      if (typeof value.instance === 'string') {
        const target = toProjectPath(value.instance);
        if (target) targets.push(target);
      }
      if (Array.isArray(value.children)) value.children.forEach(visit);
    };
    info.roots.forEach(visit);
    return targets;
  }

  /** A chain `from → … → from` when `from`'s prefab graph loops back through `stack`, else null. */
  findCycle(from: string, stack: readonly string[]): string[] | null {
    if (stack.includes(from)) return [...stack.slice(stack.indexOf(from)), from];
    const nextStack = [...stack, from];
    for (const target of this.instanceTargets(from)) {
      const cycle = this.findCycle(target, nextStack);
      if (cycle) return cycle;
    }
    return null;
  }

  /**
   * The node definition an instance resolves to (following instance-of-instance chains), or null
   * when a prefab is missing, unparsable, or has other than exactly one root.
   */
  effectiveDefinition(
    definition: Record<string, unknown>,
    seen: ReadonlySet<string> = new Set()
  ): Record<string, unknown> | null {
    if (typeof definition.instance !== 'string') return definition;
    const target = toProjectPath(definition.instance);
    if (!target || seen.has(target)) return null;
    const info = this.get(target);
    if (!info.ok || info.roots.length !== 1 || !isRecord(info.roots[0])) return null;
    return this.effectiveDefinition(info.roots[0], new Set([...seen, target]));
  }

  /** The local id the loader gives a prefab node: an instance takes its prefab root's id. */
  localIdOf(definition: Record<string, unknown>): string | null {
    const effective = this.effectiveDefinition(definition);
    return effective && typeof effective.id === 'string' ? effective.id : null;
  }
}

// --- The check -----------------------------------------------------------------------------------

const RES_PREFIX = /^res:\/\//i;

class SceneChecker {
  readonly diagnostics: Diagnostic[] = [];
  readonly references = new Set<string>();
  usesUserComponents = false;
  private readonly seenIds = new Map<string, string>();

  constructor(
    private readonly env: Level1Environment,
    private readonly file: string,
    private readonly parsed: ParsedYaml
  ) {}

  private report(input: Omit<DiagnosticInput, 'file' | 'line'> & { at?: DocPath }): void {
    const { at, ...rest } = input;
    this.diagnostics.push(
      diagnostic({
        ...rest,
        file: this.file,
        path: at ? formatPath(at) : rest.path,
        line: at ? this.parsed.lineOf(at) : undefined,
      })
    );
  }

  run(): void {
    const data = this.parsed.data;
    if (!isRecord(data)) {
      this.report({
        code: 'E_SHAPE',
        message: `A scene must be a YAML mapping with a root: list, got ${data === null ? 'an empty document' : typeof data}.`,
        fix: 'start the file with `version: 1.0.0` and `root:`',
        at: [],
      });
      return;
    }
    for (const key of Object.keys(data)) {
      if (!SCENE_DOCUMENT_KEYS.includes(key)) {
        this.report({
          code: 'E_SHAPE',
          message: `"${key}" is not a scene document key (allowed: ${SCENE_DOCUMENT_KEYS.join(', ')}); the loader ignores it.`,
          fix: key === 'nodes' || key === 'children' ? 'rename it to root:' : undefined,
          at: [key],
        });
      }
    }
    if (data.version === undefined) {
      this.report({
        code: 'W_LEGACY_VERSION',
        message: `The scene has no version:; the current format is ${CURRENT_SCENE_FORMAT_VERSION}.`,
        fix: `add version: ${CURRENT_SCENE_FORMAT_VERSION}`,
        at: [],
      });
    } else if (String(data.version) !== CURRENT_SCENE_FORMAT_VERSION) {
      this.report({
        code: 'W_LEGACY_VERSION',
        message: `Scene format version ${String(data.version)} is not the current ${CURRENT_SCENE_FORMAT_VERSION}; the loader has no migrations and reads it as ${CURRENT_SCENE_FORMAT_VERSION}.`,
        fix: `set version: ${CURRENT_SCENE_FORMAT_VERSION}`,
        at: ['version'],
      });
    }
    if (data.metadata !== undefined && data.metadata !== null && !isRecord(data.metadata)) {
      this.report({ code: 'E_SHAPE', message: 'metadata: must be a mapping.', at: ['metadata'] });
    }
    if (data.root === undefined || data.root === null) {
      this.report({
        code: 'E_SHAPE',
        message: 'The scene has no root: list — it would load as an empty scene.',
        fix: 'add root: with at least one node',
        at: [],
      });
      return;
    }
    if (!Array.isArray(data.root)) {
      this.report({
        code: 'E_SHAPE',
        message: `root: must be a list of nodes, got ${isRecord(data.root) ? 'a mapping' : typeof data.root}.`,
        fix: 'write each root node as a list item: root:\\n  - id: …',
        at: ['root'],
      });
      return;
    }
    data.root.forEach((node, index) => this.checkNode(node, ['root', index]));
  }

  // --- nodes -------------------------------------------------------------------------------------

  private checkNode(value: unknown, at: DocPath): void {
    if (!isRecord(value)) {
      this.report({
        code: 'E_SHAPE',
        message: `A node must be a mapping with at least id: and type:, got ${value === null ? 'null' : typeof value}.`,
        at,
      });
      return;
    }
    const id = typeof value.id === 'string' && value.id.trim().length > 0 ? value.id : undefined;
    if (id === undefined) {
      this.report({
        code: 'E_SHAPE',
        message:
          value.id === undefined
            ? 'The node has no id: — the loader accepts it with an undefined id, and a second one collides.'
            : `id: must be a non-empty string, got ${JSON.stringify(value.id)}.`,
        fix: 'give every node a unique string id:',
        at: value.id === undefined ? at : [...at, 'id'],
      });
    } else {
      const first = this.seenIds.get(id);
      if (first !== undefined) {
        this.report({
          code: 'E_DUPLICATE_ID',
          nodeId: id,
          message: `Duplicate node id "${id}" (first used at ${first}); the loader rejects the scene.`,
          fix: 'rename one of them',
          at: [...at, 'id'],
        });
      } else {
        this.seenIds.set(id, formatPath(at));
      }
    }
    const nodeId = id;
    for (const key of Object.keys(value)) {
      if (SCENE_NODE_DEFINITION_KEYS.includes(key)) continue;
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message: `"${key}" is not a node key (allowed: ${SCENE_NODE_DEFINITION_KEYS.join(', ')}); the loader ignores it.`,
        fix: `if it is a property, move it under properties:`,
        at: [...at, key],
      });
    }
    for (const key of ['name', 'type'] as const) {
      if (value[key] !== undefined && typeof value[key] !== 'string') {
        this.report({
          code: 'E_SHAPE',
          nodeId,
          message: `${key}: must be a string.`,
          at: [...at, key],
        });
      }
    }
    if (
      value.groups !== undefined &&
      !(Array.isArray(value.groups) && value.groups.every(g => typeof g === 'string'))
    ) {
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message: 'groups: must be a list of strings.',
        at: [...at, 'groups'],
      });
    }
    if (value.metadata !== undefined && value.metadata !== null && !isRecord(value.metadata)) {
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message: 'metadata: must be a mapping.',
        at: [...at, 'metadata'],
      });
    }
    const properties = value.properties;
    if (properties !== undefined && properties !== null && !isRecord(properties)) {
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message: `properties: must be a mapping, got ${Array.isArray(properties) ? 'a list' : typeof properties}.`,
        at: [...at, 'properties'],
      });
    }
    const propertyBag = isRecord(properties) ? properties : {};

    if (value.instance !== undefined) {
      this.checkInstanceNode(value, nodeId, propertyBag, at);
      return;
    }

    this.checkNodeType(value, nodeId, propertyBag, at);
    this.checkComponents(value.components, nodeId, at);
    if (value.children !== undefined && value.children !== null) {
      if (!Array.isArray(value.children)) {
        this.report({
          code: 'E_SHAPE',
          nodeId,
          message: `children: must be a list of nodes, got ${isRecord(value.children) ? 'a mapping' : typeof value.children}.`,
          at: [...at, 'children'],
        });
      } else {
        value.children.forEach((child, index) => this.checkNode(child, [...at, 'children', index]));
      }
    }
  }

  private checkNodeType(
    node: Record<string, unknown>,
    nodeId: string | undefined,
    properties: Record<string, unknown>,
    at: DocPath
  ): void {
    const authored = typeof node.type === 'string' ? node.type : undefined;
    // `SceneLoader`: no `type:` builds a Node3D.
    const canonical = authored === undefined ? 'Node3D' : resolveSceneNodeType(authored);
    if (canonical === 'Layout2D') {
      this.report({
        code: 'E_UNKNOWN_NODE_TYPE',
        nodeId,
        message: 'Layout2D is no longer supported; the loader rejects the scene.',
        fix: 'use a Group2D (or Node2D) with layout: anchors',
        at: [...at, 'type'],
      });
      return;
    }
    if (canonical === null) {
      const suggestion = authored ? suggestSceneNodeType(authored) : undefined;
      this.report({
        code: 'E_UNKNOWN_NODE_TYPE',
        nodeId,
        message: describeUnknownNodeType(String(node.name ?? nodeId ?? '?'), String(authored)),
        fix: suggestion ? `type: ${suggestion}` : undefined,
        at: [...at, 'type'],
      });
      return;
    }
    if (authored !== undefined && authored !== canonical) {
      const caseOnly = normalizeNodeTypeName(authored) === normalizeNodeTypeName(canonical);
      this.report({
        code: 'W_TYPE_CASE',
        nodeId,
        message: caseOnly
          ? `type: ${authored} loads as ${canonical}, but only because the loader forgives case and separators; the editor rewrites it on save.`
          : `type: ${authored} is a read-compat alias of ${canonical}; the editor rewrites it on save.`,
        fix: `type: ${canonical}`,
        at: [...at, 'type'],
      });
    }
    const format = getSceneNodeDiskFormat(canonical);
    if (!format) return;
    this.checkNodeProperties(format, properties, nodeId, [...at, 'properties']);
  }

  // --- properties (disk format) -----------------------------------------------------------------

  private checkNodeProperties(
    format: SceneNodeDiskFormat,
    properties: Record<string, unknown>,
    nodeId: string | undefined,
    at: DocPath
  ): void {
    const schema = schemaForType(format);
    for (const [key, value] of Object.entries(properties)) {
      const keyAt = [...at, key];
      const resolution = resolveSceneDiskKey(format, schema, key);
      switch (resolution.kind) {
        case 'schema':
          this.checkSchemaValue(resolution.property, value, nodeId, keyAt, key);
          break;
        case 'write-only':
          this.report({
            code: 'W_WRITE_ONLY_PROPERTY',
            nodeId,
            message: `${format.type}.${key} is saved by the editor but not read back by the loader, so it has no effect after a reload.`,
            at: keyAt,
          });
          break;
        case 'extra':
          this.checkRule(format, resolution.rule, value, nodeId, keyAt, key);
          break;
        case 'relocated':
          this.report({
            code: 'E_UNKNOWN_PROPERTY',
            nodeId,
            message: `${format.type} does not read "${key}" here — on disk it lives at ${resolution.diskPath}. As written it loads, is saved back, and does nothing.`,
            fix: `move it to properties.${resolution.diskPath}`,
            at: keyAt,
          });
          break;
        case 'not-stored':
          this.report({
            code: 'E_UNKNOWN_PROPERTY',
            nodeId,
            message: `"${key}" is not stored under properties: — ${resolution.reason}.`,
            fix:
              key === 'id' || key === 'name' || key === 'type' || key === 'groups'
                ? `move it up to the node entry (${key}:)`
                : 'remove it',
            at: keyAt,
          });
          break;
        case 'unknown': {
          const candidates = [
            ...schema
              .filter(p => resolveSceneDiskKey(format, schema, p.name).kind === 'schema')
              .map(p => p.name),
            ...Object.keys(format.extras),
          ];
          const suggestion = nearest(key, candidates);
          this.report({
            code: 'E_UNKNOWN_PROPERTY',
            nodeId,
            message: `${format.type} has no property "${key}"; the loader keeps it, saves it back, and nothing reads it.`,
            fix: suggestion ? `did you mean ${suggestion}?` : undefined,
            at: keyAt,
          });
          break;
        }
      }
      this.checkStrings(value, keyAt, nodeId);
    }
  }

  private checkRule(
    format: SceneNodeDiskFormat,
    rule: SceneDiskKeyRule,
    value: unknown,
    nodeId: string | undefined,
    at: DocPath,
    name: string
  ): void {
    if (rule.preferred) {
      this.report({
        code: 'W_LEGACY_KEY',
        nodeId,
        message: `${name} is a read-compat spelling; the editor saves it as ${rule.preferred}.`,
        fix: `rename to ${rule.preferred}`,
        at,
      });
    }
    const schema = schemaForType(format);
    const property = rule.schemaName ? schema.find(p => p.name === rule.schemaName) : undefined;
    if (property) {
      this.checkSchemaValue(property, value, nodeId, at, name);
    } else if (rule.kind) {
      const problem = checkDiskKindValue(rule.kind, value, name, rule.options);
      if (problem) this.report({ ...problem, nodeId, at });
      if (!problem && (rule.kind === 'texture' || rule.kind === 'resource-path')) {
        this.checkResourceValue(value, nodeId, at);
      }
    }
    if (rule.nested && isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        const childRule = rule.nested[key];
        const childAt = [...at, key];
        if (!childRule) {
          const suggestion = nearest(key, Object.keys(rule.nested));
          this.report({
            code: 'E_UNKNOWN_PROPERTY',
            nodeId,
            message: `${name}.${key} is not read by the loader (known: ${Object.keys(rule.nested).join(', ')}).`,
            fix: suggestion ? `did you mean ${name}.${suggestion}?` : undefined,
            at: childAt,
          });
          continue;
        }
        this.checkRule(format, childRule, child, nodeId, childAt, `${name}.${key}`);
      }
    }
  }

  private checkSchemaValue(
    property: PropertyDefinition,
    value: unknown,
    nodeId: string | undefined,
    at: DocPath,
    name: string
  ): void {
    const problem = checkPropertyValue(property, value, name);
    if (problem) {
      this.report({ ...problem, nodeId, at });
      return;
    }
    if (isResourceProperty(property)) this.checkResourceValue(value, nodeId, at);
  }

  /** A resource-typed value written without `res://` (the generic walk covers `res://` strings). */
  private checkResourceValue(value: unknown, nodeId: string | undefined, at: DocPath): void {
    const reference =
      typeof value === 'string'
        ? value
        : isRecord(value) && typeof value.url === 'string'
          ? value.url
          : null;
    if (!reference || RES_PREFIX.test(reference) || reference.trim() === '') return;
    this.checkReference(reference, nodeId, isRecord(value) ? [...at, 'url'] : at);
  }

  private checkReference(reference: string, nodeId: string | undefined, at: DocPath): void {
    const target = toProjectPath(reference);
    if (!target) return;
    this.references.add(target);
    if (this.env.project.has(target)) return;
    const caseMatch = this.env.project.files.find(
      file => file.toLowerCase() === target.toLowerCase()
    );
    this.report({
      code: 'E_MISSING_RESOURCE',
      nodeId,
      message: `${reference} does not exist in the project.`,
      fix: caseMatch ? `the file is res://${caseMatch} (case differs)` : undefined,
      at,
    });
  }

  /** Every string below `value`: `res://` existence and the emoji-as-art guard. */
  private checkStrings(value: unknown, at: DocPath, nodeId: string | undefined): void {
    if (typeof value === 'string') {
      if (RES_PREFIX.test(value)) this.checkReference(value, nodeId, at);
      const key = [...at]
        .reverse()
        .find((segment): segment is string => typeof segment === 'string');
      if (key && isTextProperty(key) && isEmojiOnlyText(value)) {
        this.report({
          code: 'E_EMOJI_AS_ART',
          nodeId,
          message: `${key} is ${value.trim()} — nothing but emoji, i.e. a picture standing in for art. It draws differently on every platform, cannot be recoloured, atlased or animated, and is a hollow box where the font lacks it.`,
          fix: 'use a Sprite2D with a generated sprite (or a ColorRect2D placeholder); an emoji inside a sentence is fine',
          at,
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.checkStrings(item, [...at, index], nodeId));
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value))
        this.checkStrings(child, [...at, key], nodeId);
    }
  }

  // --- components --------------------------------------------------------------------------------

  private checkComponents(components: unknown, nodeId: string | undefined, at: DocPath): void {
    if (components === undefined || components === null) return;
    const listAt = [...at, 'components'];
    if (!Array.isArray(components)) {
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message: `components: must be a list, got ${isRecord(components) ? 'a mapping' : typeof components}.`,
        fix: 'write each component as a list item: components:\\n  - type: core:Rotate',
        at: listAt,
      });
      return;
    }
    components.forEach((component, index) =>
      this.checkComponent(component, nodeId, [...listAt, index])
    );
  }

  private checkComponent(component: unknown, nodeId: string | undefined, at: DocPath): void {
    if (!isRecord(component)) {
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message: 'A component must be a mapping with type:.',
        at,
      });
      return;
    }
    for (const key of Object.keys(component)) {
      if (!SCENE_COMPONENT_DEFINITION_KEYS.includes(key)) {
        this.report({
          code: 'E_SHAPE',
          nodeId,
          message: `"${key}" is not a component key (allowed: ${SCENE_COMPONENT_DEFINITION_KEYS.join(', ')}).`,
          fix: 'component settings go under config:',
          at: [...at, key],
        });
      }
    }
    const type = component.type;
    if (typeof type !== 'string' || type.trim() === '') {
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message: 'The component has no type: — the loader parks it as an unregistered component.',
        fix: 'add type: core:<Name> or user:<ExportedClass>',
        at,
      });
      return;
    }
    if (component.enabled !== undefined && typeof component.enabled !== 'boolean') {
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message: 'enabled: must be true or false.',
        at: [...at, 'enabled'],
      });
    }
    if (component.id !== undefined && typeof component.id !== 'string') {
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message: 'A component id: must be a string.',
        at: [...at, 'id'],
      });
    }
    const config = component.config;
    if (config !== undefined && config !== null && !isRecord(config)) {
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message: 'config: must be a mapping.',
        at: [...at, 'config'],
      });
    }
    const configBag = isRecord(config) ? config : {};
    this.checkStrings(configBag, [...at, 'config'], nodeId);

    if (type.startsWith('core:')) {
      const info = this.env.registry.getComponentType(type);
      if (!info) {
        const suggestion = nearest(
          type,
          this.env.registry.getAllComponentTypes().map(entry => entry.id)
        );
        this.report({
          code: 'E_UNKNOWN_COMPONENT',
          nodeId,
          message: `${type} is not a built-in component; the loader parks it and it never runs.`,
          fix: suggestion ? `type: ${suggestion}` : undefined,
          at: [...at, 'type'],
        });
        return;
      }
      const schema = this.env.registry.getComponentPropertySchema(type)?.properties ?? [];
      this.checkConfig(type, schema, configBag, nodeId, [...at, 'config']);
      return;
    }
    if (type.startsWith('user:')) {
      this.usesUserComponents = true;
      if (this.env.userScripts.ids.has(type)) return;
      if (this.env.userScripts.opaqueEntries.length > 0) return; // `export * from` — cannot tell
      const suggestion = nearest(type, this.env.userScripts.ids.keys());
      const exportName = type.slice('user:'.length);
      this.report({
        code: 'E_USER_SCRIPT_NOT_FOUND',
        nodeId,
        message: `No script under scripts/ (or src/scripts/) exports a Script class named ${exportName}; the component would stay unregistered. The id is the EXPORT name, and the file must contain "extends Script".`,
        fix: suggestion
          ? `type: ${suggestion}`
          : `create scripts/${exportName}.ts with export class ${exportName} extends Script`,
        at: [...at, 'type'],
      });
      return;
    }
    this.report({
      code: 'E_UNKNOWN_COMPONENT',
      nodeId,
      message: `Component type "${type}" has no namespace: built-ins are core:<Name>, project scripts user:<ExportedClass>.`,
      fix: this.env.registry.getComponentType(`core:${type}`)
        ? `type: core:${type}`
        : `type: user:${type}`,
      at: [...at, 'type'],
    });
  }

  /** Config keys and values against a component schema (core: at level 1, user: at level 2). */
  checkConfig(
    type: string,
    schema: readonly PropertyDefinition[],
    config: Record<string, unknown>,
    nodeId: string | undefined,
    at: DocPath
  ): void {
    for (const [key, value] of Object.entries(config)) {
      const property = schema.find(candidate => candidate.name === key);
      if (!property) {
        const suggestion = nearest(
          key,
          schema.map(p => p.name)
        );
        this.report({
          code: 'E_UNKNOWN_CONFIG_KEY',
          nodeId,
          message: `${type} has no setting "${key}" (declared: ${schema.map(p => p.name).join(', ') || 'none'}); it is kept and ignored.`,
          fix: suggestion ? `did you mean ${suggestion}?` : undefined,
          at: [...at, key],
        });
        continue;
      }
      this.checkSchemaValue(property, value, nodeId, [...at, key], key);
    }
  }

  // --- instances ---------------------------------------------------------------------------------

  private checkInstanceNode(
    node: Record<string, unknown>,
    nodeId: string | undefined,
    properties: Record<string, unknown>,
    at: DocPath
  ): void {
    for (const key of ['children', 'components'] as const) {
      if (node[key] !== undefined) {
        this.report({
          code: 'E_SHAPE',
          nodeId,
          message: `${key}: on an instance node is ignored — the node's content comes from the prefab.`,
          fix: `move them into the prefab, or wrap the instance in a parent node`,
          at: [...at, key],
        });
      }
    }
    if (typeof node.instance !== 'string' || node.instance.trim() === '') {
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message: 'instance: must be a res:// path to a .pix3scene prefab.',
        at: [...at, 'instance'],
      });
      return;
    }
    const target = toProjectPath(node.instance);
    const instanceAt = [...at, 'instance'];
    if (!target || !this.env.project.has(target)) {
      this.report({
        code: 'E_MISSING_PREFAB',
        nodeId,
        message: `Prefab ${node.instance} does not exist; the loader fails the whole scene.`,
        at: instanceAt,
      });
      return;
    }
    this.references.add(target);
    const cycle = this.env.prefabs.findCycle(target, [this.file]);
    if (cycle) {
      this.report({
        code: 'E_PREFAB_CYCLE',
        nodeId,
        message: `Prefab instances form a cycle: ${cycle.join(' -> ')}.`,
        at: instanceAt,
      });
      return;
    }
    const info = this.env.prefabs.get(target);
    if (!info.ok) return; // unparsable: reported when that file itself is validated
    if (info.roots.length !== 1) {
      this.report({
        code: 'E_PREFAB_ROOT',
        nodeId,
        message: `Prefab ${node.instance} has ${info.roots.length} root nodes; an instanced prefab must have exactly one.`,
        at: instanceAt,
      });
      return;
    }
    const prefabRoot = isRecord(info.roots[0]) ? info.roots[0] : null;
    const rootDefinition = prefabRoot ? this.env.prefabs.effectiveDefinition(prefabRoot) : null;
    if (rootDefinition) {
      this.checkInstanceProperties(rootDefinition, properties, nodeId, [...at, 'properties']);
    }
    this.checkOverrides(node.overrides, prefabRoot, nodeId, [...at, 'overrides']);
  }

  /** Instance / override properties: schema names in schema-value form, plus `transform`. */
  private checkInstanceProperties(
    target: Record<string, unknown>,
    properties: Record<string, unknown>,
    nodeId: string | undefined,
    at: DocPath
  ): void {
    const canonical =
      typeof target.type === 'string' ? resolveSceneNodeType(target.type) : 'Node3D';
    const format = canonical ? getSceneNodeDiskFormat(canonical) : null;
    if (!format) return;
    const schema = schemaForType(format);
    for (const [key, value] of Object.entries(properties)) {
      const keyAt = [...at, key];
      this.checkStrings(value, keyAt, nodeId);
      if (key === 'transform') {
        if (!isRecord(value)) {
          this.report({
            code: 'E_PROPERTY_TYPE',
            nodeId,
            message: 'transform must be a mapping.',
            at: keyAt,
          });
          continue;
        }
        for (const [transformKey, transformValue] of Object.entries(value)) {
          const schemaName = INSTANCE_TRANSFORM_KEYS[transformKey];
          const property = schemaName ? schema.find(p => p.name === schemaName) : undefined;
          if (!property) {
            this.report({
              code: 'E_UNKNOWN_PROPERTY',
              nodeId,
              message: `transform.${transformKey} is not applied to an instance (known: ${Object.keys(INSTANCE_TRANSFORM_KEYS).join(', ')}).`,
              at: [...keyAt, transformKey],
            });
            continue;
          }
          this.checkSchemaValue(
            property,
            transformValue,
            nodeId,
            [...keyAt, transformKey],
            `transform.${transformKey}`
          );
        }
        continue;
      }
      const property = schema.find(p => p.name === key);
      if (!property) {
        const suggestion = nearest(
          key,
          schema.map(p => p.name)
        );
        this.report({
          code: 'E_UNKNOWN_PROPERTY',
          nodeId,
          message: `The prefab's ${format.type} has no property "${key}"; on an instance (and in overrides) properties are the node's schema names.`,
          fix: suggestion ? `did you mean ${suggestion}?` : undefined,
          at: keyAt,
        });
        continue;
      }
      this.checkSchemaValue(property, value, nodeId, keyAt, key);
    }
  }

  private checkOverrides(
    overrides: unknown,
    prefabRoot: Record<string, unknown> | null,
    nodeId: string | undefined,
    at: DocPath
  ): void {
    if (overrides === undefined || overrides === null) return;
    if (
      !isRecord(overrides) ||
      (overrides.byLocalId !== undefined && !isRecord(overrides.byLocalId))
    ) {
      this.report({
        code: 'E_SHAPE',
        nodeId,
        message:
          'overrides: must be a mapping of the form { byLocalId: { <node path>: { properties: … } } }.',
        at,
      });
      return;
    }
    const byLocalId = isRecord(overrides.byLocalId) ? overrides.byLocalId : {};
    for (const [localId, entry] of Object.entries(byLocalId)) {
      const entryAt = [...at, 'byLocalId', localId];
      if (!isRecord(entry) || (entry.properties !== undefined && !isRecord(entry.properties))) {
        this.report({
          code: 'E_SHAPE',
          nodeId,
          message: 'An override entry must be { properties: { … } }.',
          at: entryAt,
        });
        continue;
      }
      if (!prefabRoot) continue;
      const target = this.resolveOverrideTarget(prefabRoot, localId);
      if (target === undefined) continue; // could not resolve the prefab chain; level 2 decides
      if (target === null) {
        this.report({
          code: 'E_UNKNOWN_OVERRIDE_TARGET',
          nodeId,
          message: `The prefab has no node at "${localId}"; the loader warns and drops this override.`,
          fix: 'override keys are node ids from the prefab root, joined with / for nested nodes',
          at: entryAt,
        });
        continue;
      }
      this.checkInstanceProperties(
        target,
        isRecord(entry.properties) ? entry.properties : {},
        nodeId,
        [...entryAt, 'properties']
      );
    }
  }

  /**
   * The prefab node an override key names (`SceneLoader.applyInstanceOverrides`): a `/`-joined path
   * of local ids below the prefab root, where an instance node's local id is its own prefab root's
   * id. `null` = no such node; `undefined` = a prefab in the chain could not be read.
   */
  private resolveOverrideTarget(
    prefabRoot: Record<string, unknown>,
    key: string
  ): Record<string, unknown> | null | undefined {
    const prefabs = this.env.prefabs;
    const rootLocal = prefabs.localIdOf(prefabRoot);
    const root = prefabs.effectiveDefinition(prefabRoot);
    if (!rootLocal || !root) return undefined;
    const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    const attempts = [normalized.split('/')];
    if (normalized === rootLocal) return root;
    if (normalized.startsWith(`${rootLocal}/`))
      attempts.push(normalized.slice(rootLocal.length + 1).split('/'));
    for (const segments of attempts) {
      let current: Record<string, unknown> | null = root;
      for (const segment of segments) {
        const children: unknown[] = Array.isArray(current?.children) ? current.children : [];
        let next: Record<string, unknown> | null = null;
        for (const child of children) {
          if (!isRecord(child)) continue;
          const local = prefabs.localIdOf(child);
          if (local === null && typeof child.instance === 'string') return undefined;
          if (local === segment) {
            next = prefabs.effectiveDefinition(child);
            break;
          }
        }
        current = next;
        if (!current) break;
      }
      if (current) return current;
    }
    return null;
  }
}

/** Level 1 over one scene file. */
export const checkSceneLevel1 = (
  env: Level1Environment,
  file: string,
  text: string
): SceneCheckResult => {
  const parsed = parseYamlWithLines(text);
  if ('errors' in parsed) {
    return {
      diagnostics: parsed.errors.map(error =>
        diagnostic({
          code: 'E_YAML',
          file,
          line: error.line,
          message: `YAML does not parse: ${error.message}`,
        })
      ),
      references: new Set(),
      parsed: null,
      usesUserComponents: false,
    };
  }
  const checker = new SceneChecker(env, file, parsed);
  checker.run();
  return {
    diagnostics: checker.diagnostics,
    references: checker.references,
    parsed,
    usesUserComponents: checker.usesUserComponents,
  };
};

/** Level 2 reuses the config check once `user:` schemas exist. */
export const checkComponentConfig = (
  env: Level1Environment,
  file: string,
  parsed: ParsedYaml,
  type: string,
  schema: readonly PropertyDefinition[],
  config: Record<string, unknown>,
  nodeId: string | undefined,
  at: DocPath
): Diagnostic[] => {
  const checker = new SceneChecker(env, file, parsed);
  checker.checkConfig(type, schema, config, nodeId, at);
  return checker.diagnostics;
};
