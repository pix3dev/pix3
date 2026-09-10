import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasLayer2D, Group2D, NodeBase, SceneManager, type SceneGraph } from '@pix3/runtime';

import { ServiceContainer } from '@/fw/di';
import { appState } from '@/state';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { isPeekDimmedInTree } from '@/services/viewport/peek-gating';
import { PeekService } from '@/services/viewport/PeekService';

let activeGraph: SceneGraph | null = null;
let renderRequests = 0;

class SceneManagerStub {
  getActiveSceneGraph(): SceneGraph | null {
    return activeGraph;
  }
}

class ViewportStub {
  requestRender(): void {
    renderRequests += 1;
  }

  updateNodeVisibility(): void {}
}

const graphOf = (roots: NodeBase[]): SceneGraph => {
  const nodeMap = new Map<string, NodeBase>();
  for (const root of roots) {
    root.traverse(obj => {
      if (obj instanceof NodeBase) {
        nodeMap.set(obj.nodeId, obj);
      }
    });
  }
  return { version: '1.0.0', metadata: {}, rootNodes: roots, nodeMap };
};

const makeService = (): PeekService => {
  const container = ServiceContainer.getInstance();
  container.addService(container.getOrCreateToken(SceneManager), SceneManagerStub, 'singleton');
  container.addService(
    container.getOrCreateToken(ViewportRendererService),
    ViewportStub,
    'singleton'
  );
  return new PeekService();
};

/** Sets the scene id AND a descriptor, since the localStorage key is the file path. */
const activateScene = (sceneId: string, filePath: string): void => {
  appState.scenes.activeSceneId = sceneId;
  appState.scenes.descriptors[sceneId] = {
    id: sceneId,
    filePath,
    name: sceneId,
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
  };
};

describe('PeekService', () => {
  beforeEach(() => {
    activeGraph = null;
    renderRequests = 0;
    localStorage.clear();
    appState.scenes.peekHiddenByScene = {};
    appState.scenes.peekSoloByScene = {};
    appState.scenes.descriptors = {};
    appState.scenes.activeSceneId = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('branch derivation', () => {
    it('offers the top-level nodes when the scene has several roots', () => {
      activeGraph = graphOf([
        new Group2D({ id: 'world', name: 'World' }),
        new Group2D({ id: 'hud', name: 'HUD' }),
      ]);
      activateScene('s', 'res://scenes/main.pix3scene');

      expect(
        makeService()
          .getSnapshot()
          .branches.map(b => b.label)
      ).toEqual(['World', 'HUD']);
    });

    it('descends one level when there is a single root', () => {
      // The common authored shape. One chip that hides the entire scene is not a feature.
      const root = new Group2D({ id: 'main', name: 'Main' });
      root.adoptChild(new Group2D({ id: 'world', name: 'World' }));
      root.adoptChild(new Group2D({ id: 'hud', name: 'HUD' }));
      activeGraph = graphOf([root]);
      activateScene('s', 'res://scenes/main.pix3scene');

      expect(
        makeService()
          .getSnapshot()
          .branches.map(b => b.label)
      ).toEqual(['World', 'HUD']);
    });

    it('also offers a CanvasLayer2D found one level deeper', () => {
      const world = new Group2D({ id: 'world', name: 'World' });
      world.adoptChild(new CanvasLayer2D({ id: 'overlay', name: 'Overlay' }));
      activeGraph = graphOf([world, new Group2D({ id: 'hud', name: 'HUD' })]);
      activateScene('s', 'res://scenes/main.pix3scene');

      expect(
        makeService()
          .getSnapshot()
          .branches.map(b => b.label)
      ).toEqual(['World', 'Overlay', 'HUD']);
    });

    it('returns nothing when no scene is active', () => {
      expect(makeService().getSnapshot().branches).toEqual([]);
    });
  });

  describe('masking', () => {
    const build = () => {
      const world = new Group2D({ id: 'world', name: 'World' });
      const hud = new Group2D({ id: 'hud', name: 'HUD' });
      const label = new Group2D({ id: 'label', name: 'Score' });
      hud.adoptChild(label);
      activeGraph = graphOf([world, hud]);
      activateScene('s', 'res://scenes/main.pix3scene');
      return { service: makeService(), world, hud, label };
    };

    it('stamps hiddenByEditor on the branch root and leaves authored state alone', () => {
      const { service, hud, label } = build();

      service.setHiddenNodeIds(['hud']);

      expect(hud.hiddenByEditor).toBe(true);
      expect(hud.authoredVisible).toBe(true);
      expect(hud.properties.visible).toBeUndefined();
      // Stamped on the root only — three.js cascades the rest.
      expect(label.hiddenByEditor).toBe(false);
      expect(label.isVisibleInTree()).toBe(false);
    });

    it('clears the flag when the mask shrinks', () => {
      const { service, hud } = build();
      service.setHiddenNodeIds(['hud']);

      service.setHiddenNodeIds([]);

      expect(hud.hiddenByEditor).toBe(false);
    });

    it('requests a frame, because flipping a flag is not itself a dirty-marker', () => {
      const { service } = build();
      const before = renderRequests;

      service.setHiddenNodeIds(['hud']);

      expect(renderRequests).toBeGreaterThan(before);
    });

    it('dims every branch except the soloed one, without hiding anything', () => {
      const { service, world, hud, label } = build();

      service.setSoloNodeIds(['hud']);

      // Stamped on branch roots; the fade is inherited by a walk, since a material property has no
      // three.js cascade to lean on the way `visible` does.
      expect(isPeekDimmedInTree(label)).toBe(false);

      expect(isPeekDimmedInTree(hud)).toBe(false);
      expect(isPeekDimmedInTree(world)).toBe(true);
      expect(world.hiddenByEditor).toBe(false);
      // Dimming fades; it never takes the node away.
      expect(world.isVisibleInTree()).toBe(true);
    });

    it('returns a repeated solo to the PREVIOUS set, not to "show all"', () => {
      const { service, world, hud } = build();
      service.setSoloNodeIds(['world']);

      service.toggleSolo('hud');
      expect(isPeekDimmedInTree(hud)).toBe(false);
      expect(isPeekDimmedInTree(world)).toBe(true);

      // Alt-clicking the soloed chip again: back to soloing World, not to no solo at all.
      service.toggleSolo('hud');
      expect(isPeekDimmedInTree(world)).toBe(false);
      expect(isPeekDimmedInTree(hud)).toBe(true);
    });

    it('showAll clears both the hidden mask and the solo', () => {
      const { service, world, hud } = build();
      service.setHiddenNodeIds(['hud']);
      service.setSoloNodeIds(['world']);

      service.showAll();

      const snapshot = service.getSnapshot();
      expect(snapshot.hiddenCount).toBe(0);
      expect(snapshot.soloActive).toBe(false);
      expect(hud.hiddenByEditor).toBe(false);
      expect(isPeekDimmedInTree(world)).toBe(false);
      expect(isPeekDimmedInTree(hud)).toBe(false);
    });

    it('re-stamps a graph that was REPLACED under the same ids', () => {
      // Every path that swaps the active graph for a re-parsed one keeps the ids and hands back
      // fresh nodes with default flags: a remote collab update, a prefab refresh, a scene reload.
      // An apply that early-outs on the mask's IDS would leave the chips claiming a mask the graph
      // no longer has.
      const { service } = build();
      service.setHiddenNodeIds(['hud']);

      const world = new Group2D({ id: 'world', name: 'World' });
      const hud = new Group2D({ id: 'hud', name: 'HUD' });
      activeGraph = graphOf([world, hud]);
      expect(hud.hiddenByEditor).toBe(false);

      service.applyToActiveGraph();

      expect(hud.hiddenByEditor).toBe(true);
    });

    it('releases a hidden node that stops being a branch, so it is never stuck invisible', () => {
      // The branch set moves under the mask's feet: with a single root, derivation offers its
      // CHILDREN; adding a second top-level node switches it to the roots. A node that drops out
      // while hidden would have no chip, no place in `hiddenCount`, no pill and no reachable
      // "Show all" — invisible with no way back.
      const root = new Group2D({ id: 'main', name: 'Main' });
      const world = new Group2D({ id: 'world', name: 'World' });
      const hud = new Group2D({ id: 'hud', name: 'HUD' });
      root.adoptChild(world);
      root.adoptChild(hud);
      activeGraph = graphOf([root]);
      activateScene('s', 'res://scenes/main.pix3scene');
      const service = makeService();
      service.setHiddenNodeIds(['hud']);
      expect(hud.hiddenByEditor).toBe(true);

      // A second top-level node appears. `hud` is now a grandchild, not a branch.
      activeGraph = graphOf([root, new Group2D({ id: 'fx', name: 'FX' })]);
      service.applyToActiveGraph();

      expect(service.getSnapshot().branches.map(b => b.label)).toEqual(['Main', 'FX']);
      expect(hud.hiddenByEditor).toBe(false);
      expect(hud.isVisibleInTree()).toBe(true);
      // The id is kept, so a structure that changes back re-applies the mask rather than losing it.
      expect(service.getHiddenNodeIds()).toEqual(['hud']);
    });

    it('reports no change when nothing moved, so a Peek click is not a node-data change', () => {
      // `OperationService` bumps `scenes.nodeDataChangeSignal` for any `didMutate`, which wakes
      // IntelliSense, the scene tree and the viewport resync. A view mask must not look like scene
      // data changing, and a no-op click must not look like anything at all.
      const { service } = build();

      expect(service.setHiddenNodeIds(['hud'])).toBe(true);
      expect(service.setHiddenNodeIds(['hud'])).toBe(false);
      expect(service.showAll()).toBe(true);
      expect(service.showAll()).toBe(false);
    });

    it('drops an id whose node is gone instead of showing an unclearable count', () => {
      const { service } = build();

      service.setHiddenNodeIds(['hud', 'deleted-node']);

      expect(service.getSnapshot().hiddenCount).toBe(1);
    });
  });

  describe('persistence', () => {
    const activate = (sceneId: string, filePath: string) => {
      const world = new Group2D({ id: 'world', name: 'World' });
      const hud = new Group2D({ id: 'hud', name: 'HUD' });
      activeGraph = graphOf([world, hud]);
      activateScene(sceneId, filePath);
    };

    it('keyed by file path, so a reload restores the mask', () => {
      activate('s', 'res://scenes/main.pix3scene');
      makeService().setHiddenNodeIds(['hud']);

      // A fresh session: same scene path, a brand-new service and no in-memory state.
      appState.scenes.peekHiddenByScene = {};
      activate('other-session-id', 'res://scenes/main.pix3scene');

      expect(makeService().getHiddenNodeIds()).toEqual(['hud']);
    });

    it('survives a localStorage that throws (private window, blocked site data)', () => {
      activate('s', 'res://scenes/main.pix3scene');
      const service = makeService();
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });

      // Not being able to REMEMBER the mask must not stop the mask from working.
      expect(() => service.setHiddenNodeIds(['hud'])).not.toThrow();
      expect(service.getSnapshot().hiddenCount).toBe(1);
    });
  });

  describe('runtime sink', () => {
    it('pushes the current mask on registration and on every change', () => {
      const world = new Group2D({ id: 'world', name: 'World' });
      const hud = new Group2D({ id: 'hud', name: 'HUD' });
      activeGraph = graphOf([world, hud]);
      activateScene('s', 'res://scenes/main.pix3scene');
      const service = makeService();
      service.setHiddenNodeIds(['hud']);

      const pushed: string[][] = [];
      // Registration pushes immediately: a game started while a mask was already up must honour it
      // on its FIRST frame, and the clone cannot carry the flags itself.
      service.setRuntimeSink(ids => pushed.push([...ids]));
      expect(pushed).toEqual([['hud']]);

      service.setHiddenNodeIds([]);
      expect(pushed[pushed.length - 1]).toEqual([]);
    });
  });
});
