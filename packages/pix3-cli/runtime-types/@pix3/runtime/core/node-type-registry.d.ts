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
export declare const KNOWN_SCENE_NODE_TYPES: readonly string[];
/** `Sprite 2D`, `sprite2d` and `Sprite2D` are the same lookup key. */
export declare const normalizeNodeTypeName: (nodeType: string) => string;
/**
 * Canonical `type:` for a value read from a scene file, or `null` when nothing matches.
 *
 * Resolves case/separator variants and the alias table. A `null` return is the caller's cue to fall
 * back to an inert node *and* record a diagnostic — never to throw: refusing to load a scene
 * because one node is unrecognised would make a forward-version skew unrecoverable.
 */
export declare const resolveSceneNodeType: (nodeType: string | undefined | null) => string | null;
/** True for a `type:` the loader can actually build (aliases included). */
export declare const isKnownSceneNodeType: (nodeType: string | undefined | null) => boolean;
/**
 * Nearest known type name for an unrecognised one, or `undefined` when nothing is close.
 *
 * Levenshtein over the *normalized* names with a distance of 2, which is wide enough for a dropped
 * suffix or a `3D`/`Node` mix-up and narrow enough that unrelated types never suggest each other.
 */
export declare const suggestSceneNodeType: (nodeType: string) => string | undefined;
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
export declare const describeUnknownNodeType: (nodeName: string, unknownType: string) => SceneNodeTypeDiagnostic["message"];
