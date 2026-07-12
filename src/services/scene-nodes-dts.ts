/**
 * Generates the ambient TypeScript declaration that gives the in-editor code
 * editor typed, autocompleting node names — `this.getNode('Hero')` resolves to
 * `Sprite2D`, à la Godot's `$Node` or WPF/WinForms `x:Name`.
 *
 * A Pix3 script type is many-to-many with scenes (the same component attaches
 * to nodes in different scenes), so there is no single "the" scene. Names are
 * drawn from the **union of all currently-loaded scenes**. To keep a script
 * reused in a scene that lacks a name valid, the runtime `getNode` overload
 * treats unknown strings as `NodeBase` — so these names are hints, never
 * constraints (see `Script.getNode` in `@pix3/runtime`).
 *
 * This module is pure and free of `monaco-editor` / DOM dependencies so it runs
 * in the default (happy-dom) Vitest suite.
 */

/** Duck-typed view of a runtime `NodeBase` — avoids importing the class. */
interface SceneNodeLike {
  readonly nodeId?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly children?: unknown;
}

interface ResolvedNode {
  /** Full slash-separated path of names from the scene root. */
  readonly path: string;
  /** Bare node name. */
  readonly name: string;
  /** Exported `@pix3/runtime` class name the node maps to. */
  readonly className: string;
}

const NODE_BASE = 'NodeBase';

/**
 * Build a `nodeType` string → exported class name map from the live runtime
 * exports, reading each class's static `getPropertySchema().nodeType`. Handles
 * the cases where the scene `type` differs from the class name (e.g.
 * `DirectionalLight` → `DirectionalLightNode`).
 */
function buildTypeIndex(runtimeExports: Record<string, unknown>): {
  typeToClassName: Map<string, string>;
  exportNames: Set<string>;
  ctorToName: Map<unknown, string>;
} {
  const typeToClassName = new Map<string, string>();
  const exportNames = new Set<string>();
  const ctorToName = new Map<unknown, string>();

  for (const [name, value] of Object.entries(runtimeExports)) {
    if (typeof value !== 'function') {
      continue;
    }
    exportNames.add(name);
    ctorToName.set(value, name);

    const getSchema = (value as { getPropertySchema?: unknown }).getPropertySchema;
    if (typeof getSchema !== 'function') {
      continue;
    }
    try {
      const schema = (getSchema as () => unknown).call(value);
      const nodeType = (schema as { nodeType?: unknown } | null)?.nodeType;
      if (typeof nodeType === 'string' && nodeType.length > 0 && !typeToClassName.has(nodeType)) {
        typeToClassName.set(nodeType, name);
      }
    } catch {
      // getPropertySchema may throw for non-node providers; ignore.
    }
  }

  return { typeToClassName, exportNames, ctorToName };
}

function resolveClassName(nodeType: unknown, index: ReturnType<typeof buildTypeIndex>): string {
  if (typeof nodeType !== 'string') {
    return NODE_BASE;
  }
  return (
    index.typeToClassName.get(nodeType) ?? (index.exportNames.has(nodeType) ? nodeType : NODE_BASE)
  );
}

/** Nearest common ancestor of two exported classes, by prototype chain. */
function commonBaseClassName(
  a: string,
  b: string,
  runtimeExports: Record<string, unknown>,
  ctorToName: Map<unknown, string>
): string {
  if (a === b) {
    return a;
  }
  const ctorA = runtimeExports[a];
  const ctorB = runtimeExports[b];
  if (typeof ctorA !== 'function' || typeof ctorB !== 'function') {
    return NODE_BASE;
  }

  const ancestorsA = new Set<unknown>();
  for (let c: unknown = ctorA; typeof c === 'function'; c = Object.getPrototypeOf(c)) {
    ancestorsA.add(c);
  }
  for (let c: unknown = ctorB; typeof c === 'function'; c = Object.getPrototypeOf(c)) {
    if (ancestorsA.has(c)) {
      const name = ctorToName.get(c);
      if (name) {
        return name;
      }
    }
  }
  return NODE_BASE;
}

function isSceneNode(value: unknown): value is SceneNodeLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SceneNodeLike).nodeId === 'string'
  );
}

function collectNodes(
  roots: readonly unknown[],
  index: ReturnType<typeof buildTypeIndex>
): ResolvedNode[] {
  const collected: ResolvedNode[] = [];

  const walk = (node: SceneNodeLike, parentPath: string): void => {
    const name = typeof node.name === 'string' && node.name.length > 0 ? node.name : '';
    if (!name) {
      // Unnamed node — still descend so named descendants are reachable.
    }
    const path = parentPath ? `${parentPath}/${name}` : name;
    if (name) {
      collected.push({ path, name, className: resolveClassName(node.type, index) });
    }

    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      if (isSceneNode(child)) {
        walk(child, path);
      }
    }
  };

  for (const root of roots) {
    if (isSceneNode(root)) {
      walk(root, '');
    }
  }

  return collected;
}

/**
 * Generate the ambient module-augmentation source for the union of the given
 * scene root-node trees. Returns a no-op module when there are no named nodes.
 *
 * @param sceneRoots Root-node arrays, one per loaded scene (e.g. the values of
 *   `appState.scenes.hierarchies[*].rootNodes`).
 * @param runtimeExports The live `@pix3/runtime` module namespace.
 */
export function generateSceneNodesLib(
  sceneRoots: readonly (readonly unknown[])[],
  runtimeExports: Record<string, unknown>
): string {
  const index = buildTypeIndex(runtimeExports);

  // path → className (widen on cross-scene conflict)
  const pathEntries = new Map<string, string>();
  // bare name → className, or null once it becomes ambiguous
  const nameEntries = new Map<string, string | null>();

  for (const roots of sceneRoots) {
    for (const node of collectNodes(roots, index)) {
      const existingPath = pathEntries.get(node.path);
      pathEntries.set(
        node.path,
        existingPath === undefined
          ? node.className
          : commonBaseClassName(existingPath, node.className, runtimeExports, index.ctorToName)
      );

      const existingName = nameEntries.get(node.name);
      if (existingName === undefined) {
        nameEntries.set(node.name, node.className);
      } else if (existingName !== null && existingName !== node.className) {
        // Same bare name, different types across the union → ambiguous. Drop it
        // so completion steers users to the unambiguous path form.
        nameEntries.set(node.name, null);
      }
    }
  }

  // Merge: prefer explicit path keys; add bare names only when unambiguous and
  // not already covered by an identical path (a root node's name === its path).
  const keyToClassName = new Map<string, string>();
  for (const [path, className] of pathEntries) {
    keyToClassName.set(path, className);
  }
  for (const [name, className] of nameEntries) {
    if (className !== null && !keyToClassName.has(name)) {
      keyToClassName.set(name, className);
    }
  }

  if (keyToClassName.size === 0) {
    return 'export {};\n';
  }

  const usedClasses = new Set<string>([NODE_BASE]);
  for (const className of keyToClassName.values()) {
    usedClasses.add(className);
  }

  const importList = Array.from(usedClasses).sort().join(', ');
  const members = Array.from(keyToClassName.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, className]) => `    ${JSON.stringify(key)}: ${className};`)
    .join('\n');

  return `// Generated by Pix3 — typed scene-node names for the in-editor code editor.
// Reflects the nodes in the currently-open scenes. Regenerated as scenes change.
import type { ${importList} } from '@pix3/runtime';

declare module '@pix3/runtime' {
  interface SceneNodeNames {
${members}
  }
}
`;
}
