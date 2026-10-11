import { Object3D } from 'three';
import type { PropertySchema } from '../fw/property-schema';
import type { ComponentDefinition } from '../core/component-hydration';
import type { ScriptComponent } from '../core/ScriptComponent';
import type { SceneService } from '../core/SceneService';
export interface NodeMetadata {
    [key: string]: unknown;
}
export interface NodeBaseProps {
    id: string;
    type?: string;
    name?: string;
    instancePath?: string | null;
    groups?: string[];
    properties?: Record<string, unknown>;
    metadata?: NodeMetadata;
}
export interface SignalConnection {
    target: unknown;
    method: (...args: unknown[]) => void;
}
export declare class NodeBase extends Object3D {
    readonly nodeId: string;
    readonly type: string;
    name: string;
    children: NodeBase[];
    readonly properties: Record<string, unknown>;
    readonly metadata: NodeMetadata;
    private _instancePath;
    /** Whether this node can have children. */
    isContainer: boolean;
    /** Script components attached to this node */
    readonly components: ScriptComponent[];
    /**
     * Authored components whose script type was not registered when this node was built — parked
     * here instead of dropped, so a later save cannot delete them from the scene file and
     * `resolvePendingComponents` can attach them once the type appears. See
     * `core/component-hydration.ts`.
     */
    readonly pendingComponents: ComponentDefinition[];
    /** Groups associated with this node */
    readonly groups: Set<string>;
    /**
     * The node's OWN authored visibility — what `visible: …` in the `.pix3scene` says and what a
     * script means when it writes `node.visible = false`. Read it through {@link authoredVisible};
     * `visible` itself is an accessor that folds in the editor's Peek mask (see the
     * `Object.defineProperty` block below the class).
     *
     * Public because that accessor lives on the prototype, outside the class body — a `private`
     * field would be unreachable from there. Not part of the runtime's supported surface.
     *
     * @internal
     */
    _selfVisible: boolean;
    /**
     * Editor Peek mask: "the author does not want to look at this right now". Set by the editor's
     * `PeekService` on branch ROOTS only (three.js already skips a hidden subtree at render time) and
     * pushed into a play session via {@link import('../core/SceneRunner').SceneRunner.setEditorPeekMask}.
     *
     * **Never serialized.** It is per-user session state, not scene content: `SceneSaver` reads
     * `properties.visible` / {@link authoredVisible}, both of which this flag leaves untouched, so a
     * masked scene saves byte-for-byte identically to an unmasked one. It also does not survive
     * serialize→parse, which is why a play clone has to be told the mask from outside.
     *
     * This is the ONLY Peek flag the runtime carries, and it is here for two reasons the editor
     * cannot supply: the `visible` accessor below reads it, and a play clone has to honour it. Peek's
     * other channel — the "solo" fade — is editor-viewport-only and lives editor-side in
     * `src/services/viewport/peek-gating.ts`.
     */
    hiddenByEditor: boolean;
    private readonly _signals;
    private _disposed;
    /**
     * True once {@link dispose} has run — the node's components are detached, its
     * Three.js resources released and it is out of the tree.
     *
     * Anything that HOLDS a node across frames without owning it (a tween, a trail,
     * a cached lookup) has to be able to ask: writing into a disposed node silently
     * does nothing while keeping the whole subtree alive through the reference.
     */
    get isDisposed(): boolean;
    /** Reference to InputSystem (injected by runtime) */
    _input?: import('../core/InputService').InputService;
    /** Reference to SceneService (injected by runtime) */
    _scene?: SceneService;
    constructor(props: NodeBaseProps);
    /**
     * res:// path of the prefab this node is an instance root of, or null. Set on
     * instance roots at load time; mutated only by prefab operations (e.g. unlink,
     * which clears it to convert the instance into plain scene nodes).
     */
    get instancePath(): string | null;
    setInstancePath(path: string | null): void;
    get input(): import('../core/InputService').InputService | undefined;
    set input(service: import('../core/InputService').InputService | undefined);
    get scene(): SceneService | undefined;
    set scene(service: SceneService | undefined);
    get parentNode(): NodeBase | null;
    adoptChild(child: NodeBase): void;
    disownChild(child: NodeBase): void;
    findById(id: string): NodeBase | null;
    /**
     * Find the first node in this subtree (including this node) whose name matches.
     */
    findByName(name: string): NodeBase | null;
    /**
     * Return the direct child with the given name, or null.
     */
    getChildByName(name: string): NodeBase | null;
    /**
     * Resolve a slash-separated path of child names relative to this node
     * (e.g. `"Panel/Title"`). Each segment matches a direct child by name.
     */
    findByPath(path: string): NodeBase | null;
    /**
     * Unified lookup: resolves a query that is either a node id, a node name, or
     * a slash-separated path of child names. Prefer this from scripts so node
     * references don't depend on how the target was authored.
     */
    findNode(query: string): NodeBase | null;
    /**
     * Add a script component to this node.
     * If the node's scene is already running, calls onStart immediately.
     * @param component - The script component to add
     */
    addComponent(component: ScriptComponent): void;
    /**
     * Run a script lifecycle hook with error isolation. A throwing script must not
     * kill the frame, its siblings, or the game loop, so we catch, report the
     * failure through the runtime's script-error sink (surfaced by the editor's
     * Logs panel / Game tab), log to the console for DevTools, and disable the
     * offending component so it can't spam an error every frame. Returns whether
     * the hook completed without throwing.
     */
    private runComponentHook;
    /**
     * Get a component of a specific type from this node.
     * @param type - The constructor/class of the component type to find
     * @returns The first component of the specified type, or null if not found
     */
    getComponent<T extends ScriptComponent>(type: new (...args: never[]) => T): T | null;
    /**
     * Remove a script component from this node.
     * Calls onDetach and removes it from the components array.
     * @param component - The script component to remove
     */
    removeComponent(component: ScriptComponent): void;
    /**
     * Whether this node is visible all the way up to the scene root.
     *
     * `visible` is per-node — three.js skips a hidden subtree at render time but never folds the flag
     * into the children — so "can the player see this" is a walk, not a property read. Input gating
     * is what needs it: {@link tick} deliberately keeps running on hidden nodes (a hidden spawner,
     * timer or state machine must keep working), so nothing upstream filters a hidden control out and
     * it has to ask before it accepts a finger.
     *
     * Boolean only: a fully transparent node still counts as visible here, the same line Godot's
     * `is_visible_in_tree` draws. Fading something out is not the same statement as taking it away,
     * and a control that stopped responding halfway through a fade would be the surprising one.
     */
    isVisibleInTree(): boolean;
    /**
     * The node's own authored visibility, with the editor's Peek mask factored OUT.
     *
     * This is the value that belongs in a scene file, a state snapshot, or an agent's report of what
     * the author set — `visible` answers the different question "would this draw right now".
     */
    get authoredVisible(): boolean;
    /**
     * Tick method called every frame to update scripts.
     * Calls onUpdate on enabled components and recursively on children.
     * @param dt - Delta time in seconds since last frame
     */
    tick(dt: number): void;
    signal(name: string): void;
    emit(name: string, ...args: unknown[]): void;
    connect(signalName: string, target: unknown, method: (...args: unknown[]) => void): void;
    disconnect(signalName: string, target: unknown, method: (...args: unknown[]) => void): void;
    disconnectAll(signalName?: string): void;
    disconnectAllFromTarget(target: unknown): void;
    private unregisterLinks;
    addToGroup(group: string): boolean;
    removeFromGroup(group: string): boolean;
    isInGroup(group: string): boolean;
    /** Nodes queued by {@link queueFree}, drained by the runtime each frame. */
    private static readonly freeQueue;
    private _freeQueued;
    /**
     * Queue this node (and its subtree) for safe removal at the end of the
     * current frame — Godot's `queue_free()`. Safe to call from a component's
     * own `onUpdate` (immediate `dispose()` there would mutate the tree while
     * the runtime is still iterating it). Components across the subtree get a
     * proper `onDetach` (unregistering hitboxes, signal cleanup) before the
     * resources are released.
     */
    queueFree(): void;
    /**
     * Drain the {@link queueFree} queue: detach components subtree-deep (firing
     * `onDetach`), then dispose each queued node. Called by the SceneRunner after
     * the frame's node ticks; tests may call it manually.
     */
    static flushFreeQueue(): void;
    /** Detach every component in this subtree, firing their `onDetach`. */
    private detachComponentsDeep;
    /**
     * Free all GPU/runtime resources owned by this node and its entire subtree.
     *
     * Recursively disposes NodeBase children, detaches script components (firing
     * onDetach), clears signal connections, releases owned Three.js resources via
     * {@link disposeResources}, then detaches from its parent. Idempotent — calling
     * it twice is a no-op.
     *
     * Must be called by scene teardown paths (SceneRunner.stop for the runtime
     * clone; SceneManager when an authored graph is replaced/removed) so that
     * geometries/materials/canvas textures are not leaked. It must NOT be called
     * for nodes that will be re-added later (e.g. DeleteObjectOperation keeps
     * deleted nodes alive for undo).
     */
    dispose(): void;
    /**
     * Release Three.js resources owned by this node's own (non-NodeBase) visual
     * meshes. The default implementation disposes the geometry and material(s) of
     * every visual descendant — this is safe because a Three.js Material.dispose()
     * does NOT dispose its textures, so shared AssetLoader-cached textures on
     * `material.map` are left intact.
     *
     * Subclasses that own additional resources not reachable this way — canvas
     * textures (labels), sliced spritesheet frame textures, particle buffers, or a
     * shared module-level material that must be preserved — should override this
     * (calling `super.disposeResources()` unless they fully manage their meshes).
     */
    protected disposeResources(): void;
    /**
     * Get the property schema for this node type.
     * Defines all editable properties and their metadata for the inspector.
     * Override in subclasses to extend with additional properties.
     */
    static getPropertySchema(): PropertySchema;
}
