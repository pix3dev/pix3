# Pix3 — Technical Specification

Version: 1.16

Date: 2026-07-04

## 1. Introduction

### 1.1 Purpose of the Document

This document describes the technical requirements, architecture, and development plan for the web application Pix3 — a modern editor for creating HTML5 games that combines 2D and 3D capabilities.

### 1.2 Product Overview

Pix3 is a browser-based editor, similar to Figma and Unity, designed for rapid and iterative development of game scenes. It allows working with project files directly through the File System Access API, ensuring tight integration with external IDEs (like VS Code) for code editing.

### 1.3 Target Audience

Pix3 targets professional and indie teams who already create playable ads and interactive experiences with WebGL engines:

- **Playable ad creators** migrating from PixiJS and Three.js pipelines who need scene tooling and rapid iteration.
- **Construct 3 and Godot users** looking for a browser-first workflow with minimal install friction.
- **Cocos and custom engine developers** who want to assemble UI overlays and scene flow visually before exporting to code.

Success metrics:

- Create a new playable ad scene from template to export in under 30 minutes on mid-tier hardware.
- Maintain ≥ 85% editor FPS on a 3-layer (UI + 3D + particle) scene in Chromium browsers on 2023+ laptops.
- Support 90% of user actions via keyboard shortcuts or palette commands within MVP.

### 1.4 Document Scope and Change Management

This specification covers the MVP scope and foundation architecture. Changes are tracked in the changelog at the end of the document.

## 2. Key Features

- Hybrid 2D/3D Scene: The editor does not have a rigid separation between 2D and 3D modes. Instead, it uses a layer system, allowing 2D interfaces to be overlaid on top of 3D scenes — ideal for creating game UIs.
- Godot-style Scene Structure: The scene architecture is based on a hierarchy of "nodes." Each node represents an object (a sprite, a 3D model, a light source). Nodes can be saved into separate scene files (\*.pix3scene) and reused (instanced) within other scenes.
- Local File System Integration: Pix3 works directly with the project folder on the user's disk via the File System Access API. This eliminates the need to upload/download files and provides seamless synchronization with external code editors.
- Multi-tab Interface: Users can open and edit multiple scenes in different tabs simultaneously, simplifying work on complex projects.
- Drag-and-Drop Assets: Project resources (images, models) can be dragged directly from the editor's file browser into the scene viewport to create nodes.
- Customizable Interface: The user can move and dock editor panels to different areas of the window, similar to VS Code, and save their layout between sessions.
- Workspace Presets: Provide opinionated workspace presets (Playable Ad, 3D Scene Authoring, UI Overlay).

## 3. Technology Stack

| Category | Technology | Justification |
| :--- | :--- | :--- |
| UI Components | Lit + `fw` utilities | A lightweight library for creating fast, native, and encapsulated web components. Uses the project `fw` helpers (`ComponentBase`, `inject`, and related exports) as the default building blocks instead of raw `LitElement` to simplify behavior (light vs. shadow DOM), dependency injection, and consistency across the codebase. |
| State Management | Valtio | An ultra-lightweight, high-performance state manager based on proxies. Ensures reactivity and is simple to use. |
| Rendering (3D) | Three.js | Modern WebGL renderer for 3D content. |
| Panel Layout | Golden Layout | A ready-made solution for creating complex, customizable, and persistent panel layouts. |
| Language | TypeScript | Strong typing to increase reliability, improve autocompletion, and simplify collaboration with AI agents. |
| Build Tool | Vite | A modern and extremely fast build tool, perfectly suited for development with native web technologies. |
| File System | File System Access API | Allows working with local files directly from the browser without needing Electron. |

### 3.1 Target Platforms

- **Browsers:** Chromium-based desktop browsers (Chrome, Edge, Arc, Brave) latest two stable versions.
- **Operating Systems:** Windows 11+, macOS 13+, Ubuntu 22.04+ (via Chromium).
- **Hardware Baseline:** Integrated GPU (Intel Iris Xe / AMD Vega) with WebGL2 support, 8 GB RAM, 4-core CPU.

Non-Chromium browsers (Firefox, Safari) are out of scope for MVP but should degrade gracefully by displaying a compatibility banner.

## 4. Architecture

The application is built on the principles of unidirectional data flow and clear separation of concerns.

- **State**: A centralized Valtio proxy (`appState`), serving as the single source of truth for UI, scenes metadata, and selection. It is passive and contains no business logic.
- **Nodes**: Scene nodes (inheriting from Three.js Object3D) are managed by `SceneManager` in `SceneGraph` objects. **Nodes are not stored in reactive state** — only node IDs are tracked in state for selection and hierarchy reference. This separation reduces reactivity overhead and keeps node mutations fast.
- **Operations**: First-class objects encapsulating business logic and state mutations. The `OperationService` is the gateway for executing operations, but all actions must be initiated via **Commands** through the `CommandDispatcher` Service.
- **Commands**: Thin wrappers that validate context (`preconditions()`) and invoke operations via `OperationService`. Commands are registered and discovered via metadata for the command palette. Commands never implement their own undo/redo.
- **CommandDispatcher**: Primary entry point for all user actions. Ensures consistent lifecycle management, preconditions checking, and telemetry for all commands.
- **Command Metadata**: Commands declare menu integration via metadata properties: `menuPath` (menu section), `shortcut` (display), and `addToMenu` (inclusion flag). Menu is generated from registered commands, not hardcoded.
- **Core Managers**: Classes that orchestrate the main aspects of the editor (HistoryManager, SceneManager, LayoutManager). They manage their respective domains and emit events.
- **Services**: Infrastructure layer for interacting with the outside world (FileSystemAPIService, ViewportRenderService, DialogService, LoggingService, FileWatchService). They implement `dispose()` and are registered with DI.
- **UI Components**: "Dumb" components extending `ComponentBase` from `src/fw`. They subscribe to state changes, render based on snapshots, and dispatch commands via CommandDispatcher rather than mutating state directly.
- **Property Schema System**: Godot-inspired declarative property metadata system for dynamic inspector UI generation. Node classes expose editable properties via `static getPropertySchema()`, enabling automatic editor creation.

### Recommended component pattern

Use the `fw` utilities exported from `src/fw` when creating UI components. Example:

```typescript
import { customElement, html, ComponentBase, inject } from '@/fw';

@customElement('my-inspector')
export class MyInspector extends ComponentBase {
  @inject()
  dataService!: DataService; // resolved from fw/di container

  render() {
    return html`<div class="inspector"><h3>Inspector</h3></div>`;
  }
}
```

Notes:

- `ComponentBase` defaults to light DOM but allows opting into shadow DOM via a static `useShadowDom` flag.
- The `inject` decorator automatically resolves services registered with the `fw/di` container. Services can be registered using the `@injectable()` helper in `fw/di`. Ensure `emitDecoratorMetadata` and `reflect-metadata` are enabled within the build configuration.

### UI Portals and Floating Elements

Floating UI elements such as dropdowns, context menus, and tooltips must use the **portal pattern** via `DropdownPortal` or a similar utility. Rendering these elements inline inside a panel's DOM tree is discouraged because:

1. Panels often use `overflow: hidden` or `overflow: auto`, which clips any child element that extends beyond the panel's boundaries.
2. Portals allow rendering the element at the `document.body` level with `position: fixed`, ensuring it appears on top of all other panels and UI layers.
3. The `DropdownPortal` utility automatically handles viewport collision detection, ensuring the menu stays within the visible area.

When implementing a context menu or dropdown, always check for the existence of an appropriate portal utility in `src/ui/shared`.

### 4.1 Core Architecture Contracts

- **Operation Lifecycle (source of truth):** An operation implements `perform(context)` and returns an `OperationCommit` object containing closures for `undo()`/`redo()` and metadata for coalescing. OperationService executes operations, pushes commits to history when requested, emits telemetry, and is solely responsible for undo/redo.
- **Command Lifecycle (thin wrappers):** `preconditions()` → `execute()`; commands delegate to OperationService to invoke operations and never implement their own undo/redo. They remain idempotent and emit telemetry via OperationService.
- **SceneGraph & Node Lifecycle:** `SceneManager` owns a `SceneGraph` per loaded scene. Each `SceneGraph` contains a `nodeMap` (for fast lookup) and `rootNodes` array. Nodes extend Three.js `Object3D` and are **not stored in Valtio state**. State only maintains node IDs for selection and hierarchy reference via `SceneHierarchyState.rootNodes`.
- **HistoryManager Contract:** Maintains a bounded stack of command snapshots, integrates with collaborative locking, and exposes `canUndo`/`canRedo` signals to the UI.
- **Service Layer:** Services implement `dispose()` and must be registered via DI. Singleton services load lazily on first injection.
- **CommandDispatcher Contract:** Executes all commands; invokes preconditions, executes, and handles telemetry. All user actions route through CommandDispatcher.
- **Property Schema Contract:** Node classes implement `static getPropertySchema(): PropertySchema` returning an object with `properties` array, `nodeType`, and optional `groups`. The Inspector uses `getNodePropertySchema()` to retrieve and render properties dynamically. Each property includes `getValue`/`setValue` closures for node interaction.

### 4.2 Glossary

- **Node:** Atomic element in the scene graph representing an entity (sprite, mesh, light).
- **Scene:** YAML document describing root node hierarchy and references.
- **Instance:** Inclusion of another scene file inside the active scene with optional overrides.
- **Preset:** Saved layout configuration.
- **Command:** Unit of business logic that mutates the state and can be undone/redone.
- **Property Schema:** Declarative metadata describing editable properties of a node type, used for dynamic inspector UI generation.

### 4.3 Operations-first Pipeline

- **OperationService:** Central orchestrator for operations. Methods: `invoke(op)`, `invokeAndPush(op)` (also record history), `undo()`, `redo()`. Maintains bounded stacks (default 100 items), clears redo on new pushes, supports coalescing, and emits typed events for UI updates and telemetry.
- **Operation Contract:** `perform()` returns an `OperationCommit` with `undo`/`redo` closures. Optionally includes metadata like affected node IDs and structure flags for efficient scene diffing.
- **Bulk operations:** Tools can compose granular operations into one undo step via a helper that produces a single coalesced commit.
- **CommandDispatcher:** Primary entry point for all actions. All UI panels and tools must use CommandDispatcher to execute commands, ensuring consistent lifecycle management, preconditions checking, and telemetry. Direct invocation of operations via OperationService is discouraged and should be replaced with appropriate commands.
- **Telemetry Hooks:** All mutations flow through OperationService, making it the ideal hook for analytics, autosave, and sync.

### 4.4 Rendering Architecture Notes

- **Three.js Unified Pipeline:** All rendering (3D + 2D) is handled by Three.js to minimize complexity and bundle size. 2D overlays (HUD, selection outlines, gizmos) use an orthographic camera and sprite/material system.
- **Layer Separation:** Logical separation is maintained via internal render phases (viewport pass, overlay pass) rather than different engines.
- **Testing Path:** Planned integration tests validate resize, DPR scaling, and render ordering across the unified rendering pipeline.

## 8. Property Schema System

### 8.1 Overview

Pix3 uses a **Godot-inspired property schema system** for dynamic object inspector UI generation. This system allows node classes to declaratively define their editable properties with type information, validation rules, and UI hints. The Inspector automatically renders appropriate editors for each property type.

### 8.2 Schema Structure

```typescript
interface PropertySchema {
  nodeType: string;
  extends?: string;
  properties: PropertyDefinition[];
  groups?: Record<string, { label: string; description?: string; expanded?: boolean }>;
}

interface PropertyDefinition {
  name: string;
  type: PropertyType;
  ui?: PropertyUIHints;
  validation?: PropertyValidation;
  defaultValue?: unknown;
  getValue: (node: unknown) => unknown;
  setValue: (node: unknown, value: unknown) => void;
}

type PropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'vector2'
  | 'vector3'
  | 'vector4'
  | 'euler'
  | 'color'
  | 'enum'
  | 'select'
  | 'object';
```

### 8.3 Node Schema Example

```typescript
export class Node2D extends NodeBase {
  static getPropertySchema(): PropertySchema {
    const baseSchema = NodeBase.getPropertySchema();
    return {
      nodeType: 'Node2D',
      extends: 'NodeBase',
      properties: [
        ...baseSchema.properties,
        {
          name: 'position',
          type: 'vector2',
          ui: {
            label: 'Position',
            group: 'Transform',
            step: 0.01,
            precision: 2,
          },
          getValue: node => ({ x: node.position.x, y: node.position.y }),
          setValue: (node, value) => {
            node.position.x = value.x;
            node.position.y = value.y;
          },
        },
        {
          name: 'rotation',
          type: 'number',
          ui: {
            label: 'Rotation',
            group: 'Transform',
            step: 0.1,
            precision: 1,
            unit: '°',
          },
          getValue: node => node.rotation.z * (180 / Math.PI), // radians → degrees
          setValue: (node, value) => {
            node.rotation.z = value * (Math.PI / 180); // degrees → radians
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Transform: { label: 'Transform', expanded: true },
      },
    };
  }
}
```

### 8.4 Inspector Integration

The Inspector panel uses these utilities:

- `getNodePropertySchema(node)` - Retrieves schema for a node instance
- `getPropertiesByGroup(schema)` - Groups properties by their `group` field
- `getPropertyDisplayValue(node, prop)` - Formats value for display

Property changes are handled through `UpdateObjectPropertyOperation`, which uses the schema's `getValue`/`setValue` methods for semantic transformations.

### 8.5 Custom Editors

Vector and rotation properties use specialized Web Components:

- `Vector2Editor` - Single-row X/Y inputs
- `Vector3Editor` - Single-row X/Y/Z inputs
- `EulerEditor` - X/Y/Z rotation in degrees

Transform group renders with 6-column CSS Grid (1rem 1fr 1rem 1fr 1rem 1fr) with color-coded axis labels (X: red, Y: green, Z: blue).

## 6. Script Component System

### 6.1 Overview

Pix3 includes a unified script component system for attaching runtime logic to nodes. This system enables game-like interactivity and logic within the scene editor, similar to Unity's MonoBehaviour or Godot's nodes. All scripts are components attached to nodes via the `components` array.

### 6.2 Script Component Types

Components use a namespace prefix system to distinguish between built-in and user-defined scripts:

- **Built-in Components**: Use `core:` prefix (e.g., `core:TestRotate`)
- **User Components**: Use `user:` prefix (e.g., `user:MyScript`)

Multiple components can be attached to a single node, and all components follow the same lifecycle and interface.

### 6.3 Script Lifecycle

All script components implement the `ScriptComponent` interface with the following methods:

- `onAttach(node: NodeBase)`: Called when the script component is attached to a node. Use this to initialize references and set up state.
- `onStart()`: Called on the first frame after attachment, before `onUpdate`. Use this for initialization that depends on the scene being fully loaded.
- `onUpdate(dt: number)`: Called every frame with delta time in seconds. Use this to update state and animate properties.
- `onDetach()`: Called when the script component is detached from a node or scene is unloaded. Use this to clean up resources and remove event listeners.
- `resetStartedState()`: Called when detaching to allow re-initialization on next attach.

### 6.4 Base Class

- **Script**: Abstract base class for all components. Extend this class to create custom scripts. Components expose parameters via `static getPropertySchema()` for dynamic property editing.

### 6.5 Script Registry

The `ScriptRegistry` service maintains a unified registry of script component types:

- Register components: `registry.registerComponent(info: ComponentTypeInfo)`
- Create instances: `registry.createComponent(typeId, instanceId)`
- Get property schemas: `registry.getComponentPropertySchema(typeId)`
- List all components: `registry.getAllComponentTypes()`

### 6.6 Script Execution Service

The `ScriptExecutionService` manages the game loop and script lifecycle:

- **Game Loop**: Runs `requestAnimationFrame` to tick all nodes in the active scene
- **Node Ticking**: Calls `tick(dt)` on all root nodes, which recursively updates children
- **Lifecycle Management**: Automatically calls `onAttach` when scenes load, `onDetach` when scenes unload
- **Start/Stop**: Control script execution via `start()` and `stop()` methods
- **Scene Change Handling**: Detaches old scripts and attaches new ones when scenes change

### 6.7 Component Picker

The `BehaviorPickerService` provides a modal dialog for selecting components:

- Promise-based API: `showPicker()`
- Search and filtering by name, description, and keywords
- Category grouping (Built-in, Project) for organized display
- Integration with inspector panel for adding components

### 6.8 Inspector Integration

The Object Inspector displays a "Components" section for each node:

- Lists all attached components
- Provides button to add new components
- Enable/disable components via toggle buttons
- Remove components via delete buttons
- Components expose their parameter schemas for inline editing

### 6.9 Node Integration

Nodes store components in the `components: ScriptComponent[]` property.

Nodes implement a `tick(dt)` method that:

1. Updates all enabled components (calls `onUpdate`)
2. Recursively ticks children

### 6.10 Scene Serialization

Components are serialized in scene files as part of node definitions using the namespace prefix format:

```yaml
root:
  - id: 'node_001'
    type: 'Node3D'
    name: 'RotatingCube'
    properties:
      position: { x: 0, y: 0, z: 0 }
    components:
      - id: 'component_001'
        type: 'core:TestRotate'
        enabled: true
        config:
          rotationSpeed: 2.5
```

### 6.11 Example Component

```typescript
export class TestRotate extends Script {
  private rotationSpeed: number = 1.0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = { rotationSpeed: this.rotationSpeed };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'TestRotate',
      properties: [
        {
          name: 'rotationSpeed',
          type: 'number',
          ui: {
            label: 'Rotation Speed',
            group: 'Component',
            min: 0,
            max: 10,
            step: 0.1,
          },
          getValue: c => (c as TestRotate).config.rotationSpeed,
          setValue: (c, value) => {
            (c as TestRotate).config.rotationSpeed = Number(value);
          },
        },
      ],
      groups: { Component: { label: 'Component Parameters' } },
    };
  }

  onUpdate(dt: number): void {
    if (!this.node || !(this.node instanceof Node3D)) return;
    this.node.rotation.y += this.rotationSpeed * dt;
  }
}
```

## 6.5 Layout2D Node

### 6.5.1 Overview

Layout2D is a special 2D root node that represents the game viewport, separating it from the editor's WebGL viewport. This enables independent game layout testing across different screen sizes.

### 6.5.2 Layout2D Properties

Layout2D extends `Node2D` and provides the following properties:

- `width: number` - Game viewport width in pixels (default: 1920)
- `height: number` - Game viewport height in pixels (default: 1080)
- `resolutionPreset: ResolutionPreset` - Quick preset selection for common resolutions
- `showViewportOutline: boolean` - Toggle visual border visibility (default: true)

### 6.5.3 Resolution Presets

```typescript
enum ResolutionPreset {
  Custom = 'custom',
  FullHD = '1920x1080', // 1920x1080
  HD = '1280x720', // 1280x720
  MobilePortrait = '1080x1920', // 1080x1920
  MobileLandscape = '1920x1080', // 1920x1080
  Tablet = '1024x768', // 1024x768
}
```

### 6.5.4 Layout Recalculation

Layout2D triggers layout recalculation for all Group2D children when its size changes:

1. User changes Layout2D size/preset via inspector
2. `UpdateLayout2DSizeOperation` executes
3. `layout2d.width` and `layout2d.height` updated
4. `layout2d.recalculateChildLayouts()` called
5. For each Group2D child: `child.updateLayout(layout2d.width, layout2d.height)`
6. Recursive: children update their own children with inherited dimensions

### 6.5.5 Key Constraints

- Layout2D size is **independent** of editor viewport size
- Editor viewport resize does NOT change Layout2D dimensions
- Layout2D can only be resized via inspector properties (width/height or preset)
- Layout2D visibility state cascades to all children

### 6.5.6 Visual Representation

- Purple dashed border (0x9b59b6) when `showViewportOutline` is true
- Border visibility can be toggled via checkbox in inspector
- Children (Group2D, Sprite2D) render normally within Layout2D bounds

## 6.12 Autoload Scripts and Asset Browser Template Flow

Pix3 supports project-level autoload scripts configured in `pix3project.yaml` under `autoloads`.
Each autoload entry includes:

- `scriptPath` - file path relative to project root (for example, `scripts/Events.ts`)
- `singleton` - global singleton name
- `enabled` - whether the autoload is active

Autoload management is available in two editor entry points:

- **Project Settings > Autoload tab** for add/remove/enable/reorder.
- **Asset Browser > Create dropdown > Create autoload script** for fast scaffolding.

When `Create autoload script` is used, the editor:

1. Prompts for a singleton name.
2. Creates `scripts/<SingletonName>.ts` from the autoload template.
3. Triggers project script compilation.
4. Adds the autoload entry to `pix3project.yaml`.
5. Reveals the created script in the Asset Browser.

### 6.12.1 Autoload Runtime Model

- Autoload scripts are instantiated as script components and attached to an internal global root node.
- They are initialized from project manifest order and persist across scene changes.
- They are ticked before active-scene root nodes.
- They are not serialized into `.pix3scene` files.

### 6.12.2 `pix3project.yaml` Example

```yaml
version: 1.0.0
autoloads:
  - scriptPath: scripts/Events.ts
    singleton: Events
    enabled: true
  - scriptPath: scripts/GameManager.ts
    singleton: GameManager
    enabled: true
```

## 6.13 Signals Engine

Pix3 provides a node-local signal system on `NodeBase` for script-to-script communication.

### 6.13.1 API

- `signal(name)` - declares a signal channel (optional but recommended).
- `connect(signalName, target, method)` - subscribes target method.
- `emit(signalName, ...args)` - dispatches event payload to subscribers.
- `disconnect(signalName, target, method)` - removes one specific subscription.
- `disconnectAll(signalName?)` - clears one signal or all signal subscriptions on the emitter node.
- `disconnectAllFromTarget(target)` - removes all subscriptions matching a target object.

### 6.13.2 Lifecycle Safety

- `Script.onDetach()` base implementation automatically calls `node.disconnectAllFromTarget(this)`.
- This avoids leaking listeners tied to detached script instances.
- Preferred connection style: `node.connect('signal_name', this, this.onSomething)`.
- Avoid using `.bind(this)` when connecting signals; bound functions are harder to match for exact disconnects.

### 6.13.3 Example

```typescript
// emitter
this.node?.signal('score_changed');
this.node?.emit('score_changed', scoreValue);

// listener
playerNode.connect('score_changed', this, this.onScoreChanged);

private onScoreChanged(newScore: number): void {
  // update UI
}
```

## 6.14 Groups Engine

Groups provide runtime categorization for nodes (for example, `enemies`, `ui`, `interactables`).

### 6.14.1 Node API

- `addToGroup(group)`
- `removeFromGroup(group)`
- `isInGroup(group)`

### 6.14.2 Scene API

`SceneManager` provides group-based queries and invocation:

- `getNodesInGroup(group)` - returns matching nodes in the active scene.
- `callGroup(group, method, ...args)` - calls matching component methods across grouped nodes.

`callGroup` performs runtime method checks and warns if no callable method is found.

### 6.14.3 Serialization

Groups are serialized in `.pix3scene` nodes via `groups: []`.

```yaml
root:
  - id: player_001
    type: Node3D
    name: Player
    groups: [actors, player]
```

## 6.15 Node Prefabs System

### 6.15.1 Overview

Pix3 supports a prefab system for reusing node hierarchies across scenes. Prefabs are standard `.pix3scene` files that can be instantiated (instanced) in other scenes. When a node branch is saved as a prefab, it becomes a reusable asset that can be placed multiple times in any scene. Changes to the source prefab can be propagated to all instances.

### 6.15.2 Prefab Metadata

Each prefab instance stores metadata in `node.metadata.__pix3Prefab`:

```typescript
interface PrefabMetadata {
  localId: string; // Node's original ID in the prefab file
  effectiveLocalId: string; // Current effective local ID
  instanceRootId: string; // ID of the root node of this instance
  sourcePath: string; // Path to the source prefab file (res://...)
  basePropertiesByLocalId?: Record<string, Record<string, unknown>>; // Original property values
}
```

### 6.15.3 Prefab Utilities

The `prefab-utils.ts` module provides helper functions:

- `getPrefabMetadata(node)` - Returns prefab metadata or null if not a prefab node
- `isPrefabNode(node)` - True if node is linked to a prefab
- `isPrefabInstanceRoot(node)` - True if node is the root of a prefab instance
- `isPrefabChildNode(node)` - True if node is a child within a prefab instance
- `findPrefabInstanceRoot(node)` - Walks up the parent chain to find the instance root

### 6.15.4 Instance Creation

Creating a prefab instance uses the `instance:` YAML key:

```yaml
root:
  - id: scene_root
    type: Node3D
    children:
      - id: player_instance_1
        instance: res://prefabs/player.pix3scene
        name: Player1
        properties:
          position: { x: 0, y: 0, z: 0 }
```

The `properties` block allows overriding base prefab values. Overrides are tracked separately from the base values.

### 6.15.5 Prefab Operations

The prefab lifecycle is managed by these operations:

1. **CreatePrefabInstanceOperation** - Instantiates a prefab file as nodes in the active scene
   - Parses the prefab file
   - Creates nodes with prefab metadata
   - Registers nodes in scene graph
   - Updates hierarchy state and selection
   - Accepts an optional `viewportScreenPoint` to position a root-level drop at the cursor (Node2D vs Node3D resolved via `ViewportRendererService`)

2. **SaveAsPrefabOperation** - Saves a selected node branch as a prefab file
   - Serializes the selected node and its children to YAML
   - Writes to the specified prefab path
   - Replaces the original nodes with a single instance reference
   - Preserves undo/redo for the replacement

3. **RefreshPrefabInstancesOperation** - Rebuilds instance hierarchy from source prefab
   - Triggered when source prefab files change (via FileWatchService)
   - Can target a specific prefab path or refresh all instances
   - Preserves property overrides while updating base structure

4. **UnlinkPrefabInstanceOperation** (Unity "Unpack Prefab") - Converts an instance into plain, editable nodes
   - Strips `__pix3Prefab` markers from the outer instance and clears its `instancePath`, so its nodes serialize as ordinary children
   - **Nested instances stay linked**: their markers are re-rooted onto themselves (`instanceRootId`/`effectiveLocalId` recomputed relative to the nested root) and their `basePropertiesByLocalId` is rebuilt by freshly parsing the nested source prefab, so they keep round-tripping as `instance:` references with their overrides intact (empty-map fallback on read failure is lossless-but-verbose)
   - Shallow (one level); undo/redo restore before/after marker+`instancePath` snapshots without a scene reparse, so node identity and the rest of undo history survive
   - `OpenPrefabCommand` (not an operation; opens a tab) opens an instance's source prefab in its own scene tab, optionally pre-selecting the corresponding node by `localId`

### 6.15.6 Inspector Integration

When inspecting a node that is part of a prefab instance:

- Base prefab values are displayed alongside current values
- A "Revert" button allows resetting overridden properties to base values
- Visual indicators distinguish between base values and overrides
- `getPrefabBaseValueForProperty()` retrieves original values for comparison
- Component actions are locked on instance nodes: **Add/Remove/Enable/Disable Component** and **component property value editors** are disabled on every instance node (component config is not serialized as an override), and the **name** field is disabled on instance children (the root keeps an editable name). See §6.15.8
- **Default overrides (placement)**: on an instance **root**, `position`, `rotation`, `scale`, `name`, and the 2D anchored-layout keys (`layoutEnabled`, `horizontalAlign`, `verticalAlign`) describe where the instance sits in the host scene, not the prefab's content (Unity "default overrides"). They are **not** flagged as overrides and have no Revert button, even though they still serialize on the `instance:` definition — so moving, scaling, or anchoring an instance (e.g. pinning a panel to a window edge) is placement, not a content edit. The same properties on a child (or a nested-instance root) remain real content overrides. Implemented via `isInstancePlacementProperty` (`src/features/scene/prefab-utils.ts`)

### 6.15.7 Scene Tree Integration

The scene tree distinguishes prefab nodes:

- **Prefab root** (🔗) - Marks the root of a prefab instance; accent-colored name
- **Prefab child** - Dimmed row (~80% opacity), a small lock glyph, and a tooltip explaining the node is instance-locked
- Instance roots are **collapsed by default** on scene load (once per load; user expand/collapse toggles are preserved afterward). Selecting a node still auto-expands its ancestors
- **Double-click** a prefab node (root or child) opens its source prefab in a scene tab (a child pre-selects its corresponding node)
- Context menu is prefab-aware: shows **Open Prefab** for any instance node and **Unlink Prefab Instance** for an instance root; hides Duplicate/Group/Delete/Save-as-Prefab for prefab children; keeps them for instance roots

### 6.15.8 Structural Editing & Instance Lock

An instance's child structure is owned by its prefab file, and the save format only round-trips **property** overrides (`instance:` + root `properties:` + `overrides.byLocalId`). Structural edits inside an instance are therefore **not representable** and would be silently lost on save, so they are blocked at every entry point:

- Dragging/reparenting a prefab child (blocked in `canDropNode` and refused at drag start)
- Dropping or creating any node **inside** an instance subtree (blocked in `canDropNode`, the scene-tree asset-drop handler, and `node-placement` which redirects creation to the nearest non-prefab ancestor)
- Duplicating or grouping prefab children (filtered in the operations; commands report a reason)
- Adding/removing/toggling components and editing component property values on **any** instance node, and renaming prefab **children** (disabled in the Inspector; guarded in `AddComponentCommand`/`RemoveComponentCommand`/`UpdateComponentPropertyCommand`/`ToggleScriptEnabledCommand`)

Instance **roots** stay fully editable structurally (move, delete, duplicate as a second instance, rename). To edit an instance's contents in place, either open the prefab (edit the source) or **Unlink** the instance to convert it to plain nodes (§6.15.5). Deleting a prefab child is also blocked (`DeleteObjectOperation`).

### 6.15.9 Auto-Refresh Workflow

1. User modifies and saves a prefab file externally (e.g., in VS Code) or in its own editor tab
2. FileWatchService detects the file change
3. EditorShell's `handleFileChanged()` triggers `RefreshPrefabInstancesCommand`; switching back to a scene tab also refreshes its instances on activation
4. All instances referencing that prefab are rebuilt
5. Property overrides are preserved during refresh

## 6.16 Keyframe Animation System

Godot/Unity-style keyframe animation of node properties with tweened interpolation and audio cues. Runtime lives in `packages/pix3-runtime/src/animation/`; the editor UI is the bottom-docked **Animation** timeline panel (`animation-timeline`).

### 6.16.1 Runtime Model

- **`core:AnimationPlayer`** is a built-in script component (`AnimationPlayerBehavior`), registered like other behaviors. It plays clips on its host node and the host's descendants.
- Clip data lives in the component's `config.animations` (`KeyframeAnimationSet`), so it serializes with the scene verbatim — no SceneLoader/SceneSaver changes, and collaboration sync rides along with scene snapshots.
- Data model (`animation/keyframe-types.ts`, all plain JSON): `KeyframeAnimationSet { version, clips[] }` → `KeyframeClip { name, duration, loop, tracks[] }` → property tracks (`{ targetPath, property, valueType, keys: [{ time, value, easing }] }`), audio tracks (`{ name, keys: [{ time, audioPath, volume }] }`), and event tracks (`{ name, targetPath, keys: [{ time, signal, args }] }`). Vector values are stored as arrays (`[x, y]`, `[x, y, z]`); rotations are stored in **degrees** (the property schema converts to radians internally). `normalizeKeyframeAnimationSet()` defensively coerces arbitrary data; the component's hidden `animations` schema property applies it on scene load.
- **Event tracks** are the cutscene glue: when the playhead crosses a key it emits `signal` on the track's target node (`emit(signal, ...args)`), so a single clip can synchronize camera, VFX, audio, and gameplay. `args` is a raw string parsed by `parseEventArgs()` at fire time — empty → no args, a JSON array → spread, any other JSON → one arg, unparseable text → the raw string as one arg. Gameplay scripts (typically on the host node) `connect()` to these signals; the signal engine already routes them.
- **Track targeting** uses relative name paths from the host node (`''` = host itself, `'Child/GrandChild'` with `findByPath` semantics). Name paths survive prefab instancing (node ids are regenerated on instantiation, names are not); renaming a targeted node breaks the track and surfaces a warning icon in the timeline.
- **Evaluation** (`animation/clip-evaluator.ts`): pure sampling (`sampleTrack`, hold semantics outside the key range, per-segment easing from the left key) plus a node-applying layer (`createClipBindings` resolves targets/schema once, `applyClipAtTime` writes through `PropertyDefinition.setValue`). Easing curves (`animation/easing.ts`): `linear`, `step`, and Penner sine/quad/cubic/expo/back/elastic/bounce × in/out/inOut. Discrete types (boolean/string) always step. Colors interpolate per sRGB channel.
- **Playback**: `onUpdate(dt)` advances time × `speed`, applies the pose, and fires time-window keys — audio and events alike — crossed in `(prev, next]` (shared boundary rule in `collectTimedKeysInRange`, loop-wrap aware; `fireTimeWindow` runs both so each key fires exactly once per crossing). Non-looping clips clamp to the final pose and emit `animation_finished` on the host node; `play()` emits `animation_started`. Public API: `play(clipName?)`, `stop()`, `pause()/resume()`, `seek(t)`, `currentTime`, `duration`, `isPlaying`, `getAnimationSet()`, `invalidateBindings()`. `autoplay` config starts a clip in `onStart`.

### 6.16.2 Editor

- **Panel**: `pix3-animation-timeline-panel`, docked in the bottom stack next to Assets Preview/Logs. It binds to the `core:AnimationPlayer` of the selected node or its nearest ancestor; empty states offer adding the component (seeded with one clip) and creating clips. Toolbar: clip selector + clip actions (new/rename/duplicate/delete), preview transport, playhead readout, clip duration, loop, snap toggle + step, zoom, Add Track, add/delete key, easing selector for the selection.
- **Editing** flows through a single operation, `animation-timeline.update-clips` (`UpdateAnimationPlayerClipsOperation`): an updater closure mutates a normalized draft of the set; undo/redo restore whole-set snapshots. Key drags commit per pointer-move with an `options.coalesceKey` plus the drag-start set as `previousSet`, so one history entry spans the whole drag. Pure helpers live in `features/animation-timeline/clip-edit-utils.ts`.
- **Add Track** lists the host subtree with computed relative paths (ambiguous sibling names flagged), then the target's animatable schema properties (number/vector2/vector3/euler/color/boolean/string, minus hidden/read-only/already-tracked). New tracks seed a key at t=0 from the node's live value; "Add Key" captures the sampled value between keys or the live value on empty tracks. Audio keys are created by dragging audio assets onto an audio track lane. **Audio Track** and **Event Track** entries in the Add-Track menu add host-scoped tracks; event keys are inserted by double-click / right-click on the lane (seeded `signal: 'event'`) and edited via the key context menu (signal name + JSON args). Event tracks store a `targetPath` for retargeting via YAML/agents even though the button seeds the host.
- **Preview** (`AnimationTimelinePreviewService`): scrubbing/playback samples clips onto live nodes **without** dirtying the scene, touching history, or bumping `nodeDataChangeSignal`. Original values are snapshotted per animated property on session start and restored on stop. Guards via `OperationService` events: scene saves restore authored values before serialization and re-apply after; undo/redo or any foreign mutating operation (including play-mode start) ends the preview; the panel's own clip edits refresh bindings in place. Audio keys are audible during preview playback (not while scrubbing); event keys also fire during preview (a no-op in the editor since no game scripts are connected, but timing stays WYSIWYG with play mode).
- Panel-local shortcuts (local keydown listener, not global keybindings): Space play/pause, Delete removes selected keys, arrows nudge keys/playhead by the snap step (Shift ×5), Home/End jump the playhead.

## 7. Scene File Format (\*.pix3scene)

The scene file uses the YAML format to ensure readability for both humans and machines (including AI agents).

### 7.1 Key Principles

- Declarative: The file describes the composition and structure of the scene, not the process of its creation.
- Asset Referencing: Assets (models, textures) are not embedded in the file but are referenced via relative paths with a res:// prefix (path from the project root).
- Composition: Complex scenes are assembled from simpler ones by instantiating other scene files.
- Unambiguous Structure: An explicit children key is used to denote the list of child nodes, which separates the hierarchy from the properties of the node itself.
- Unique Identification: Every node must have an id field. The value is a short, cryptographically secure unique identifier (similar to Nano ID) to provide a balance between file readability and the absolute reliability of references.
- Versioned Schema: Each file includes a `version` field; migrations are maintained in the SceneManager and run automatically on load.
- Conflict Resolution: Instance overrides always win over parent definitions. Duplicate IDs trigger validation errors during import.

### 7.2 Example Structure

```yaml
# --- Metadata ---
version: 1.0
description: 'Main scene for the first level'

# --- Node Hierarchy ---
root:
  # Each node has a unique ID, type, name, and properties
  - id: 'V1StGXR8_Z5jdHi6B-myT'
    type: 'Node3D'
    name: 'World'
    properties:
      position: { x: 0, y: 0, z: 0 }
      rotation: { x: 0, y: 0, z: 0 }

    # Explicit definition of child nodes for clarity
    children:
      - id: 'b-s_1Z-4f8_c-9T_2f-3d'
        # Instance of another scene (prefab)
        instance: 'res://scenes/player.pix3scene'
        name: 'Player'
        properties:
          # Overriding instance properties
          position: { x: 0, y: 1, z: 5 }

      - id: 'k-9f_8g-7h_6j-5k_4l-1'
        type: 'MeshInstance3D'
        name: 'Ground'
        properties:
          # Reference to an asset
          mesh: 'res://assets/models/ground_plane.glb'
          scale: { x: 100, y: 1, z: 100 }
```

### 7.3 Validation Rules

- The root section must contain at least one node entry.
- All node IDs must be unique across the entire resolved scene graph.
- `instance` entries must point to existing `.pix3scene` files; SceneManager resolves relative to project root.
- Optional `metadata` block can include analytics tags, localization keys, and QA notes.
- Continuous integration should run schema validation (AJV + generated JSON schema) against committed scene files.

## 9. MVP (Minimum Viable Product) Plan

- Establish Vite + TypeScript + Lit project with ESLint, Prettier, Vitest, and CI lint/test workflows.
- Implement the basic architecture: AppState with Valtio, Command pattern contracts, and DI container wiring.
- Integrate FileSystemAPIService to open a project folder, list assets, and load `.pix3scene` files.
- Integrate Golden Layout to create a basic layout: Scene Tree, Viewport, Inspector, Asset Browser. Provide layout presets.
- Implement rendering of a simple 3D scene in the viewport using Three.js, including an orthographic pass for 2D overlays.
- Create SceneManager to parse and display the scene structure (`*.pix3scene`) and expose diff events.
- Implement commands for creating primitives (boxes, lights, cameras, sprites) with undoable operations.
- Implement a basic Undo/Redo system using HistoryManager, wired to keyboard shortcuts and UI controls.
- Implement property schema system for dynamic inspector UI generation.
- Implement scene save/load/reload with file watch for external changes.
- Deliver a playable-ad export preset (HTML bundle) and analytics logging stub.

## 10. Non-Functional Requirements

- **Performance:** Maintain ≥ 85 FPS in viewport on baseline hardware. Initial load (cold) < 6s, warm reload < 2s. Command execution should visually update UI within 80ms.
- **Accessibility:** WCAG 2.1 AA minimum for editor chrome; ensure keyboard navigation for panel focus and command palette. Provide high-contrast theme preset.
- **Security & Privacy:** Avoid storing project contents on Pix3 servers. Request File System Access permissions per session and cache handles using IndexedDB with user consent. Plugins run in isolated workers and require explicit permission to access services.
- **Reliability:** Autosave layout and session state every 30 seconds. Maintain undo history for at least the last 100 commands.
- **Internationalization:** UI copy uses i18n keys; English and Russian shipped at MVP. YAML scenes may include localized strings via `locale` blocks.

## 11. Project Structure

```
/
├── dist/                     # Build output (generated)
├── public/                   # Static assets (logo, icons)
├── src/
│   ├── core/                 # Core business logic and managers
│   │   ├── AssetLoader.ts
│   │   ├── BulkOperation.ts
│   │   ├── command.ts        # Command/Operation base contracts
│   │   ├── HistoryManager.ts
│   │   ├── LayoutManager.ts
│   │   ├── Operation.ts
│   │   ├── SceneLoader.ts
│   │   ├── SceneSaver.ts
│   │   └── SceneManager.ts   # Owns SceneGraph and Node lifecycle (non-reactive)
│   ├── features/             # Feature-specific commands and operations
│   │   ├── history/
│   │   │   ├── RedoCommand.ts
│   │   │   └── UndoCommand.ts
│   │   ├── properties/
│   │   │   ├── Transform2DCompleteOperation.ts
│   │   │   ├── TransformCompleteOperation.ts
│   │   │   ├── UpdateObjectPropertyCommand.ts
│   │   │   └── UpdateObjectPropertyOperation.ts
      │   │   ├── scene/
      │   │   │   ├── AddModelCommand.ts
      │   │   │   ├── CreateBoxCommand.ts
      │   │   │   ├── CreateCamera3DCommand.ts
      │   │   │   ├── CreateDirectionalLightCommand.ts
      │   │   │   ├── CreateGroup2DCommand.ts
      │   │   │   ├── CreateLayout2DCommand.ts
      │   │   │   ├── CreateMeshInstanceCommand.ts
      │   │   │   ├── CreatePointLightCommand.ts
      │   │   │   ├── CreateSpotLightCommand.ts
      │   │   │   ├── CreateSprite2DCommand.ts
      │   │   │   ├── CreatePrefabInstanceCommand.ts
      │   │   │   ├── CreatePrefabInstanceOperation.ts
      │   │   │   ├── DeleteObjectCommand.ts
      │   │   │   ├── LoadSceneCommand.ts
      │   │   │   ├── prefab-utils.ts
      │   │   │   ├── RefreshPrefabInstancesCommand.ts
      │   │   │   ├── RefreshPrefabInstancesOperation.ts
      │   │   │   ├── ReloadSceneCommand.ts
      │   │   │   ├── ReparentNodeCommand.ts
      │   │   │   ├── SaveAsPrefabCommand.ts
      │   │   │   ├── SaveAsPrefabOperation.ts
      │   │   │   ├── SaveAsSceneCommand.ts
      │   │   │   ├── SaveSceneCommand.ts
      │   │   │   └── UpdateLayout2DSizeCommand.ts
│   │   └── selection/
│   │       ├── SelectObjectCommand.ts
│   │       └── SelectObjectOperation.ts
│   ├── fw/                   # Framework utilities (ComponentBase, DI, property schema)
│   │   ├── component-base.ts # Extends LitElement with light DOM default
│   │   ├── di.ts             # Dependency injection container
│   │   ├── from-query.ts
│   │   ├── hierarchy-validation.ts
│   │   ├── index.ts
│   │   ├── layout-component-base.ts
│   │   ├── property-schema.ts
│   │   └── property-schema-utils.ts
│   ├── nodes/                # Node definitions (NOT in reactive state)
│   │   ├── Node2D.ts
│   │   ├── Node3D.ts
│   │   ├── NodeBase.ts       # Extends Three.js Object3D; purely data/logic
      │   │   ├── 2D/
      │   │   │   ├── Group2D.ts
      │   │   │   ├── Layout2D.ts
      │   │   │   └── Sprite2D.ts
│   │   └── 3D/
│   │       ├── Camera3D.ts
│   │       ├── DirectionalLightNode.ts
│   │       ├── GeometryMesh.ts
│   │       ├── MeshInstance.ts
│   │       ├── PointLightNode.ts
│   │       └── SpotLightNode.ts
│   ├── services/             # Injectable services
│   │   ├── AssetFileActivationService.ts
│   │   ├── CommandDispatcher.ts  # Primary entry point for all actions
│   │   ├── CommandRegistry.ts     # Command registration and menu building
│   │   ├── DialogService.ts
│   │   ├── FileWatchService.ts    # Watches for external file changes
│   │   ├── FileSystemAPIService.ts
│   │   ├── FocusRingService.ts
│   │   ├── IconService.ts         # Centralized management of scalable vector icons
│   │   ├── LoggingService.ts      # Centralized logging for editor
│   │   ├── NodeRegistry.ts
│   │   ├── OperationService.ts   # Executes operations; gateway for mutations
│   │   ├── ProjectService.ts
│   │   ├── ResourceManager.ts
│   │   ├── TemplateService.ts
│   │   ├── TransformTool2d.ts
│   │   ├── ViewportRenderService.ts
│   │   └── index.ts
│   ├── state/                # Valtio app state definitions (UI, metadata, selection only)
│   │   ├── AppState.ts       # Defines reactive state shape; no Nodes here
│   │   └── index.ts
│   ├── templates/            # Project templates
│   │   ├── pix3-logo.png
│   │   ├── startup-scene.pix3scene
│   │   └── test_model.glb
│   ├── ui/                   # Lit components extending ComponentBase
│   │   ├── pix3-editor-shell.ts
│   │   ├── pix3-editor-shell.ts.css
│   │   ├── assets-browser/
│   │   │   ├── asset-browser-panel.ts
│   │   │   ├── asset-browser-panel.ts.css
│   │   │   ├── asset-tree.ts
│   │   │   └── asset-tree.ts.css
│   │   ├── logs-view/
│   │   │   ├── logs-panel.ts
│   │   │   └── logs-panel.ts.css
│   │   ├── object-inspector/
│   │   │   ├── inspector-panel.ts
│   │   │   ├── inspector-panel.ts.css
│   │   │   └── property-editors.ts
│   │   ├── scene-tree/
│   │   │   ├── node-visuals.helper.ts
│   │   │   ├── scene-tree-node.ts
│   │   │   ├── scene-tree-node.ts.css
│   │   │   ├── scene-tree-panel.ts
│   │   │   └── scene-tree-panel.ts.css
│   │   ├── shared/
│   │   │   ├── pix3-confirm-dialog.ts
│   │   │   ├── pix3-dropdown.ts
│   │   │   ├── pix3-main-menu.ts
│   │   │   ├── pix3-panel.ts
│   │   │   ├── pix3-toolbar.ts
│   │   │   └── pix3-toolbar-button.ts
│   │   ├── viewport/
│   │   │   ├── transform-toolbar.ts
│   │   │   ├── viewport-panel.ts
│   │   │   └── viewport-panel.ts.css
│   │   └── welcome/
│   │       ├── pix3-welcome.ts
│   │       └── pix3-welcome.ts.css
```

## 12. Roadmap and Milestones

1. **Milestone 0 — Foundation (completed):** Repo bootstrap, DI utilities, layout shell, state scaffolding, CI pipeline.
2. **Milestone 1 — Scene Authoring (completed):** SceneManager MVP, viewport rendering loop, asset browser, primitive tools, property schema system.
3. **Milestone 2 — Playable Export (in progress):** Export preset, analytics stub, undo/redo polish, plugin SDK docs.
4. **Milestone 3 — Collaboration Preview (future):** Shared sessions, commenting, live cursors (post-MVP).

## 13. Change Log

- **1.5 (2025-09-26):** Added target platforms, non-functional requirements, detailed architecture contracts, validation rules, and roadmap updates. Synced guidance on `fw` helpers.
- **1.7 (2025-10-01):** Removed PixiJS dual-engine plan; consolidated rendering to single Three.js pipeline (perspective + orthographic). Updated project structure, removed obsolete adapter references, clarified rendering notes.
- **1.8 (2025-10-05):** Adopted operations-first model. Commands are thin wrappers that delegate to `OperationService`. UI invokes operations directly. Code organized into `core/features/*/{commands,operations}`. Deprecated `CommandOperationAdapter` in documentation.
- **1.9 (2025-10-27):** Updated to reflect current architecture where Nodes are NOT in reactive state. Nodes are managed by SceneManager in SceneGraph objects. State contains only UI, scenes metadata, and selection IDs. CommandDispatcher Service is the primary entry point for all actions. Updated project structure section to annotate (non-reactive) for nodes and clarify state boundaries. Enhanced implementation status with current feature list.
- **1.10 (2025-12-30):** Added comprehensive Property Schema System section (5.0-5.5). Updated technology stack to include Pixi.js v8 for 2D rendering alongside Three.js. Added LoggingService and FileWatchService to architecture. Updated feature list to reflect all implemented commands/operations. Added vector4 property type. Updated MVP plan and roadmap to reflect completed milestones. Added format:check script to project scripts.
- **1.11 (2025-12-30):** Removed Pixi.js from technology stack. Updated to Three.js-only rendering pipeline. Removed Pixi.js references from architecture notes and rendering architecture sections. Updated MVP plan to remove 2D rendering requirements via Pixi.js. Added details about the Icon Service under the Services section.
- **1.12 (2026-01-01):** Added Script Component System section (6.0-6.11). Implemented behaviors and controller scripts attachments in inspector. Nodes now support `behaviors` array and optional `controller`. Added ScriptRegistry service for registering script types. Added BehaviorPickerService for modal dialog. Added ScriptExecutionService for game loop and script lifecycle management. Added commands for Attach/DetachBehavior, Set/ClearController, ToggleScriptEnabled, PlayScene, StopScene. Updated inspector panel to display "Scripts & Behaviors" section. Updated scene tree to show script indicators. Updated project structure to include `behaviors/` directory and `features/scripts/`. Added example RotateBehavior implementation. Updated node lifecycle with `tick(dt)` method for script updates.
- **1.13 (2026-02-03):** Added Layout2D Node System section (6.5). Implemented Layout2D node class in `packages/pix3-runtime/src/nodes/2D/Layout2D.ts` with properties for width, height, resolutionPreset, and showViewportOutline. Added Layout2D YAML parsing support in SceneLoader with Layout2DProperties interface. Modified SceneManager to add `skipLayout2D` parameter to `resizeRoot()` and `findLayout2D()` helper method. Created CreateLayout2DCommand/Operation and UpdateLayout2DSizeCommand/Operation for mutation support. Updated ViewportRenderService with `layout2dVisuals` map, `createLayout2DVisual()` method (purple dashed border), and Layout2D handling in processNodeForRendering, syncAll2DVisuals, updateNodeTransform, and updateNodeVisibility. Removed isViewportContainer property from Group2D and all related logic. Updated startup scene template to use Layout2D root instead of Group2D. Layout2D size is now independent of editor viewport and only changeable via inspector properties.
- **1.14 (2026-02-23):** Added project autoload manifest support (`pix3project.yaml`) with editor commands/operations for add/remove/toggle/reorder. Added node-local signal and group APIs, scene group serialization, and inspector group editing UI. Added Asset Browser create action `Create autoload script` that scaffolds a template script in `scripts/`, compiles scripts, and auto-registers the singleton in project autoloads.
- **1.15 (2026-02-26):** Added Node Prefabs System section (6.15). Prefabs are `.pix3scene` files instanced via `instance:` YAML key. Added PrefabMetadata interface stored in node metadata with localId, effectiveLocalId, instanceRootId, sourcePath, and basePropertiesByLocalId. Added prefab-utils.ts with getPrefabMetadata, isPrefabNode, isPrefabInstanceRoot, isPrefabChildNode, and findPrefabInstanceRoot helpers. Implemented CreatePrefabInstanceOperation, SaveAsPrefabOperation, and RefreshPrefabInstancesOperation. Added corresponding commands. Inspector shows base prefab values with revert override capability. Scene tree displays prefab badges. FileWatchService triggers auto-refresh when prefab files change.
- **1.16 (2026-07-04):** Added Keyframe Animation System section (6.16). New runtime module `packages/pix3-runtime/src/animation/` (easing curves, JSON keyframe clip model with defensive normalization, pure clip evaluator, `AnimationPlayerBehavior` registered as `core:AnimationPlayer`). Clips serialize inside the component `config`; tracks target nodes by relative name paths (prefab-safe). New bottom-docked Animation timeline panel (`animation-timeline`) with clip management, property/audio tracks, keyframe drag with snap and coalesced undo, per-key easing, and a scrub/playback preview service (`AnimationTimelinePreviewService`) that snapshots and restores node state without dirtying the scene, guarded against saves, undo/redo, and play-mode start.
