import { beforeEach, describe, expect, it } from 'vitest';
import { Group2D, NodeBase, SceneManager, type SceneGraph } from '@pix3/runtime';

import { ServiceContainer } from '@/fw/di';
import { appState } from '@/state';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { PeekService } from '@/services/viewport/PeekService';

import { buildPeekExportWarning } from './peek-export-warning';

let activeGraph: SceneGraph | null = null;

class SceneManagerStub {
  getActiveSceneGraph(): SceneGraph | null {
    return activeGraph;
  }
}

class ViewportStub {
  requestRender(): void {}
}

const registerStubs = (): PeekService => {
  const container = ServiceContainer.getInstance();
  container.addService(container.getOrCreateToken(SceneManager), SceneManagerStub, 'singleton');
  container.addService(
    container.getOrCreateToken(ViewportRendererService),
    ViewportStub,
    'singleton'
  );
  // `PeekService` is registered as a container singleton by its own `@injectable()`, so the
  // instance the helper resolves is the one this returns. The helper resolves rather than being
  // injected on purpose: an export command must not grow a viewport dependency.
  container.addService(container.getOrCreateToken(PeekService), PeekService, 'singleton');
  const token = container.getOrCreateToken(PeekService);
  return container.getService<PeekService>(token);
};

describe('buildPeekExportWarning', () => {
  beforeEach(() => {
    appState.scenes.peekHiddenByScene = {};
    appState.scenes.peekSoloByScene = {};
    appState.scenes.descriptors = {};
    appState.scenes.activeSceneId = 's';
    appState.scenes.descriptors.s = {
      id: 's',
      filePath: 'res://scenes/main.pix3scene',
      name: 's',
      version: '1.0.0',
      isDirty: false,
      lastSavedAt: null,
    };
    const world = new Group2D({ id: 'world', name: 'World' });
    const hud = new Group2D({ id: 'hud', name: 'HUD' });
    const nodeMap = new Map<string, NodeBase>([
      ['world', world],
      ['hud', hud],
    ]);
    activeGraph = { version: '1.0.0', metadata: {}, rootNodes: [world, hud], nodeMap };
    localStorage.clear();
  });

  it('says nothing when nothing is masked, so a normal export reads unchanged', () => {
    registerStubs();

    expect(buildPeekExportWarning()).toBe('');
  });

  it('names the masked branches and points at the property that WOULD hide them in the game', () => {
    // The failure mode a non-serializable mask introduces: the author's screen and the artefact
    // disagree at exactly the moment the artefact leaves. Nothing else in the app is positioned to
    // say so.
    registerStubs().setHiddenNodeIds(['hud']);

    const warning = buildPeekExportWarning();

    expect(warning).toMatch(/1 branch hidden only in YOUR editor: HUD/);
    expect(warning).toMatch(/this build SHOWS them/);
    expect(warning).toMatch(/"visible"/);
  });

  it('pluralizes, because the count is the part the author scans', () => {
    registerStubs().setHiddenNodeIds(['hud', 'world']);

    expect(buildPeekExportWarning()).toMatch(/2 branches hidden only in YOUR editor/);
  });
});
