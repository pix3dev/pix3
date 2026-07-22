import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { Texture } from 'three';

import {
  AssetLoader,
  AudioService,
  ResourceManager,
  SceneLoader,
  ScriptRegistry,
  registerBuiltInScripts,
} from '@pix3/runtime';

/**
 * Parse-check for the bundled project templates. Template scenes are
 * hand-authored YAML copied verbatim into new projects, so this guards against
 * schema drift breaking "New Project": every scene must load through the real
 * SceneLoader, and every template must ship the startup scene.
 */

const TEMPLATES_ROOT = resolve(process.cwd(), 'src/templates/projects');
const STARTUP_SCENE = 'files/scenes/main.pix3scene';

function listTemplateDirs(): string[] {
  return readdirSync(TEMPLATES_ROOT).filter(entry =>
    statSync(join(TEMPLATES_ROOT, entry)).isDirectory()
  );
}

function listSceneFiles(dir: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      listSceneFiles(fullPath, collected);
    } else if (entry.endsWith('.pix3scene')) {
      collected.push(fullPath);
    }
  }
  return collected;
}

function createLoader(preloadTextures: string[], templateFilesDir: string): SceneLoader {
  // Serve res:// reads (prefab `instance:` references) from the template's
  // files/ tree instead of the network.
  const resourceManager = new ResourceManager('/');
  resourceManager.readText = async (resourcePath: string): Promise<string> => {
    const relativePath = resourcePath.replace(/^res:\/\//, '');
    const filePath = join(templateFilesDir, relativePath);
    // Placeholders are substituted at project-creation time.
    return readFileSync(filePath, 'utf8').replaceAll('{{PROJECT_NAME}}', 'Test Project');
  };

  const assetLoader = new AssetLoader(resourceManager, new AudioService());
  const cache = (assetLoader as unknown as { textureCache: Map<string, Texture> }).textureCache;
  for (const url of preloadTextures) {
    cache.set(url, new Texture());
  }
  const registry = new ScriptRegistry();
  registerBuiltInScripts(registry);
  return new SceneLoader(assetLoader, registry, resourceManager);
}

function collectTextureUrls(yamlText: string): string[] {
  const urls = new Set<string>();
  for (const match of yamlText.matchAll(/res:\/\/[^\s"')\]]+\.(?:png|jpg|jpeg|webp)/g)) {
    urls.add(match[0]);
  }
  return Array.from(urls);
}

describe('bundled project templates', () => {
  beforeAll(() => {
    // happy-dom has no canvas 2D context; Label2D/Button2D render label text
    // through it, so parseScene needs this minimal stub.
    const canvasProto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    canvasProto.getContext = vi.fn(() => ({
      setTransform: () => undefined,
      scale: () => undefined,
      fillRect: () => undefined,
      clearRect: () => undefined,
      fillText: () => undefined,
      measureText: () => ({ width: 0 }),
      fillStyle: '',
      font: '',
      textBaseline: '',
      textAlign: '',
    }));
  });

  const templateDirs = listTemplateDirs();

  it('has the expected template set', () => {
    expect(templateDirs.sort()).toEqual([
      'empty-2d',
      'empty-3d',
      'minigame-2d',
      'playable-2d',
      'playable-3d',
    ]);
  });

  for (const templateId of listTemplateDirs()) {
    const templateDir = join(TEMPLATES_ROOT, templateId);

    it(`${templateId}: has valid template.yaml and the startup scene`, () => {
      const metaPath = join(templateDir, 'template.yaml');
      expect(existsSync(metaPath)).toBe(true);

      const meta = parseYaml(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      expect(meta.id).toBe(templateId);
      expect(typeof meta.title).toBe('string');
      expect(['2d', '3d']).toContain(meta.projectType);

      expect(existsSync(join(templateDir, STARTUP_SCENE))).toBe(true);
      expect(existsSync(join(templateDir, 'cover.png'))).toBe(true);
      expect(existsSync(join(templateDir, 'files/README.md'))).toBe(true);
    });

    it(`${templateId}: all scenes parse through the real SceneLoader`, async () => {
      const sceneFiles = listSceneFiles(join(templateDir, 'files'));
      expect(sceneFiles.length).toBeGreaterThan(0);

      for (const scenePath of sceneFiles) {
        const yaml = readFileSync(scenePath, 'utf8');
        // Placeholders are substituted at copy time; make the YAML parseable here.
        const rendered = yaml.replaceAll('{{PROJECT_NAME}}', 'Test Project');
        const loader = createLoader(collectTextureUrls(rendered), join(templateDir, 'files'));
        const graph = await loader.parseScene(rendered, {
          filePath: 'res://scenes/spec.pix3scene',
        });
        expect(graph.rootNodes.length).toBeGreaterThan(0);
      }
    });
  }
});
