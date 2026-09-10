/**
 * The invariants that make the editor's Peek mask safe to put on the hottest flag in the engine.
 *
 * Peek hides a branch by setting `NodeBase.hiddenByEditor`, and `visible` became a prototype
 * accessor that folds that flag in. Two things must therefore be provable rather than assumed:
 *
 *  1. **Nothing about a masked scene reaches a file.** `SceneSaver`'s output has to be byte-for-byte
 *     what it would have been unmasked — this is the whole premise of "non-destructive".
 *  2. **The authored flag still round-trips.** `visible` used to be a plain field that
 *     `reactive-schema-properties` wrapped so `node.visible = false` from a script also wrote
 *     `properties.visible`. A prototype accessor leaves no own field to wrap, so the setter itself
 *     now owns that mirroring — and if it ever stops, scripts silently stop persisting visibility.
 */

import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { Group2D } from '../nodes/2D/Group2D';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { NodeBase } from '../nodes/NodeBase';

const serialize = (roots: NodeBase[]): string => {
  const nodeMap = new Map<string, NodeBase>();
  for (const root of roots) {
    root.traverse(obj => {
      if (obj instanceof NodeBase) {
        nodeMap.set(obj.nodeId, obj);
      }
    });
  }
  return new SceneSaver().serializeScene({
    version: '1.0.0',
    metadata: {},
    rootNodes: roots,
    nodeMap,
  });
};

const parse = (yaml: string) =>
  new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  ).parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });

/** A HUD branch under a root, the shape Peek exists for. */
const buildScene = (): { root: Group2D; hud: Group2D; label: Sprite2D } => {
  const root = new Group2D({ id: 'root', name: 'Root' });
  const hud = new Group2D({ id: 'hud', name: 'HUD' });
  const label = new Sprite2D({ id: 'label', name: 'Score' });
  hud.adoptChild(label);
  root.adoptChild(hud);
  return { root, hud, label };
};

describe('editor Peek mask', () => {
  it('leaves the saved scene byte-for-byte identical', () => {
    const { root, hud } = buildScene();
    const before = serialize([root]);

    hud.hiddenByEditor = true;

    expect(serialize([root])).toBe(before);
  });

  it('does not touch the authored flag or properties.visible', () => {
    const { hud } = buildScene();
    expect(hud.properties.visible).toBeUndefined();

    hud.hiddenByEditor = true;

    expect(hud.visible).toBe(false);
    expect(hud.authoredVisible).toBe(true);
    expect(hud.properties.visible).toBeUndefined();
  });

  it('mirrors a script assignment into properties.visible (reactive-layer regression)', () => {
    const { hud } = buildScene();

    // What a game script writes. Before `visible` became an accessor this mirroring came from
    // `installReactiveSchemaProperties` wrapping the own field; now the setter does it.
    hud.visible = false;

    expect(hud.properties.visible).toBe(false);
    expect(hud.authoredVisible).toBe(false);
  });

  it('keeps the authored flag readable underneath a mask, and restores on clear', () => {
    const { hud } = buildScene();
    hud.visible = false;
    hud.hiddenByEditor = true;
    expect(hud.visible).toBe(false);

    // Un-masking must not un-hide something the AUTHOR hid: the two channels are independent.
    hud.hiddenByEditor = false;
    expect(hud.visible).toBe(false);

    hud.visible = true;
    expect(hud.visible).toBe(true);
  });

  it('hides the whole subtree for isVisibleInTree (so a masked HUD stops taking input)', () => {
    const { hud, label } = buildScene();
    expect(label.isVisibleInTree()).toBe(true);

    // Stamped on the branch ROOT only — the point of leaning on three.js's own cascade.
    hud.hiddenByEditor = true;

    expect(label.isVisibleInTree()).toBe(false);
    expect(label.visible).toBe(true);
    expect(label.authoredVisible).toBe(true);
  });

  it('does not survive serialize→parse (the mask is not scene content)', async () => {
    const { root, hud } = buildScene();
    hud.hiddenByEditor = true;

    const graph = await parse(serialize([root]));
    const reloaded = graph.nodeMap.get('hud');

    expect(reloaded).toBeInstanceOf(NodeBase);
    expect(reloaded?.hiddenByEditor).toBe(false);
    expect(reloaded?.visible).toBe(true);
  });

  it('never writes a mask key into the YAML — the export invariant, stated directly', () => {
    // Acceptance item: an exported playable must carry no trace of the mask. The export builds from
    // the serialized scene, so this is where that becomes provable rather than argued: the byte
    // comparison above proves nothing NEW appeared, and this proves the field names never do.
    const { root, hud } = buildScene();
    hud.hiddenByEditor = true;

    const yaml = serialize([root]);

    expect(yaml).not.toContain('hiddenByEditor');
    expect(yaml).not.toContain('dimmedByEditor');
    expect(yaml).not.toContain('_selfVisible');
    expect(yaml).not.toContain('peek');
  });

  it('round-trips an authored visible: false through a save while masked', async () => {
    const { root, hud } = buildScene();
    hud.visible = false;
    hud.hiddenByEditor = true;

    const graph = await parse(serialize([root]));

    expect(graph.nodeMap.get('hud')?.authoredVisible).toBe(false);
  });

  it('reports the authored value through the schema, not the masked one', () => {
    const { hud } = buildScene();
    const definition = NodeBase.getPropertySchema().properties.find(p => p.name === 'visible');
    if (!definition) {
      throw new Error('NodeBase schema is missing "visible"');
    }

    hud.hiddenByEditor = true;

    // The Inspector must show what the author set, or toggling the eye on a masked node would
    // write the mask into the file.
    expect(definition.getValue(hud)).toBe(true);

    definition.setValue(hud, false);
    expect(hud.authoredVisible).toBe(false);
    expect(hud.properties.visible).toBe(false);
  });
});
