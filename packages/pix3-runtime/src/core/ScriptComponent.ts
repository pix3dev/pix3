/**
 * Script Component System
 *
 * Defines the core interfaces for the unified script component system.
 * This system follows the PropertySchema pattern for dynamic parameter configuration.
 */

import type { PropertySchema } from '../fw/property-schema';
import type { NodeBase } from '../nodes/NodeBase';
import type { AssetLoader } from './AssetLoader';
import type { SceneService } from './SceneService';

export interface EditorPreviewContext {
  assetLoader: AssetLoader;
  requestRender: () => void;
}

/**
 * Type helper for constructors
 */
export type Constructor<T> = new (...args: unknown[]) => T;

/**
 * Names (and matching node types) of the nodes available to scripts, keyed by
 * node name or slash-separated path.
 *
 * This interface is intentionally **empty** in the runtime. The Pix3 editor
 * augments it at authoring time (via a generated ambient declaration fed to the
 * in-editor code editor) so that {@link Script.getNode} returns the exact node
 * type for a known name — the same ergonomics as Godot's `$Node` or WPF/WinForms
 * `x:Name` fields. In exported games, consumer projects, and tests it stays
 * empty, so `keyof SceneNodeNames` is `never`, only the generic `getNode`
 * overload applies, and the runtime package remains editor-agnostic.
 */

export interface SceneNodeNames {}

/**
 * ScriptComponent - Unified interface for all script components.
 * Replaces the previous dual system of behaviors and controllers.
 * All scripts implement this interface with lifecycle methods and configuration.
 */
export interface ScriptComponent {
  /** Unique identifier for this component instance */
  readonly id: string;

  /** Type name of this component (matches registry key) */
  readonly type: string;

  /** Reference to the node this component is attached to */
  node: NodeBase | null;

  /** Whether this component is currently active and receiving updates */
  enabled: boolean;

  /** Configuration object for this component's parameters */
  config: Record<string, unknown>;

  /** Flag to track if onStart has been called */
  _started: boolean;

  /**
   * Called when the script component is attached to a node.
   * Use this to initialize references and set up state.
   */
  onAttach?(node: NodeBase): void;

  /**
   * Called on the first frame after attachment, before the first onUpdate.
   * Use this to perform initialization that depends on the scene being fully loaded.
   */
  onStart?(): void;

  /**
   * Called every frame with the delta time in seconds.
   * Use this to update state and animate properties.
   */
  onUpdate?(dt: number): void;

  /**
   * Called by the editor viewport render loop when a component wants to show
   * editor-only preview state without entering play mode.
   */
  tickEditorPreview?(dt: number, context: EditorPreviewContext): void;

  /**
   * Called when the script component is detached from a node or the scene is unloaded.
   * Use this to clean up resources and remove event listeners.
   */
  onDetach?(): void;

  /**
   * Reset the started state (internal use only).
   * Called when detaching to allow re-initialization on next attach.
   */
  resetStartedState?(): void;

  /**
   * Access to the Input System.
   * Injected by the SceneRunner or runtime environment.
   */
  input?: import('./InputService').InputService;

  /**
   * Access to the Scene Service (camera control, screen fades, etc.).
   * Injected by the SceneRunner or runtime environment.
   */
  scene?: SceneService;
}

/**
 * Abstract base class for script components providing default implementations.
 * Extend this class to create custom script components.
 */
export abstract class Script implements ScriptComponent {
  readonly id: string;
  readonly type: string;
  node: NodeBase | null = null;
  enabled: boolean = true;
  config: Record<string, unknown> = {};
  _started: boolean = false;
  input?: import('./InputService').InputService;
  scene?: SceneService;

  constructor(id: string, type: string) {
    this.id = id;
    this.type = type;
  }

  /**
   * Get the property schema for this component's parameters.
   * Override this method to define editable parameters.
   */
  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'Script',
      properties: [],
      groups: {},
    };
  }

  /**
   * Resolve another node in the scene by id, name, or slash-separated path of
   * names. This is the unified addressing entry point for scripts — prefer it
   * over walking `this.node` manually. When no scene service is available
   * (e.g. some editor previews) it falls back to searching from the owning
   * node's root.
   */
  protected findNode(query: string): NodeBase | null {
    if (this.scene) {
      return this.scene.findNode(query);
    }
    let root = this.node;
    while (root?.parentNode) {
      root = root.parentNode;
    }
    return root?.findNode(query) ?? null;
  }

  /**
   * Resolve another node by id, name, or slash-separated path and return it,
   * throwing if it does not exist. This is the non-null counterpart to
   * {@link findNode} (Godot's `get_node` vs `get_node_or_null`).
   *
   * When a name is known to the editor (see {@link SceneNodeNames}) the return
   * type is the exact node type, so member access autocompletes. Any other
   * string falls through to the generic overload and resolves to `NodeBase`,
   * so a script reused in a scene that lacks the name still type-checks — the
   * editor-provided names are hints, never constraints.
   */
  protected getNode<K extends keyof SceneNodeNames & string>(name: K): SceneNodeNames[K];
  protected getNode<T extends NodeBase = NodeBase>(query: string): T;
  protected getNode(query: string): NodeBase {
    const node = this.findNode(query);
    if (!node) {
      throw new Error(`[${this.type}] getNode("${query}"): node not found in scene`);
    }
    return node;
  }

  onAttach?(node: NodeBase): void;
  onStart?(): void;
  onUpdate?(dt: number): void;
  tickEditorPreview?(dt: number, context: EditorPreviewContext): void;
  onDetach(): void {
    if (this.node) {
      this.node.disconnectAllFromTarget(this);
    }
  }

  /**
   * Reset the started state
   */
  resetStartedState(): void {
    this._started = false;
  }
}

/**
 * Type guard to check if an object is a ScriptComponent
 */
export function isScriptComponent(obj: unknown): obj is ScriptComponent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    'type' in obj &&
    'enabled' in obj &&
    'config' in obj
  );
}
