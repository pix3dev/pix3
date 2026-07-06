Excellent refinements! These improvements strengthen the design significantly. Let me update the plan to incorporate your suggestions:

## Plan: Godot-Style Global Scripts, Signals & Groups (Revised)

This plan adds **autoload scripts** (persisting between scenes), **signal system** (node-local with proper cleanup), and **groups** (persistent node categorization) following Godot Engine patterns. Autoload scripts are configured in `pix3project.yaml`, attached to a hidden `GlobalRootNode` for child node support. Signals use context-aware binding to prevent memory leaks. Groups include runtime type safety for method calls.

**TL;DR**: Create project config format with autoload section. Extend NodeBase with signals using `connect(signal, target, method)` signature for automatic cleanup. Add GlobalRootNode for autoload scripts (enables child nodes). Implement lifecycle hooks to instantiate autoloads on project load. Update SceneLoader/SceneSaver to serialize groups. Add runtime validation to `callGroup()`. Create commands/operations for group management and UI panels for configuration.

**Steps**

### 1. Project Configuration File

**Create project manifest structure**
- Add src/core/ProjectManifest.ts with TypeScript interfaces:
  - `ProjectManifest` - root structure with `version`, `autoloads`, `metadata`
  - `AutoloadConfig` - `{ scriptPath: string, singleton: string, enabled: boolean }`
  - Example: `autoloads: [{ scriptPath: 'Scripts/GameManager.ts', singleton: 'GameManager', enabled: true }]`
- Add packages/pix3-runtime/src/core/ProjectManifest.ts with runtime-compatible subset
- Update ProjectService.ts to load/save `pix3project.yaml` from project root
  - Add `loadProjectManifest()` - parse YAML, validate schema, return `ProjectManifest`
  - Add `saveProjectManifest(manifest)` - serialize to YAML with comments explaining autoload format
  - Hook into `openProject()` to load manifest after project folder is opened
  - Store manifest in `appState.project.manifest`

### 2. Autoload Script System

**Implement GlobalRootNode for autoload attachment**
- Update src/services/AutoloadService.ts (new file):
  - `@injectable()` singleton service
  - `private globalRoot: NodeBase` - persistent hidden root node, never rendered or serialized
  - `autoloadInstances: Map<string, Script>` - singleton name → script instance
  - `initialize(manifest: ProjectManifest)` - called after project load
    - Create `globalRoot = new NodeBase()` with `id: '__global_root__'`, `name: 'GlobalRoot'`, `visible: false`
    - For each enabled autoload: compile script → instantiate → add to globalRoot as component
    - Call `component.onAttach(globalRoot)` - now autoloads have parent node for child creation
    - Store in map by singleton name for global access
  - `cleanup()` - call `onDetach()` on all autoloads, clear globalRoot children, clear map
  - `get(singletonName: string): Script | undefined` - accessor for scripts to reference autoloads
  - `getGlobalRoot(): NodeBase` - expose for advanced use cases (e.g., adding global UI overlays)
  - Inject `ScriptRegistry`, `ProjectScriptLoaderService`
- Update SceneRunner.ts to initialize autoloads before first scene
  - Call `AutoloadService.initialize()` after services registered
  - Ensure autoloads persist across `loadScene()` calls
- Update ScriptExecutionService.ts:
  - In `start()`: call `onStart()` on autoload instances before scene scripts
  - In `tick()`: call `globalRoot.tick(dt)` BEFORE scene root nodes (autoloads update first)
  - In `onSceneChanged()`: do NOT detach autoloads (they persist)
  - In `stop()`: do NOT detach autoloads (they stay loaded)

**Document GlobalRootNode pattern**
- Autoload scripts can create child nodes: `this.node.add(new Sprite2D())` for global UI
- GlobalRoot is never serialized, never visible in scene tree panel
- Example use case: AudioManager autoload creates 3D audio listener node as child

### 3. Signals System (Node-Local with Context Binding)

**Extend NodeBase with memory-safe signal methods**
- Update NodeBase.ts:
  - Add type: `SignalConnection = { target: unknown; method: Function }`
  - Add `private _signals: Map<string, Set<SignalConnection>>` - signal name → connections
  - Add `signal(name: string): void` - declare a signal (optional, for clarity)
  - Add `emit(name: string, ...args: unknown[]): void` - invoke all connected methods with args
    - Iterate connections, call `connection.method.call(connection.target, ...args)`
  - Add `connect(signalName: string, target: unknown, method: Function): void`
    - Store `{ target, method }` in signal's connection set
    - Example: `player.connect('health_changed', this, this.onHealthChanged)`
  - Add `disconnect(signalName: string, target: unknown, method: Function): void`
    - Remove matching connection by reference equality
    - Example: `player.disconnect('health_changed', this, this.onHealthChanged)`
  - Add `disconnectAll(signalName?: string): void` - clear all connections for signal or all signals
  - Add `disconnectAllFromTarget(target: unknown): void` - **critical cleanup method**
    - Iterate all signals, remove all connections where `connection.target === target`
    - Called automatically in script `onDetach()` lifecycle

**Automatic cleanup in Script base class**
- Update ScriptComponent.ts:
  - In `Script.onDetach()` base implementation:
    ```typescript
    onDetach(): void {
      // Automatically disconnect all signal connections from this script
      if (this.node) {
        this.node.disconnectAllFromTarget(this);
        // Also disconnect from all nodes in scene (requires SceneGraph traversal)
        // OR: document that scripts must store connected nodes and manually disconnect
      }
    }
    ```
  - Add documentation comment: scripts should call `node.disconnectAllFromTarget(this)` in onDetach if connecting to external nodes

**Signal serialization (defer to post-MVP)**
- Godot serializes signal connections - consider for future
- For MVP: signals are code-driven only (scripts call `connect()` in `onStart()`)
- Add TODO comment in NodeBase for future scene format support

### 4. Global Event Bus Pattern (Autoload-Based, No Dedicated Service)

**Remove GlobalSignals service from plan**
- **Do NOT create** `src/services/GlobalSignals.ts`
- Instead, document pattern: create user autoload script `Scripts/Events.ts`
  - Extends `Script`, declares signals: `signal('game_over')`, `signal('level_complete')`
  - Other scripts access via: `AutoloadService.get('Events').connect('game_over', this, this.onGameOver)`
  - Emit via: `AutoloadService.get('Events').emit('game_over', reason)`
- Benefits: consistent API (all signals on nodes/scripts), no special global service, true Godot pattern

**Document in specification**
- Add to section 6.13 "Signals System": example Events.ts autoload for global events
- Show pattern: `const events = AutoloadService.get('Events'); events.connect('score_changed', this, this.updateUI)`

### 5. Groups System

**Extend NodeBase with groups**
- Update NodeBase.ts:
  - Add `groups: Set<string> = new Set()` property
  - Add `addToGroup(group: string): void` - add to set, notify SceneGraph
  - Add `removeFromGroup(group: string): void` - remove from set, notify SceneGraph
  - Add `isInGroup(group: string): boolean` - check membership
  - Add to property schema: `{ name: 'groups', type: 'object', getValue: ..., setValue: ... }`
- Update packages/pix3-runtime/src/core/SceneGraph.ts:
  - Add `private groupMap: Map<string, Set<NodeBase>>` - group name → nodes
  - Add `addNodeToGroup(node, group)` - update map
  - Add `removeNodeFromGroup(node, group)` - update map
  - Add `getNodesInGroup(group): NodeBase[]` - query nodes
  - Add `callGroup(group: string, method: string, ...args: unknown[]): void` - **with runtime type safety**
    - Get nodes: `const nodes = this.groupMap.get(group) ?? []`
    - For each node: iterate `node.components`
    - For each component: `if (typeof component[method] === 'function') { component[method](...args); }`
    - Log warning if method not found on any component: `console.warn(\`Method ${method} not found on component ${component.type}\`)`
  - Update when nodes added/removed from scene: rebuild group map
- Update SceneManager.ts:
  - Expose `getNodesInGroup(group: string): NodeBase[]` - delegates to active SceneGraph
  - Expose `callGroup(group, method, ...args)` - delegates to active SceneGraph with validation

**Serialize groups in scene files**
- Update SceneLoader.ts:
  - Parse `groups: string[]` from YAML node definition
  - Call `node.addToGroup(group)` for each group after node creation
- Update SceneSaver.ts:
  - Serialize `groups: Array.from(node.groups)` in node definition
  - Only include if non-empty (cleaner YAML)

### 6. Commands & Operations

**Group management commands**
- Create src/features/scene/AddNodeToGroupCommand.ts:
  - Preconditions: node exists, group name valid (non-empty string, alphanumeric + underscore)
  - Execute: invoke `AddNodeToGroupOperation`
- Create src/features/scene/AddNodeToGroupOperation.ts:
  - `perform()`: call `node.addToGroup(group)`, return commit with undo/redo
- Create src/features/scene/RemoveNodeFromGroupCommand.ts and operation
- Follow pattern from properties

**Autoload management commands**
- Create src/features/project/AddAutoloadCommand.ts:
  - Preconditions: project open, script path exists, singleton name unique
  - Execute: update `appState.project.manifest.autoloads`, save manifest
- Create src/features/project/RemoveAutoloadCommand.ts
- Create src/features/project/ToggleAutoloadEnabledCommand.ts
- Create src/features/project/ReorderAutoloadCommand.ts - affects initialization order
- Operations save manifest via `ProjectService.saveProjectManifest()`

### 7. UI Integration

**Inspector panel groups section**
- Update inspector-panel.ts:
  - Add "Groups" section after "Transform"
  - Render list of groups as tags with visual styling
  - Add text input + "Add to Group" button → `AddNodeToGroupCommand`
  - Add "×" button per group tag → `RemoveNodeFromGroupCommand`
  - Validate group name format: alphanumeric + underscore only
- Update inspector-panel.ts.css:
  - Style group tags: subtle background (`rgba(var(--pix3-accent-rgb), 0.15)`), rounded corners, padding

**Project settings panel (new)**
- Create src/ui/project-settings/project-settings-panel.ts:
  - New panel extending `ComponentBase`
  - Tabbed interface: "General", "Autoload", "Input Map" (future)
  - **Autoload tab**: 
    - Table columns: Order | Enabled | Singleton Name | Script Path | Actions
    - Drag handles for reordering → `ReorderAutoloadCommand`
    - Checkbox for enable/disable → `ToggleAutoloadEnabledCommand`
    - Trash icon → `RemoveAutoloadCommand`
    - "Add Autoload" button → file picker → `AddAutoloadCommand`
  - Show warning if script path invalid (file not found)
  - Show load order numbers (1, 2, 3...) for clarity
- Create src/ui/project-settings/project-settings-panel.ts.css
- Register panel with Golden Layout in pix3-editor-shell.ts
- Add menu command: Edit > Project Settings (shortcut: Cmd+,) → open panel

### 8. Documentation Updates

**Specification updates**
- Update pix3-specification.md:
  - Add section 6.12 "Autoload Scripts":
    - Lifecycle: attached to GlobalRootNode, persist across scenes
    - Access pattern: `AutoloadService.get('SingletonName')`
    - Child nodes: can create UI overlays, audio listeners, etc.
    - Example autoload with signals
  - Add section 6.13 "Signals System":
    - Memory-safe binding: `connect(signal, target, method)` signature
    - Automatic cleanup: `disconnectAllFromTarget(this)` in onDetach
    - Global events: use Events.ts autoload pattern (no GlobalSignals service)
    - Example: Player emits `health_changed`, UI connects with `player.connect('health_changed', this, this.updateBar)`
  - Add section 6.14 "Groups System":
    - Querying: `SceneManager.getNodesInGroup('enemies')`
    - Method calls: `SceneManager.callGroup('enemies', 'takeDamage', 10)` with runtime validation
    - Serialization: groups stored as `groups: ['enemies', 'ai']` in YAML
  - Add section 11 "Project File Format (pix3project.yaml)":
    - Structure example with autoloads array
    - Load order explanation
  - Update section 7 "Scene File Format" - add `groups: []` to node example
- Update AGENTS.md:
  - Add autoload patterns to critical rules
  - Document signal memory safety requirement (always use target/method, never .bind())
  - Add callGroup runtime validation pattern

**API examples**
- Create docs/example-scripts/Events.ts:
  - Autoload script serving as global event bus
  - Declares signals: `signal('game_over')`, `signal('level_complete')`, `signal('score_changed')`
  - Shows emit pattern: `this.emit('score_changed', newScore)`
- Create docs/example-scripts/GameManager.ts:
  - Example autoload with child nodes (creates global UI canvas)
  - Connects to Events autoload: `AutoloadService.get('Events').connect('level_complete', this, this.onLevelComplete)`
  - Shows creating child nodes on GlobalRootNode
- Create docs/example-scripts/Enemy.ts:
  - Added to `enemies` group in scene file
  - Implements `takeDamage(amount: number)` method for callGroup
  - Connects to Events: `AutoloadService.get('Events').connect('game_over', this, this.onGameOver)`
  - Shows proper cleanup: `onDetach()` calls `disconnectAllFromTarget(this)`

### 9. Runtime Package Mirroring

**Sync runtime package**
- Ensure all new types in src:
  - `core/ProjectManifest.ts` - runtime subset
  - `services/AutoloadService.ts` - runtime autoload management
  - NodeBase changes (signals with context binding, groups) - already in runtime
  - SceneGraph changes (group map, callGroup validation) - already in runtime
- Update index.ts:
  - Export `AutoloadService`
  - Export signal types: `SignalConnection`
  - Export group methods from SceneManager

### 10. Migration & Backward Compatibility

**Handle existing projects**
- In `ProjectService.loadProjectManifest()`:
  - If `pix3project.yaml` doesn't exist: create default `{ version: '1.0', autoloads: [], metadata: {} }`
  - Auto-save to project root
  - Log info: "Created default project manifest"
- Existing scene files without `groups`: NodeBase defaults to empty Set, no migration needed
- Existing scripts using old signal pattern (if any future change): no impact, new signature is additive

**Verification**

1. **Autoload Lifecycle with GlobalRootNode**:
   - Create `GameManager.ts` autoload, add to pix3project.yaml
   - In GameManager `onStart()`: create child Sprite2D node `this.node.add(new Sprite2D())`
   - Verify sprite appears in viewport (as child of invisible GlobalRoot)
   - Switch scenes - verify autoload persists, child node still exists
   - Verify `globalRoot.tick(dt)` updates autoload scripts every frame

2. **Memory-Safe Signals**:
   - Create Player script with `signal('died')`
   - Create UI script: `player.connect('died', this, this.onPlayerDied)`
   - Delete UI node - verify automatic cleanup via `disconnectAllFromTarget(this)`
   - Check memory profiler: no orphaned references
   - Re-connect, manually disconnect: `player.disconnect('died', this, this.onPlayerDied)`

3. **Events Autoload Pattern**:
   - Create `Scripts/Events.ts` autoload: `class Events extends Script { onAttach() { this.signal('game_over'); } }`
   - Add to pix3project.yaml: `{ scriptPath: 'Scripts/Events.ts', singleton: 'Events', enabled: true }`
   - In another script: `AutoloadService.get('Events').emit('game_over', 'timeout')`
   - In UI autoload: `AutoloadService.get('Events').connect('game_over', this, this.showGameOver)`
   - Verify callback receives payload: `showGameOver(reason: string)`

4. **Groups with Runtime Validation**:
   - Create 3 enemy nodes, add to `enemies` group via inspector
   - Enemy scripts implement `takeDamage(amount: number)` method
   - Call: `SceneManager.callGroup('enemies', 'takeDamage', 50)`
   - Verify all 3 enemies receive call
   - Create node in `enemies` group WITHOUT takeDamage method
   - Verify console warning: "Method takeDamage not found on component user:WrongEnemy"
   - Verify no crash, other enemies still updated

5. **UI Integration**:
   - Open Project Settings panel (Edit > Project Settings or Cmd+,)
   - Add autoload: Scripts/AudioManager.ts, singleton: Audio
   - Reorder via drag: move Audio to load before GameManager
   - Verify order saved in pix3project.yaml: `autoloads: [Audio, GameManager]`
   - Inspector: select node, add to group "interactive", verify tag appears
   - Save scene, reload - verify group persists

6. **Performance**:
   - Create 200 nodes in "particles" group
   - Call `callGroup('particles', 'updateColor', color)` - verify <20ms with validation checks
   - Create Events autoload with 100 connected listeners
   - Emit `Events.emit('tick')` - verify <5ms dispatch

**Decisions**

- **Signal binding**: Context-aware `connect(signal, target, method)` instead of `.bind()` - enables automatic cleanup via `disconnectAllFromTarget()` and prevents memory leaks
- **Autoload parent**: GlobalRootNode instead of `null` - allows autoloads to create child nodes (global UI, audio sources) using standard NodeBase API
- **Global events**: Events.ts autoload pattern instead of GlobalSignals service - keeps API consistent (all signals on nodes/scripts), follows Godot exactly
- **callGroup safety**: Runtime `typeof` validation before method invocation - prevents crashes when group contains nodes missing the target method, provides helpful warnings

---

This revised plan addresses all four refinements: memory-safe signals with automatic cleanup, GlobalRootNode for autoload child nodes, Events autoload instead of dedicated service, and runtime validation in callGroup. The implementation follows Godot patterns more closely while preventing common pitfalls.