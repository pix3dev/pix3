import 'reflect-metadata';
import 'golden-layout/dist/css/goldenlayout-base.css';
import 'golden-layout/dist/css/themes/goldenlayout-dark-theme.css';
import './index.css';

// Expose the engine API to user scripts via a blob-URL import map (shared
// with the standalone preview player entry).
import { installRuntimeImportMap } from './core/runtime-import-map';

installRuntimeImportMap();

// Register runtime services
import { registerRuntimeServices } from './core/register-runtime-services';
import { ServiceContainer } from './fw/di';

registerRuntimeServices();

// Register built-in script components
import { ScriptRegistry, registerBuiltInScripts } from '@pix3/runtime';

const container = ServiceContainer.getInstance();
const registry = container.getService<ScriptRegistry>(container.getOrCreateToken(ScriptRegistry));
registerBuiltInScripts(registry);

// Bridge runtime script/uncaught errors into the Logs panel and Game tab from
// app start, so a broken script surfaces its error instead of failing silently.
import { RuntimeErrorBridgeService } from './services/RuntimeErrorBridgeService';

container
  .getService<RuntimeErrorBridgeService>(container.getOrCreateToken(RuntimeErrorBridgeService))
  .initialize();

// Type-check project scripts and surface errors (with file + line) in the Logs
// panel — automatically after compiles / on play once the code editor is loaded,
// and on demand via the `scripts.check` command.
import { ProjectDiagnosticsService } from './services/ProjectDiagnosticsService';

container
  .getService<ProjectDiagnosticsService>(container.getOrCreateToken(ProjectDiagnosticsService))
  .initialize();

// Keep the personal Asset Library mirrored to the cloud (sign-in, local edits, tab-focus).
// Boot eagerly so sync runs even before the Library panel is opened.
import { LibrarySyncService } from './services/LibrarySyncService';

container
  .getService<LibrarySyncService>(container.getOrCreateToken(LibrarySyncService))
  .initialize();

import './ui/scene-tree/scene-tree-panel';
import './ui/viewport/editor-tab';
import './ui/object-inspector/inspector-panel';
import './ui/assets/assets-panel';
import './ui/pix3-editor-shell';

// Dev-only debugging bridge for external tooling (Chrome DevTools / MCP).
// The dynamic import + statically-false guard keeps this module (and its deps)
// out of the production PWA bundle.
if (import.meta.env.DEV) {
  void import('./core/debug-bridge').then(({ installDebugBridge }) => installDebugBridge());
}
