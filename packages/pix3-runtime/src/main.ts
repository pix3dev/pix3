import 'reflect-metadata';

import {
  AssetLoader,
  AudioService,
  installAtlasFromManifest,
  registerBuiltInScripts,
  ResourceManager,
  RuntimeRenderer,
  SceneLoader,
  SceneManager,
  SceneRunner,
  SceneSaver,
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
  const sceneSaver = new SceneSaver();
  const sceneManager = new SceneManager(sceneLoader, sceneSaver);

  const scenePath = activeScenePath || scenePaths[0];
  if (!scenePath) {
    throw new Error('No scenes found for runtime build');
  }

  const sceneText = await resourceManager.readText(`res://${scenePath}`);
  const graph = await sceneManager.parseScene(sceneText, { filePath: scenePath });
  sceneManager.setActiveSceneGraph(scenePath, graph);

  const renderer = new RuntimeRenderer({
    antialias: runtimeQuality.antialias,
    shadows: runtimeQuality.shadows,
    pixelRatio: Math.min(window.devicePixelRatio || 1, runtimeQuality.maxPixelRatio),
  });
  renderer.attach(app);

  const runner = new SceneRunner(sceneManager, renderer, audioService, assetLoader);
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
  await installAtlasFromManifest(assetLoader, resourceManager);
  await runner.startScene(scenePath);
}

void bootstrap().catch(error => {
  console.error('[RuntimeBuild] Failed to bootstrap game:', error);
});
