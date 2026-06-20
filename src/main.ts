import 'reflect-metadata';
import 'golden-layout/dist/css/goldenlayout-base.css';
import 'golden-layout/dist/css/themes/goldenlayout-dark-theme.css';
import './index.css';

// Expose Engine API for user scripts
import * as EngineAPI from '@pix3/runtime';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

type HapticFunction = (() => void) & {
  confirm: () => void;
  error: () => void;
};

interface WindowWithEngine extends Window {
  __PIX3_ENGINE__: typeof EngineAPI;
  __PIX3_THREE__: typeof THREE;
  __PIX3_GLTFLoader__: typeof GLTFLoader;
  __PIX3_IOS_HAPTICS__: {
    haptic: HapticFunction;
  };
}

(window as unknown as WindowWithEngine).__PIX3_ENGINE__ = EngineAPI;
(window as unknown as WindowWithEngine).__PIX3_THREE__ = THREE;
(window as unknown as WindowWithEngine).__PIX3_GLTFLoader__ = GLTFLoader;
(window as unknown as WindowWithEngine).__PIX3_IOS_HAPTICS__ = {
  haptic: Object.assign(() => undefined, {
    confirm: () => undefined,
    error: () => undefined,
  }),
};

// Create dynamic import map for @pix3/runtime
// This allows user scripts to import from '@pix3/runtime' at runtime
const createImportMapShim = () => {
  // Generate module code that re-exports the global API
  const moduleCode = `
    const api = window.__PIX3_ENGINE__;
    ${Object.keys(EngineAPI)
      .map(key => `export const ${key} = api.${key};`)
      .join('\n')}
  `;

  // Create blob URL for the module
  const blob = new Blob([moduleCode], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);

  // Generate module code for three
  const threeModuleCode = `
    const api = window.__PIX3_THREE__;
    ${Object.keys(THREE)
      .map(key => `export const ${key} = api.${key};`)
      .join('\n')}
    export default api;
  `;
  const threeBlob = new Blob([threeModuleCode], { type: 'application/javascript' });
  const threeBlobUrl = URL.createObjectURL(threeBlob);

  // Rapier itself is lazy-loaded via ensureRapierLoaded() before user scripts
  // execute. The shim reads window.__RAPIER__, which is populated at that
  // point. The export key list is baked in at build time via Vite `define`,
  // so this module does not pull rapier (and its 2 MB inlined wasm) into the
  // main bundle.
  const rapierModuleCode = `
    const api = window.__RAPIER__;
    export default api;
    ${__PIX3_RAPIER_EXPORT_KEYS__.map(key => `export const ${key} = api.${key};`).join('\n')}
  `;
  const rapierBlob = new Blob([rapierModuleCode], { type: 'application/javascript' });
  const rapierBlobUrl = URL.createObjectURL(rapierBlob);

  const gltfLoaderModuleCode = `
    const api = window.__PIX3_GLTFLoader__;
    export const GLTFLoader = api;
    export default api;
  `;
  const gltfLoaderBlob = new Blob([gltfLoaderModuleCode], { type: 'application/javascript' });
  const gltfLoaderBlobUrl = URL.createObjectURL(gltfLoaderBlob);

  const iosHapticsModuleCode = `
    const api = window.__PIX3_IOS_HAPTICS__;
    export const haptic = api.haptic;
    export default api;
  `;
  const iosHapticsBlob = new Blob([iosHapticsModuleCode], { type: 'application/javascript' });
  const iosHapticsBlobUrl = URL.createObjectURL(iosHapticsBlob);

  // Inject import map into document
  const importMap = document.createElement('script');
  importMap.type = 'importmap';
  importMap.textContent = JSON.stringify({
    imports: {
      '@pix3/runtime': blobUrl,
      three: threeBlobUrl,
      '@dimforge/rapier3d-compat': rapierBlobUrl,
      'three/examples/jsm/loaders/GLTFLoader.js': gltfLoaderBlobUrl,
      'ios-haptics': iosHapticsBlobUrl,
    },
  });
  document.head.appendChild(importMap);
  console.log('[Pix3] Engine API exposed and import map created for user scripts');
};

createImportMapShim();

// Register runtime services
import { registerRuntimeServices } from './core/register-runtime-services';
import { ServiceContainer } from './fw/di';

registerRuntimeServices();

// Register built-in script components
import { ScriptRegistry, registerBuiltInScripts } from '@pix3/runtime';

const container = ServiceContainer.getInstance();
const registry = container.getService<ScriptRegistry>(container.getOrCreateToken(ScriptRegistry));
registerBuiltInScripts(registry);

import './ui/scene-tree/scene-tree-panel';
import './ui/viewport/editor-tab';
import './ui/object-inspector/inspector-panel';
import './ui/assets-browser/asset-browser-panel';
import './ui/pix3-editor-shell';

// Dev-only debugging bridge for external tooling (Chrome DevTools / MCP).
// The dynamic import + statically-false guard keeps this module (and its deps)
// out of the production PWA bundle.
if (import.meta.env.DEV) {
  void import('./core/debug-bridge').then(({ installDebugBridge }) => installDebugBridge());
}
