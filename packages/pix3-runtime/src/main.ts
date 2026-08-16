import 'reflect-metadata';

import {
  AssetLoader,
  ATLAS_MANIFEST_PATH,
  AudioService,
  installAtlasFromManifest,
  registerBuiltInScripts,
  ResourceManager,
  RuntimeRenderer,
  SceneLoader,
  SceneManager,
  SceneRunner,
  ScriptRegistry,
} from '@pix3/runtime';
import {
  activeScenePath,
  scenePaths,
  runtimeQuality,
  runtimeLocalization,
} from './generated/scene-manifest';
import { registerProjectScripts } from './register-project-scripts';
import { embeddedAssets } from 'virtual:runtime-embedded-assets';
// Registers the optional Spine runtime when the build detected a SpineSkeleton2D;
// a no-op module otherwise. Must run before the first scene load.
import 'virtual:runtime-spine';
// Same arrangement for `postprocessing`: registered statically when a scene
// places a PostProcess node, absent otherwise.
import 'virtual:runtime-postprocessing';
// Installs the multiplayer NetworkService (and the `Kind` ↔ prefab table) when the
// build detected any networking use; a no-op otherwise, which keeps ~59 KiB of
// protocol code out of single-player exports.
import { installNetworkService } from 'virtual:runtime-network';

async function bootstrap(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) {
    throw new Error('Missing #app container');
  }

  // Relative base so builds work from any directory (zip exports unpacked into
  // a subfolder, itch.io-style hosting), not just a server root.
  const resourceManager = new ResourceManager('./', embeddedAssets);
  const audioService = new AudioService();
  const scriptRegistry = new ScriptRegistry();
  registerBuiltInScripts(scriptRegistry);
  registerProjectScripts(scriptRegistry);

  const assetLoader = new AssetLoader(resourceManager, audioService);
  const sceneLoader = new SceneLoader(assetLoader, scriptRegistry, resourceManager);
  // No SceneSaver: a player never writes scenes back out. Passing one would pin
  // the serializer — and through it every node class and `yaml.stringify` — into
  // the bundle. See `.plans/done/playable-export-size.md`.
  const sceneManager = new SceneManager(sceneLoader);

  const scenePath = activeScenePath || scenePaths[0];
  if (!scenePath) {
    throw new Error('No scenes found for runtime build');
  }

  const renderer = new RuntimeRenderer({
    antialias: runtimeQuality.antialias,
    shadows: runtimeQuality.shadows,
    pixelRatio: Math.min(window.devicePixelRatio || 1, runtimeQuality.maxPixelRatio),
  });
  renderer.attach(app);

  const runner = new SceneRunner(sceneManager, renderer, audioService, assetLoader);
  // Multiplayer session (D5): owned by the runner, not by the scene, so it survives
  // `changeScene`. Offline and inert until a game script calls
  // `this.scene.network.connect(...)`. The generated module also installs the
  // `Kind` ↔ prefab table before any scene runs, because a kind that changes
  // mid-session repoints entities every peer already spawned.
  installNetworkService(runner);
  runner.setBatching2DEnabled(true);
  if (runtimeLocalization) {
    // Baked from pix3project.yaml (or auto-discovered locales/) at export time;
    // SceneRunner boots in defaultLocale so the first frame renders translated.
    runner.setLocalizationConfig({
      defaultLocale: runtimeLocalization.defaultLocale,
      fallbackLocale: runtimeLocalization.fallbackLocale,
      locales: runtimeLocalization.locales,
    });
  }
  // Pre-packed atlas (if the export shipped one) → texture views onto sheets.
  // A single-file build has no sibling files on disk, so probing for a manifest it
  // did not embed is a request that can never succeed — and in a sandboxed playable
  // container it is a visible network error on every run. Builds that ship assets as
  // real files (zip export, hosted) embed nothing and keep probing.
  if (
    !resourceManager.hasEmbeddedResources ||
    resourceManager.hasEmbeddedResource(ATLAS_MANIFEST_PATH)
  ) {
    await installAtlasFromManifest(assetLoader, resourceManager);
  }
  // `loadAndStartScene` (the `changeScene` path) reads, parses and runs the graph
  // directly. `startScene` would instead clone the graph by serializing it to YAML
  // and re-parsing it — which in a player means parsing the entry scene twice and
  // dragging the whole serializer into the bundle for a clone nothing reads.
  await runner.loadAndStartScene(scenePath);
}

void bootstrap().catch(error => {
  console.error('[RuntimeBuild] Failed to bootstrap game:', error);
});
