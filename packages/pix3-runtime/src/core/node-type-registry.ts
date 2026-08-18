/**
 * The vocabulary of `type:` values a `.pix3scene` may use, plus the read-compat aliases and the
 * did-you-mean machinery around it.
 *
 * Why this exists as its own module: {@link SceneLoader} answers an unknown `type:` with an inert
 * `NodeBase` (a player must not crash on a scene authored by a newer editor), and that permissive
 * fallback is silent by design. Silence is fine when the cause is a version skew and fatal when
 * the cause is a typo — and typos here are close to unavoidable, because three spellings of the
 * same node are in circulation: the class is `DirectionalLightNode`, the on-disk type is
 * `DirectionalLightNode`, but the *in-memory* `node.type` is `DirectionalLight` (see the
 * `super(props, 'DirectionalLight')` calls), which is what a scene-tree dump shows. Anyone —
 * human or model — who reads a tree and writes YAML back lands on a name the loader does not know,
 * and gets a node that loads, saves, and does nothing.
 *
 * So: aliases make the guessable spellings work, and {@link suggestSceneNodeType} turns whatever is
 * left into an actionable message instead of a black screen.
 *
 * Pure data + string work — no node imports. It must stay that way: this module is reachable from
 * every player bundle, and a value import of a node class here would pin that class into every
 * export (see `strippable-runtime-modules.ts`).
 */

/**
 * Every `type:` the loader's switch handles, canonical spelling.
 *
 * Kept in sync with `SceneLoader.createNodeFromDefinition` by `node-type-registry.spec.ts`, which
 * re-reads the loader source and diffs its `case` labels against this list — adding a node type
 * without teaching the vocabulary about it fails there.
 */
export const KNOWN_SCENE_NODE_TYPES: readonly string[] = [
  // Containers / generic
  'Group',
  'Node2D',
  'Node3D',
  // 2D content
  'ColorRect2D',
  'Sprite2D',
  'TiledSprite2D',
  'AnimatedSprite2D',
  'SpineSkeleton2D',
  'Label2D',
  'Layout2D',
  'Group2D',
  'CanvasLayer2D',
  'Camera2D',
  // 2D UI
  'Button2D',
  'Slider2D',
  'Bar2D',
  'Checkbox2D',
  'Joystick2D',
  'ScrollContainer2D',
  'InventorySlot2D',
  // 3D content
  'GeometryMesh',
  'MeshInstance',
  'InstancedMesh3D',
  'Sprite3D',
  'AnimatedSprite3D',
  'Particles3D',
  // 3D lights
  'AmbientLightNode',
  'DirectionalLightNode',
  'HemisphereLightNode',
  'PointLightNode',
  'SpotLightNode',
  // Cameras / effects / audio
  'Camera3D',
  'VirtualCamera3D',
  'PostProcess',
  'AudioPlayer',
];

/** `Sprite 2D`, `sprite2d` and `Sprite2D` are the same lookup key. */
export const normalizeNodeTypeName = (nodeType: string): string =>
  nodeType.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Spellings accepted on *read* only, normalized key → canonical type.
 *
 * The light entries are the ones that matter: the un-suffixed forms are both what `node.type`
 * reports at runtime and what the rest of the catalogue (`Camera3D`, `Sprite3D`) teaches you to
 * guess. `SceneSaver` keeps writing the canonical `*Node` spelling, so a scene file never gains a
 * second way of saying the same thing — aliases resolve inbound and disappear on the next save.
 */
const NODE_TYPE_ALIASES: Readonly<Record<string, string>> = {
  ambientlight: 'AmbientLightNode',
  ambientlight3d: 'AmbientLightNode',
  directionallight: 'DirectionalLightNode',
  directionallight3d: 'DirectionalLightNode',
  hemispherelight: 'HemisphereLightNode',
  hemispherelight3d: 'HemisphereLightNode',
  pointlight: 'PointLightNode',
  pointlight3d: 'PointLightNode',
  spotlight: 'SpotLightNode',
  spotlight3d: 'SpotLightNode',
  // `MeshInstance3D` is what the editor's own create-node tooling calls this node.
  meshinstance3d: 'MeshInstance',
};

const CANONICAL_BY_NORMALIZED: ReadonlyMap<string, string> = new Map(
  KNOWN_SCENE_NODE_TYPES.map(type => [normalizeNodeTypeName(type), type])
);

/**
 * Canonical `type:` for a value read from a scene file, or `null` when nothing matches.
 *
 * Resolves case/separator variants and the alias table. A `null` return is the caller's cue to fall
 * back to an inert node *and* record a diagnostic — never to throw: refusing to load a scene
 * because one node is unrecognised would make a forward-version skew unrecoverable.
 */
export const resolveSceneNodeType = (nodeType: string | undefined | null): string | null => {
  if (typeof nodeType !== 'string' || nodeType.trim().length === 0) {
    return null;
  }
  const key = normalizeNodeTypeName(nodeType);
  return CANONICAL_BY_NORMALIZED.get(key) ?? NODE_TYPE_ALIASES[key] ?? null;
};

/** True for a `type:` the loader can actually build (aliases included). */
export const isKnownSceneNodeType = (nodeType: string | undefined | null): boolean =>
  resolveSceneNodeType(nodeType) !== null;

/** Normalized spelling → canonical type, for both the known names and their aliases. */
const SUGGESTION_CANDIDATES: ReadonlyArray<readonly [string, string]> = [
  ...KNOWN_SCENE_NODE_TYPES.map(type => [normalizeNodeTypeName(type), type] as const),
  ...Object.entries(NODE_TYPE_ALIASES),
];

/**
 * Nearest known type name for an unrecognised one, or `undefined` when nothing is close.
 *
 * Levenshtein over the *normalized* names with a distance of 2, which is wide enough for a dropped
 * suffix or a `3D`/`Node` mix-up and narrow enough that unrelated types never suggest each other.
 */
export const suggestSceneNodeType = (nodeType: string): string | undefined => {
  const key = normalizeNodeTypeName(nodeType);
  if (key.length === 0) {
    return undefined;
  }
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  // Alias keys are candidates too, and they are the ones that pay: a typo'd `DirectionalLite` is
  // one edit from the alias `directionallight` and five from the canonical `DirectionalLightNode`.
  for (const [candidateKey, canonical] of SUGGESTION_CANDIDATES) {
    const distance = editDistance(key, candidateKey);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = canonical;
    }
  }
  if (bestDistance <= 2) {
    return best;
  }

  // Levenshtein is the wrong tool for the commonest invention: an extra word. `DirectionalLightSource`
  // is six edits from any known name but contains one exactly, so fall back to the longest
  // containment match. The length floor keeps short names (`Bar2D`) from matching everything.
  let contained: string | undefined;
  let containedLength = 0;
  for (const [candidateKey, canonical] of SUGGESTION_CANDIDATES) {
    if (candidateKey.length < 5 || candidateKey.length <= containedLength) {
      continue;
    }
    if (key.includes(candidateKey) || candidateKey.includes(key)) {
      contained = canonical;
      containedLength = candidateKey.length;
    }
  }
  return contained;
};

/** One node the loader could not build, kept as data so the runtime stays UI-agnostic. */
export interface SceneNodeTypeDiagnostic {
  readonly nodeId: string;
  readonly nodeName: string;
  /** The unrecognised `type:` exactly as written in the scene file. */
  readonly unknownType: string;
  readonly suggestion?: string;
  /** Ready-to-show sentence; every surface (Logs, tool results) prints this. */
  readonly message: string;
}

/** Build the human-facing sentence for an unrecognised `type:`. */
export const describeUnknownNodeType = (
  nodeName: string,
  unknownType: string
): SceneNodeTypeDiagnostic['message'] => {
  const suggestion = suggestSceneNodeType(unknownType);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
  return `Unknown node type "${unknownType}" on node "${nodeName}" — it was loaded as an inert placeholder and does nothing.${hint}`;
};

/** Iterative Levenshtein; the inputs here are short type names, so the simple form is fine. */
const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
};
