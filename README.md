# Pix3 Editor

![Pix3 Editor Screenshot](design_assets/screenshot.png)

Pix3 is a browser-based editor for building rich HTML5 scenes that combine 2D and 3D layers.

The workspace targets Node.js 24.15.0 or newer within the Node 24 LTS line.

## Architecture Overview

Pix3 employs an **operations-first architecture** where all state mutations are handled by `OperationService`. Actions are initiated via `CommandDispatcher`, which wraps operations. Core functionalities are provided by **injectable services** (`@injectable()`, `@inject()`). UI and metadata are managed by **Valtio reactive proxies** (`appState`), while **scene nodes are non-reactive** and owned by `SceneManager` in `SceneGraph` objects. The rendering is handled by a single **Three.js pipeline**. UI components extend `ComponentBase`, defaulting to **light DOM**. A **Property Schema System** dynamically renders UI in the Inspector based on node schemas.

Scene creation commands use a shared `CreateNodeBaseCommand` in `src/features/scene`, while each concrete `Create*Command` keeps node-specific metadata/IDs for registry and menu integration.

See full specification in [docs/pix3-specification.md](docs/pix3-specification.md).
Additional agent guidelines: [AGENTS.md](AGENTS.md).

## Engine & Editor Capabilities

Before writing custom game logic, consult the **capabilities catalog** — every node, `core:*` behavior, system (juice, time-scale, audio buses, camera brain, cutscene director, keyframe animation, shader effects, post-processing, particles, ECS, input, signals), and scripts-facing runtime API, each with usage notes and the engine-vs-game decision: **[docs/nodes-and-systems.md](docs/nodes-and-systems.md)** (per-node detail in [docs/node-types-reference.md](docs/node-types-reference.md)). Agents building a game on the engine start from the **`pix3-game-dev`** skill (`.claude/skills/pix3-game-dev/`).

## Collaboration Server (`packages/pix3-collab-server`)

A self-hosted Node.js server that enables real-time multiplayer editing and cloud project storage.

### Stack

- **Express** — REST API for auth, projects, file storage, and admin
- **better-sqlite3** — local SQLite database (users, projects, memberships)
- **@hocuspocus/server** — WebSocket CRDT sync via Yjs
- **JWT (HttpOnly cookie)** — session auth; token also returned in response body for WebSocket handshake
- **bcrypt** — password hashing

### API Surface

| Group | Endpoints |
|-------|-----------|
| Auth | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Projects | `GET /api/projects`, `POST /api/projects`, `POST /api/projects/:id/share`, `DELETE /api/projects/:id/share`, `DELETE /api/projects/:id` |
| Storage | `GET /api/projects/:id/manifest`, `GET /api/projects/:id/files/*`, `POST /api/projects/:id/files/*`, `DELETE /api/projects/:id/files/*` |
| Admin | `GET /api/admin/users`, `DELETE /api/admin/users/:id`, `GET /api/admin/projects` |
| Sync | WebSocket on `WS_PORT` (default 4000) — room format `project:{projectId}` |

### Environment Variables

```env
HTTP_PORT=4001
WS_PORT=4000
DB_PATH=./data/pix3.db
HOCUSPOCUS_DB_PATH=./data/crdt.db
PROJECTS_STORAGE_DIR=./data/projects
JWT_SECRET=change-me
PASSWORD_SALT_ROUNDS=10
```

### Running

```bash
cd packages/pix3-collab-server
npm install
npm run dev     # tsx watch src/server.ts
```

Use Node.js 24.15.0+ when working in this repo.

## Frontend Collaboration Integration

### Auth Flow

- `AppState.auth` — `{ user, isAuthenticated, isLoading }` — tracks session
- `AuthService` — `restoreSession()` called on shell init; also exposes `login()`, `register()`, `logout()`
- `pix3-auth-screen` — combined login/register Lit component shown before the welcome screen when unauthenticated
- JWT `token` is stored on `appState.auth.user.token` and passed to HocuspocusProvider for WebSocket auth

### Cloud Projects

- `ApiClient.ts` — typed `fetch` wrapper for all REST endpoints (`credentials: 'include'` for cookie auth)
- `CloudProjectService` — wraps project CRUD, exposes `subscribe()` for reactive UI updates
- Welcome screen (`pix3-welcome`) shows **Cloud Projects** alongside local recent projects

### Collaborative Editing

- `CollaborationService` — connects to Hocuspocus; room name simplified to `project:{id}`; auth token resolved from `appState.auth.user.token` or a `tokenOverride` (share token for guests)
- `CollabSessionService` — generates share tokens via API and embeds them in invite URLs (`?token=`)
- `CollabJoinService` — reads optional `?token=` from URL for guest access (no account needed)
- `SceneCRDTBinding` — unchanged; `Y.Map('scene').get('snapshot')` format is compatible with server persistence

### Local Sync

- `LocalSyncService` — opt-in sync between a cloud project and a local directory via File System Access API; uses SHA-256 manifest diffing to only transfer changed files

## Autoload Workflow

Pix3 supports project-level autoload scripts via `pix3project.yaml`.

- Manage entries in **Project Settings > Autoload**.
- Quick-create from **Assets Browser > Create > Create autoload script**.
  - Generates `scripts/<SingletonName>.ts` from template.
  - Rebuilds project scripts.
  - Registers the singleton in project autoloads automatically.

## Signals and Groups Engine

Pix3 includes a node-local signals engine and scene-level groups engine.

- Signals (`NodeBase`):
  - `signal(name)`, `connect(signal, target, method)`, `emit(signal, ...args)`, `disconnect(...)`
  - Base `Script.onDetach()` auto-cleans listeners via `disconnectAllFromTarget(this)`.
- Groups (`NodeBase` + `SceneManager`):
  - `addToGroup()`, `removeFromGroup()`, `isInGroup()`
  - `sceneManager.getNodesInGroup(group)`
  - `sceneManager.callGroup(group, method, ...args)`
- Groups are stored in scene YAML as `groups: []`.

Recommended pattern for global events: create an `Events` autoload singleton and emit/connect signals through it.

## Development Quick Start

### Prerequisites

- Node.js 18+
- npm (or yarn)
- Chromium-based browser

### Setup

```bash
git clone <repository-url>
cd pix3
npm install
```

### yalc workflow

After changes in the runtime:
```bash
cd packages/pix3-runtime && npm run yalc:publish
```
In the target game project:
```bash
yalc update
```
Or simply use `npm install` — `yalc` will update automatically.

### Type Checking

The project uses multiple `tsconfig` files to manage different scopes:
- `tsconfig.json`: Main editor and core library configuration.
- `samples/tsconfig.json`: Configuration for standalone sample scripts to ensure they resolve `@pix3/runtime` correctly without being part of the main build.
- `packages/pix3-runtime/tsconfig.json`: Configuration for the runtime package.

### Run Dev Server

```bash
npm run dev
```

Open the app at `http://localhost:5173`.

## Deployment

### Editor on GitHub Pages

The editor is deployed by GitHub Actions via [`.github/workflows/deploy-editor-pages.yml`](/Users/igor.gritsenko/Projects/pix3/.github/workflows/deploy-editor-pages.yml).

- Pushes to `main` that touch the editor build inputs trigger a production build.
- The workflow builds the Vite app into `dist/` via `vite build`.
- `dist/` is published to GitHub Pages.
- The published site includes [public/CNAME](/Users/igor.gritsenko/Projects/pix3/public/CNAME), so GitHub Pages serves it under `editor.pix3.dev` once the DNS is configured.
- The production frontend uses `VITE_COLLAB_SERVER_URL=https://cloud.pix3.dev`.

To finish the custom domain setup:

1. Enable GitHub Pages for the repository and set the source to GitHub Actions.
2. Point `editor.pix3.dev` to GitHub Pages in DNS.
3. Confirm that GitHub Pages shows `editor.pix3.dev` as the custom domain.
4. After DNS propagates, push to `main` or run the workflow manually.

### Debugging (Chrome + MCP)

1. Launch Chrome with remote debugging. The `.vscode/launch.json` config uses these flags.
2. Start the MCP server from the workspace root:
   ```bash
   npx chrome-devtools-mcp@0.12.1 --autoConnect --browserUrl=http://127.0.0.1:9222
   ```

## Scripts

- `npm run dev` - Start Vite dev server with hot reload
- `npm run build` - Build production bundle
- `npm run test` - Run Vitest unit tests
- `npm run lint` - Check code style and errors
- `npm run format` - Format code with Prettier
- `npm run type-check` - Validate TypeScript types

## Styling & Theme Variables

Use CSS custom properties for accent colors, defined in `src/index.css`:
- `--pix3-accent-color: #ffcf33` (for hex values)
- `--pix3-accent-rgb: 255, 207, 51` (for `rgba()` functions with opacity)

Example: `background: rgba(var(--pix3-accent-rgb), 0.8);`

## Testing & Quality

- **Unit Tests**: Vitest
- **Linting**: ESLint with TypeScript and Lit-specific rules
- **Formatting**: Prettier
- **Type Safety**: Strict TypeScript
- **Accessibility**: WCAG 2.1 AA compliance target

## License

[Add your license information here]

---

**Built with ❤️ for creators who blend pixels and polygons**
