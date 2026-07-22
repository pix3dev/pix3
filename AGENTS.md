# Pix3 Editor - AI Agent Guidelines

Authoritative instructions for Pix3 development. These guidelines ensure consistent code generation and adherence to project architecture patterns.

## Project Overview

- **Pix3** is a browser-based editor for HTML5 scenes blending 2D and 3D layers.
- **Stack**: TypeScript + Vite, Lit web components, Valtio state, Three.js, Golden Layout.
- **Architecture**: Operations-first with `OperationService` as mutation gateway.
- **Source of Truth**: `docs/pix3-specification.md` (v1.15, 2026-02-26).
- **Capabilities catalog**: `docs/nodes-and-systems.md` — the inventory of every node, `core:*` behavior, system, and scripts-facing runtime API (and how to use each). **Check it before writing custom game logic**; it also carries the engine-vs-game decision. For agents building on the engine, the `pix3-game-dev` skill is the entry point.

## Essential Architecture Patterns

### Component System (Lit)

- **Base Class**: Extend `ComponentBase` from `@/fw` (not raw `LitElement`).
- **DOM Mode**: Default to **Light DOM** for global style integration.
- **Shadow DOM**: Use only when explicitly needed: `static useShadowDom = true`.
- **Styling**:
  - Separate CSS files: `[component].ts.css`.
  - Light DOM: `import './component.ts.css';`
  - Shadow DOM: `import styles from './component.ts.css?raw';` + `static styles = css`${unsafeCSS(styles)}`;`
- **Accent Color**: Use CSS variables `--pix3-accent-color` (#ffcf33) and `--pix3-accent-rgb`.
- **Icons**: Use **vector icons via `IconService`** (`@inject(IconService)` → `getIcon(name, IconSize.*)`), never emoji or Unicode symbol glyphs (📎🔑✕✓📄↻●⏸). Register a custom SVG in `IconService` if the icon isn't in Feather. Emoji belong only in user-authored content, never in UI chrome.

### Dependency Injection

- **Decorators**: Use `@injectable()` for services and `@inject(ServiceClass)` for injection.
- **Container**: Register services in `ServiceContainer` (singleton by default).
- **Lifecycle**: Services must implement `dispose()` if they hold resources or subscriptions.

### State Management (Valtio)

- **Global State**: `appState` proxy in `src/state/AppState.ts`. **Never mutate directly**.
- **Gateway scope**: The Command→Operation gateway governs **document state** — the scene graph, node properties, and project files, i.e. anything undoable/saveable. **Session/UI/infrastructure state** in `appState` (auth, collab connection/presence, router, project open/close lifecycle, script-load status, error surfacing, tab management, refresh signals) is owned by its dedicated service and may be written by that service directly, outside the gateway. (Audit 2026-07-22: every current direct `appState` writer falls in this second category.)
- **Nodes & State**: Nodes live in `SceneGraph` (managed by `SceneManager`), **not in reactive state**.
- **Sync**: State tracks node IDs for selection and hierarchy. UI subscribes via `subscribe(appState.section, callback)`.
- **Cleanup**: Always dispose subscriptions in `disconnectedCallback` or `dispose`.

### Scripting & Component System

- **Unified Components**: All scripts are `Script` instances in `node.components` (Unity-style).
- **Base Class**: Extend `Script` from `@pix3/runtime` (provides `onAttach`, `onStart`, `onUpdate`, `onDetach`).
- **Registration**: Register new script types in `ScriptRegistry`.
- **Mutations**: Use `AddComponentCommand` / `RemoveComponentCommand` for management.

### Commands and Operations

- **Operations**: Encapsulate mutation logic. Implement `perform()` returning `undo`/`redo` closures.
- **Commands**: Thin wrappers around operations. Validate state in `preconditions()`.
- **Dispatcher**: All actions **MUST** flow through `CommandDispatcher.execute(CommandClass, args)`.
- **Menu System**: Commands opt-in via metadata: `menuPath`, `shortcut`, `addToMenu`. Register in `CommandRegistry`.

### Property Schema System

- **Metadata**: Node/Script classes implement `static getPropertySchema()`.
- **Dynamic UI**: Inspector consumes schemas to render property editors (Vector2, Color, Enum, etc.).
- **Updates**: All property changes use `UpdateObjectPropertyOperation`.

## File Structure Conventions

### Core & Runtime

- `packages/pix3-runtime/src/`: Core engine logic (Nodes, SceneManager, Script base).
- `src/core/`: Editor-specific logic (HistoryManager, LayoutManager, Keybindings).
- `src/fw/`: Framework utilities (DI, ComponentBase, Property Schema).

### Features (Commands & Operations)

- `src/features/scene/`: Node creation, deletion, reparenting, prefabs.
- `src/features/scripts/`: Script management, play mode control.
- `src/features/properties/`: Object property updates.
- `src/features/selection/`: Selection logic.

### UI & Services

- `src/ui/`: Lit components organized by panel (viewport, inspector, assets, etc.).
- `src/services/`: Injectable services, grouped into domain subdirectories: `core`, `scene`, `project`, `cloud`, `collab`, `assets`, `scripting`, `play`, `export`, `editor`, `animation`, `localization`, `image-gen`, `bg-removal`, `library`, `viewport`, `agent`, `llm`, `ao-bake`, `atlas`. A new service goes into the fitting domain folder; there are no loose files at the `src/services/` root.
- `src/state/`: Valtio state definitions.

**Imports**: `src/services` has no barrel — always deep-import a service directly from its domain folder (`@/services/<domain>/FooService`). `src/state/index.ts` is a real module (it owns the `appState` singleton), so import state from `@/state`. `packages/pix3-runtime/src/index.ts` is a published package boundary and stays.

## Critical Rules for AI Agents

1. **Mutation Gate**: Never mutate `appState` or `Node` properties directly. Use `CommandDispatcher`.
2. **Aliases**: Always use `@/` (for `src`) and `@pix3/runtime` (for packages) aliases.
3. **Types**: Never use `any`. Use explicit types or `unknown` with type guards.
4. **Selection**: When creating nodes, update both `selection.nodeIds` and `selection.primaryNodeId`.
5. **Portals**: Use `DropdownPortal` for floating UI (dropdowns, tooltips) to avoid clipping.
5a. **Icons**: All UI icons render through `IconService.getIcon(...)` (vector SVG). Never hardcode emoji/glyphs as icons.
6. **Async Safety**: Use `CommandDispatcher` to handle command execution flow and errors.
7. **Proactiveness**: If a command requires a service, check its availability and register if necessary.
8. **Documentation**: Maintain only `README.md`, `AGENTS.md`, and `docs/pix3-specification.md`. Do not create feature-specific `.md` files.

## Development Commands

- `npm run dev`: Vite dev server.
- `npm run test`: Vitest unit tests.
- `npm run lint`: ESLint & Type checking.
- `npm run build`: Production build.
