/**
 * The Scene lane validation gate. The runtime {@link SceneManager.parseScene} already rejects YAML
 * syntax errors, empty docs, duplicate ids and bad prefab instances — but it does NOT reject unknown
 * node `type` strings (they fall through to a bare `NodeBase`) nor missing `res://` asset references
 * (those only `console.warn`). So this module adds those two deterministic checks on top of the parse
 * so a generated scene that names a non-existent node type or a palette asset that isn't in the
 * project is caught (and fed back to codegen) rather than silently producing a broken scene.
 *
 * Pure/async helpers only — no DI. The parse is delegated to an injected {@link SceneManager}.
 */

import { parse } from 'yaml';
import { SceneValidationError } from '@pix3/runtime';
import type { SceneManager, SceneGraph } from '@pix3/runtime';

/**
 * The authoritative allow-list of node `type` strings a generated `.pix3scene` may use. Kept in sync
 * with the runtime {@link import('@pix3/runtime').SceneLoader} switch. `Layout2D` is deliberately
 * excluded (it is a removed legacy type). Prefab instances carry `instance:` and no `type`, so they
 * are not checked against this set.
 */
export const ALLOWED_SCENE_NODE_TYPES: ReadonlySet<string> = new Set<string>([
  'Node3D',
  'Node2D',
  'Group',
  'Group2D',
  'CanvasLayer2D',
  'Camera3D',
  'VirtualCamera3D',
  'Camera2D',
  'GeometryMesh',
  'InstancedMesh3D',
  'MeshInstance',
  'Sprite3D',
  'AnimatedSprite3D',
  'Particles3D',
  'DirectionalLightNode',
  'PointLightNode',
  'SpotLightNode',
  'AmbientLightNode',
  'HemisphereLightNode',
  'PostProcess',
  'AudioPlayer',
  'ColorRect2D',
  'Sprite2D',
  'TiledSprite2D',
  'AnimatedSprite2D',
  'ScrollContainer2D',
  'Joystick2D',
  'Button2D',
  'Label2D',
  'Slider2D',
  'Bar2D',
  'Checkbox2D',
  'InventorySlot2D',
]);

/** Result of {@link validateSceneYaml}: `ok`, the collected errors, and the parsed graph when ok. */
export interface SceneValidationResult {
  ok: boolean;
  errors: string[];
  graph: SceneGraph | null;
}

/**
 * Normalize a `res://` (or plain, or Windows-slash) asset path to a canonical comparison key:
 * strips the `res://` prefix, converts backslashes to forward slashes, and drops a leading `./` /
 * `/`. Both the inventory (which builds the known set) and this gate run refs through it so they
 * agree regardless of how the LLM wrote the path.
 */
export function normalizeResPath(path: string): string {
  return path
    .replace(/\\+/g, '/')
    .replace(/^res:\/\//i, '')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .trim();
}

/**
 * Scan a RAW parsed scene document (a plain object, NOT the instantiated graph) for the two issues
 * `parseScene` does not catch:
 * - node `type` strings not in `allowed` (walking only the node tree: `root` + each node's
 *   `children`; component/material `type` fields are intentionally ignored);
 * - `res://` references (any string value, anywhere in the doc) whose normalized path is not in
 *   `knownPaths`.
 * Returns a flat list of human-readable errors (empty when clean). Exported for direct unit-testing
 * against a hand-built doc object.
 */
export function collectResAndTypeIssues(
  doc: unknown,
  allowed: ReadonlySet<string>,
  knownPaths: ReadonlySet<string>
): string[] {
  const errors: string[] = [];
  if (!isRecord(doc)) {
    return errors;
  }

  const root = (doc as { root?: unknown }).root;
  if (Array.isArray(root)) {
    for (const node of root) {
      collectNodeTypeIssues(node, allowed, errors);
    }
  }

  const seenRefs = new Set<string>();
  scanResRefs(doc, knownPaths, seenRefs, errors);

  return errors;
}

/**
 * Validate a generated scene YAML end-to-end:
 * 1. `await sceneManager.parseScene(yaml)` — on a {@link SceneValidationError} its `.details` (else
 *    the message) become errors and the graph is null;
 * 2. parse the raw YAML text ourselves and run {@link collectResAndTypeIssues} for the unknown-type
 *    and dangling-`res://` checks the runtime does not perform.
 * `ok` is true only when the parse succeeds AND no type/ref issues remain; `graph` is returned for
 * the caller to reuse (e.g. render a preview) without re-parsing.
 */
export async function validateSceneYaml(
  yaml: string,
  sceneManager: SceneManager,
  opts: { knownAssetPaths: ReadonlySet<string> }
): Promise<SceneValidationResult> {
  const errors: string[] = [];
  let graph: SceneGraph | null = null;

  try {
    graph = await sceneManager.parseScene(yaml);
  } catch (error) {
    if (error instanceof SceneValidationError) {
      errors.push(...(error.details.length ? error.details : [error.message]));
    } else {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Raw-doc checks run regardless of the parse outcome (they may catch issues the parse tolerated).
  let doc: unknown;
  try {
    doc = parse(yaml);
  } catch {
    // A YAML syntax error already surfaced through parseScene above; nothing more to add.
    doc = null;
  }
  errors.push(...collectResAndTypeIssues(doc, ALLOWED_SCENE_NODE_TYPES, opts.knownAssetPaths));

  const ok = errors.length === 0 && graph != null;
  return { ok, errors, graph: ok ? graph : null };
}

// -- internals ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walk a single node definition (and its `children`) collecting unknown-type errors. */
function collectNodeTypeIssues(
  node: unknown,
  allowed: ReadonlySet<string>,
  errors: string[]
): void {
  if (!isRecord(node)) {
    return;
  }

  // Prefab instances reference a `.pix3scene` via `instance:` and legitimately have no `type`.
  const hasInstance = typeof node.instance === 'string' && node.instance.trim().length > 0;
  const type = node.type;
  if (!hasInstance && typeof type === 'string' && !allowed.has(type)) {
    const id = typeof node.id === 'string' ? node.id : '(unknown id)';
    errors.push(`Node "${id}" uses an unknown node type "${type}".`);
  }

  const children = node.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      collectNodeTypeIssues(child, allowed, errors);
    }
  }
}

/** Recursively collect every `res://` string value whose normalized path is not in `knownPaths`. */
function scanResRefs(
  value: unknown,
  knownPaths: ReadonlySet<string>,
  seen: Set<string>,
  errors: string[]
): void {
  if (typeof value === 'string') {
    if (/^res:\/\//i.test(value.trim())) {
      const normalized = normalizeResPath(value);
      if (!knownPaths.has(normalized) && !seen.has(normalized)) {
        seen.add(normalized);
        errors.push(`Asset reference "${value}" does not exist in the project.`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      scanResRefs(entry, knownPaths, seen, errors);
    }
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      scanResRefs(entry, knownPaths, seen, errors);
    }
  }
}
