import { Object3D, type BufferGeometry, type Material } from 'three';
import type { PropertySchema } from '../fw/property-schema';
import type { ScriptComponent } from '../core/ScriptComponent';
import type { SceneService } from '../core/SceneService';
import { describeThrown, reportScriptError, type ScriptErrorPhase } from '../core/game-debug';

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

export class NodeBase extends Object3D {
  readonly nodeId: string;
  readonly type: string;
  override name: string;
  declare children: NodeBase[];
  readonly properties: Record<string, unknown>;
  readonly metadata: NodeMetadata;
  private _instancePath: string | null;
  /** Whether this node can have children. */
  isContainer: boolean = true;
  /** Script components attached to this node */
  readonly components: ScriptComponent[] = [];
  /** Groups associated with this node */
  readonly groups: Set<string> = new Set();
  private readonly _signals: Map<string, Set<SignalConnection>> = new Map();
  private _disposed = false;

  /** Reference to InputSystem (injected by runtime) */
  _input?: import('../core/InputService').InputService;

  /** Reference to SceneService (injected by runtime) */
  _scene?: SceneService;

  constructor(props: NodeBaseProps) {
    super();

    this.nodeId = props.id;
    this.uuid = props.id;
    this.type = props.type ?? 'Group';
    this.name = props.name ?? this.type;
    this.properties = { ...(props.properties ?? {}) };
    this.metadata = { ...(props.metadata ?? {}) };
    this._instancePath = props.instancePath ?? null;
    for (const group of props.groups ?? []) {
      if (typeof group === 'string' && group.trim().length > 0) {
        this.groups.add(group.trim());
      }
    }

    // Initialize visibility and lock state from properties
    if (this.properties.visible !== undefined) {
      this.visible = !!this.properties.visible;
    }
    if (this.properties.locked !== undefined) {
      this.userData.locked = !!this.properties.locked;
    }

    this.userData = {
      ...this.userData,
      nodeId: this.nodeId,
      metadata: this.metadata,
      properties: this.properties,
    };
  }

  /**
   * res:// path of the prefab this node is an instance root of, or null. Set on
   * instance roots at load time; mutated only by prefab operations (e.g. unlink,
   * which clears it to convert the instance into plain scene nodes).
   */
  get instancePath(): string | null {
    return this._instancePath;
  }

  setInstancePath(path: string | null): void {
    this._instancePath = path;
  }

  get input(): import('../core/InputService').InputService | undefined {
    return this._input;
  }

  set input(service: import('../core/InputService').InputService | undefined) {
    this._input = service;

    // Propagate to children
    for (const child of this.children) {
      if (child instanceof NodeBase) {
        child.input = service;
      }
    }

    // Propagate to components
    for (const component of this.components) {
      component.input = service;
    }
  }

  get scene(): SceneService | undefined {
    return this._scene;
  }

  set scene(service: SceneService | undefined) {
    this._scene = service;

    // Propagate to children
    for (const child of this.children) {
      if (child instanceof NodeBase) {
        child.scene = service;
      }
    }

    // Propagate to components
    for (const component of this.components) {
      component.scene = service;
    }
  }

  get parentNode(): NodeBase | null {
    return this.parent instanceof NodeBase ? this.parent : null;
  }

  adoptChild(child: NodeBase): void {
    if (child === this) {
      throw new Error('Cannot adopt node as its own child.');
    }
    this.add(child);
    if (this._input) {
      child.input = this._input;
    }
    if (this._scene) {
      child.scene = this._scene;
    }
  }

  disownChild(child: NodeBase): void {
    this.remove(child);
  }

  findById(id: string): NodeBase | null {
    if (this.nodeId === id) {
      return this;
    }
    for (const child of this.children) {
      const match = child instanceof NodeBase ? child.findById(id) : null;
      if (match) {
        return match;
      }
    }
    return null;
  }

  /**
   * Find the first node in this subtree (including this node) whose name matches.
   */
  findByName(name: string): NodeBase | null {
    if (this.name === name) {
      return this;
    }
    for (const child of this.children) {
      const match = child instanceof NodeBase ? child.findByName(name) : null;
      if (match) {
        return match;
      }
    }
    return null;
  }

  /**
   * Return the direct child with the given name, or null.
   */
  getChildByName(name: string): NodeBase | null {
    for (const child of this.children) {
      if (child instanceof NodeBase && child.name === name) {
        return child;
      }
    }
    return null;
  }

  /**
   * Resolve a slash-separated path of child names relative to this node
   * (e.g. `"Panel/Title"`). Each segment matches a direct child by name.
   */
  findByPath(path: string): NodeBase | null {
    const segments = path
      .split('/')
      .map(segment => segment.trim())
      .filter(segment => segment.length > 0);
    if (segments.length === 0) {
      return null;
    }
    let current: NodeBase | null = this;
    for (const segment of segments) {
      current = current ? current.getChildByName(segment) : null;
      if (!current) {
        return null;
      }
    }
    return current;
  }

  /**
   * Unified lookup: resolves a query that is either a node id, a node name, or
   * a slash-separated path of child names. Prefer this from scripts so node
   * references don't depend on how the target was authored.
   */
  findNode(query: string): NodeBase | null {
    if (query.includes('/')) {
      return this.findByPath(query);
    }
    return this.findById(query) ?? this.findByName(query);
  }

  /**
   * Add a script component to this node.
   * If the node's scene is already running, calls onStart immediately.
   * @param component - The script component to add
   */
  addComponent(component: ScriptComponent): void {
    if (this.components.includes(component)) {
      console.warn(
        `[NodeBase] Component ${component.id} is already attached to node ${this.nodeId}`
      );
      return;
    }

    // Attach to node
    component.node = this;
    if (this._input) {
      component.input = this._input;
    }
    if (this._scene) {
      component.scene = this._scene;
    }
    this.components.push(component);

    // Call onAttach if defined
    const onAttach = component.onAttach;
    if (onAttach) {
      this.runComponentHook(component, 'attach', () => onAttach.call(component, this));
    }

    // If the scene is already running (node has been started), start the component immediately
    // We detect this by checking if any existing component has been started
    const sceneRunning = this.components.some(c => c._started);
    const onStart = component.onStart;
    if (sceneRunning && component.enabled && onStart) {
      this.runComponentHook(component, 'start', () => onStart.call(component));
      component._started = true;
    }
  }

  /**
   * Run a script lifecycle hook with error isolation. A throwing script must not
   * kill the frame, its siblings, or the game loop, so we catch, report the
   * failure through the runtime's script-error sink (surfaced by the editor's
   * Logs panel / Game tab), log to the console for DevTools, and disable the
   * offending component so it can't spam an error every frame. Returns whether
   * the hook completed without throwing.
   */
  private runComponentHook(
    component: ScriptComponent,
    phase: ScriptErrorPhase,
    run: () => void
  ): boolean {
    try {
      run();
      return true;
    } catch (thrown) {
      // Disable first so any re-entrant work sees the component as inactive.
      component.enabled = false;
      const { message, stack } = describeThrown(thrown);
      console.error(
        `[NodeBase] Script "${component.type}" threw in ${phase} on node "${this.name}" (disabled):`,
        thrown
      );
      reportScriptError({
        phase,
        message,
        stack,
        nodeId: this.nodeId,
        nodeName: this.name,
        componentType: component.type,
        componentId: component.id,
      });
      return false;
    }
  }

  /**
   * Get a component of a specific type from this node.
   * @param type - The constructor/class of the component type to find
   * @returns The first component of the specified type, or null if not found
   */
  getComponent<T extends ScriptComponent>(type: new (...args: never[]) => T): T | null {
    const component = this.components.find(c => c instanceof type);
    return component ? (component as T) : null;
  }

  /**
   * Remove a script component from this node.
   * Calls onDetach and removes it from the components array.
   * @param component - The script component to remove
   */
  removeComponent(component: ScriptComponent): void {
    const index = this.components.indexOf(component);
    if (index === -1) {
      console.warn(`[NodeBase] Component ${component.id} is not attached to node ${this.nodeId}`);
      return;
    }

    // Call onDetach if defined
    if (component.onDetach) {
      component.onDetach();
    }

    // Reset started state
    if (component.resetStartedState) {
      component.resetStartedState();
    }

    // Remove from node
    component.node = null;
    this.components.splice(index, 1);
  }

  /**
   * Tick method called every frame to update scripts.
   * Calls onUpdate on enabled components and recursively on children.
   * @param dt - Delta time in seconds since last frame
   */
  tick(dt: number): void {
    // Update all enabled components. Each hook runs isolated (see
    // runComponentHook) so one throwing script disables itself instead of
    // killing this frame, its siblings, or the whole game loop.
    for (const component of this.components) {
      if (!component.enabled) {
        continue;
      }

      // Call onStart on first update.
      const onStart = component.onStart;
      if (!component._started && onStart) {
        const started = this.runComponentHook(component, 'start', () => onStart.call(component));
        component._started = true;
        // A failed onStart disabled the component; skip onUpdate this frame.
        if (!started) {
          continue;
        }
      }

      // Call onUpdate (component may have been disabled by a failed onStart).
      const onUpdate = component.onUpdate;
      if (component.enabled && onUpdate) {
        this.runComponentHook(component, 'update', () => onUpdate.call(component, dt));
      }
    }

    // Recursively tick children
    for (const child of this.children) {
      if (child instanceof NodeBase) {
        child.tick(dt);
      }
    }
  }

  signal(name: string): void {
    if (!name || !name.trim()) {
      return;
    }
    if (!this._signals.has(name)) {
      this._signals.set(name, new Set());
    }
  }

  emit(name: string, ...args: unknown[]): void {
    const connections = this._signals.get(name);
    if (!connections || connections.size === 0) {
      return;
    }

    for (const connection of connections) {
      try {
        connection.method.call(connection.target, ...args);
      } catch (error) {
        console.error('[NodeBase] Signal listener failed', {
          nodeId: this.nodeId,
          signal: name,
          error,
        });
      }
    }
  }

  connect(signalName: string, target: unknown, method: (...args: unknown[]) => void): void {
    if (!signalName || !signalName.trim()) {
      return;
    }
    if (typeof method !== 'function') {
      return;
    }

    const connections = this._signals.get(signalName) ?? new Set<SignalConnection>();
    for (const connection of connections) {
      if (connection.target === target && connection.method === method) {
        return;
      }
    }

    connections.add({ target, method });
    this._signals.set(signalName, connections);
  }

  disconnect(signalName: string, target: unknown, method: (...args: unknown[]) => void): void {
    const connections = this._signals.get(signalName);
    if (!connections) {
      return;
    }

    for (const connection of connections) {
      if (connection.target === target && connection.method === method) {
        connections.delete(connection);
      }
    }

    if (connections.size === 0) {
      this._signals.delete(signalName);
    }
  }

  disconnectAll(signalName?: string): void {
    if (!signalName) {
      this._signals.clear();
      return;
    }
    this._signals.delete(signalName);
  }

  disconnectAllFromTarget(target: unknown): void {
    for (const [signalName, connections] of this._signals.entries()) {
      for (const connection of connections) {
        if (connection.target === target) {
          connections.delete(connection);
        }
      }
      if (connections.size === 0) {
        this._signals.delete(signalName);
      }
    }
  }

  addToGroup(group: string): boolean {
    const trimmed = group.trim();
    if (!trimmed) {
      return false;
    }
    const sizeBefore = this.groups.size;
    this.groups.add(trimmed);
    return this.groups.size !== sizeBefore;
  }

  removeFromGroup(group: string): boolean {
    return this.groups.delete(group.trim());
  }

  isInGroup(group: string): boolean {
    return this.groups.has(group.trim());
  }

  /** Nodes queued by {@link queueFree}, drained by the runtime each frame. */
  private static readonly freeQueue: NodeBase[] = [];
  private _freeQueued = false;

  /**
   * Queue this node (and its subtree) for safe removal at the end of the
   * current frame — Godot's `queue_free()`. Safe to call from a component's
   * own `onUpdate` (immediate `dispose()` there would mutate the tree while
   * the runtime is still iterating it). Components across the subtree get a
   * proper `onDetach` (unregistering hitboxes, signal cleanup) before the
   * resources are released.
   */
  queueFree(): void {
    if (this._disposed || this._freeQueued) {
      return;
    }
    this._freeQueued = true;
    NodeBase.freeQueue.push(this);
  }

  /**
   * Drain the {@link queueFree} queue: detach components subtree-deep (firing
   * `onDetach`), then dispose each queued node. Called by the SceneRunner after
   * the frame's node ticks; tests may call it manually.
   */
  static flushFreeQueue(): void {
    if (NodeBase.freeQueue.length === 0) {
      return;
    }
    const queued = NodeBase.freeQueue.splice(0, NodeBase.freeQueue.length);
    for (const node of queued) {
      node._freeQueued = false;
      if (node._disposed) {
        continue;
      }
      node.detachComponentsDeep();
      node.dispose();
    }
  }

  /** Detach every component in this subtree, firing their `onDetach`. */
  private detachComponentsDeep(): void {
    while (this.components.length > 0) {
      this.removeComponent(this.components[this.components.length - 1]);
    }
    for (const child of [...this.children]) {
      if (child instanceof NodeBase) {
        child.detachComponentsDeep();
      }
    }
  }

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
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    // Dispose child subtrees first (they detach themselves from this node).
    for (const child of [...this.children]) {
      if (child instanceof NodeBase) {
        child.dispose();
      }
    }

    // Drop component references. The runtime component lifecycle (onDetach) is
    // driven explicitly by the SceneRunner on stop(); dispose() only releases
    // references and resources, so it must NOT fire onDetach here (that would
    // double-fire in play mode and run onDetach for non-running editor nodes).
    for (const component of this.components) {
      component.node = null;
    }
    this.components.length = 0;

    this.disconnectAll();
    this.disposeResources();
    this.removeFromParent();
  }

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
  protected disposeResources(): void {
    // `children` is declared as NodeBase[] but at runtime also holds the plain
    // Object3D visual meshes a node adds (e.g. `this.add(new Mesh(...))`).
    const visualChildren: Object3D[] = this.children;
    for (const child of visualChildren) {
      if (child instanceof NodeBase) {
        continue;
      }
      child.traverse(descendant => {
        if (descendant instanceof NodeBase) {
          return;
        }
        const geometry = (descendant as { geometry?: BufferGeometry }).geometry;
        geometry?.dispose?.();
        const material = (descendant as { material?: Material | Material[] }).material;
        if (Array.isArray(material)) {
          for (const entry of material) {
            entry?.dispose?.();
          }
        } else {
          material?.dispose?.();
        }
      });
    }
  }

  /**
   * Get the property schema for this node type.
   * Defines all editable properties and their metadata for the inspector.
   * Override in subclasses to extend with additional properties.
   */
  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'NodeBase',
      properties: [
        {
          name: 'id',
          type: 'string',
          ui: {
            label: 'Node ID',
            description: 'Unique identifier for this node',
            group: 'Base',
            readOnly: true,
          },
          getValue: (node: unknown) => (node as NodeBase).nodeId,
          setValue: () => {
            // Read-only, no-op
          },
        },
        {
          name: 'name',
          type: 'string',
          ui: {
            label: 'Name',
            description: 'Display name for this node',
            group: 'Base',
          },
          getValue: (node: unknown) => (node as NodeBase).name,
          setValue: (node: unknown, value: unknown) => {
            (node as NodeBase).name = String(value);
          },
        },
        {
          name: 'type',
          type: 'string',
          ui: {
            label: 'Type',
            description: 'Node type',
            group: 'Base',
            readOnly: true,
          },
          getValue: (node: unknown) => (node as NodeBase).type,
          setValue: () => {
            // Read-only, no-op
          },
        },
        {
          name: 'groups',
          type: 'object',
          ui: {
            label: 'Groups',
            description: 'Node groups used for runtime querying and call-group operations',
            group: 'Base',
            hidden: true,
          },
          getValue: (node: unknown) => Array.from((node as NodeBase).groups),
          setValue: (node: unknown, value: unknown) => {
            const next = Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
            const base = node as NodeBase;
            base.groups.clear();
            for (const group of next) {
              const trimmed = group.trim();
              if (trimmed) {
                base.groups.add(trimmed);
              }
            }
          },
        },
        {
          name: 'visible',
          type: 'boolean',
          ui: {
            label: 'Visible',
            description: 'Whether the node is visible in the viewport',
            group: 'Editor',
          },
          getValue: (node: unknown) => (node as NodeBase).visible,
          setValue: (node: unknown, value: unknown) => {
            const n = node as NodeBase;
            const v = !!value;
            n.visible = v;
            n.properties.visible = v;
          },
        },
        {
          name: 'initiallyVisible',
          type: 'boolean',
          ui: {
            label: 'Initially Visible',
            description: 'Whether the node starts visible when entering play mode',
            group: 'Base',
          },
          getValue: (node: unknown) => {
            const n = node as NodeBase;
            return typeof n.properties.initiallyVisible === 'boolean'
              ? n.properties.initiallyVisible
              : n.visible;
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as NodeBase;
            n.properties.initiallyVisible = !!value;
          },
        },
        {
          name: 'locked',
          type: 'boolean',
          ui: {
            label: 'Locked',
            description: 'Whether the node is locked and cannot be selected in the viewport',
            group: 'Editor',
          },
          getValue: (node: unknown) => !!(node as NodeBase).userData.locked,
          setValue: (node: unknown, value: unknown) => {
            const n = node as NodeBase;
            const v = !!value;
            n.userData.locked = v;
            n.properties.locked = v;
          },
        },
      ],
      groups: {
        Base: {
          label: 'Base Properties',
          description: 'Core node properties',
          expanded: true,
        },
        Editor: {
          label: 'Editor',
          description: 'Editor and play-mode defaults',
          expanded: true,
        },
      },
    };
  }
}
