import { describe, expect, it } from 'vitest';

import { AssetLoader } from './AssetLoader';
import { AudioService } from './AudioService';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { DirectionalLightNode } from '../nodes/3D/DirectionalLightNode';
import { HemisphereLightNode } from '../nodes/3D/HemisphereLightNode';
import { NodeBase } from '../nodes/NodeBase';
import { collectRenderabilityIssues } from './renderability-lint';

const newLoader = (): SceneLoader =>
  new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );

/**
 * The scene from the incident, verbatim in shape: a lit cube plus a light written under the name
 * the editor's own scene tree reports (`DirectionalLight`) rather than the on-disk one
 * (`DirectionalLightNode`).
 */
const sceneYaml = (lightType: string): string => `version: "1.0.0"
metadata: {}
root:
  - id: root
    name: Root
    type: Node3D
    children:
      - id: cube
        name: Cube
        type: GeometryMesh
        properties:
          geometry: box
      - id: sun
        name: Sun
        type: ${lightType}
        properties:
          intensity: 1.2
`;

describe('light node type aliases', () => {
  it.each(['DirectionalLight', 'DirectionalLight3D', 'directional-light'])(
    'loads "%s" as a real DirectionalLightNode',
    async lightType => {
      const graph = await newLoader().parseScene(sceneYaml(lightType), {
        filePath: 'res://scenes/main.pix3scene',
      });
      const sun = graph.nodeMap.get('sun');

      expect(sun).toBeInstanceOf(DirectionalLightNode);
      expect((sun as DirectionalLightNode).light.intensity).toBe(1.2);
    }
  );

  it('leaves nothing for the lint to complain about once the alias resolves', async () => {
    // Before the alias this exact file produced an inert NodeBase and a black cube.
    const graph = await newLoader().parseScene(sceneYaml('DirectionalLight3D'), {
      filePath: 'res://scenes/main.pix3scene',
    });
    const issues = collectRenderabilityIssues(graph.rootNodes);

    expect(issues.map(issue => issue.code)).toEqual(['no-camera-3d']);
  });

  it('still loads a genuinely unknown type inert, and the lint says so', async () => {
    const graph = await newLoader().parseScene(sceneYaml('VoxelLightEmitter'), {
      filePath: 'res://scenes/main.pix3scene',
    });
    const sun = graph.nodeMap.get('sun');

    expect(Object.getPrototypeOf(sun as NodeBase)).toBe(NodeBase.prototype);
    const issues = collectRenderabilityIssues(graph.rootNodes);
    expect(issues.map(issue => issue.code)).toContain('inert-nodes');
  });

  it('writes the canonical spelling back, so an alias never lands on disk', async () => {
    const graph = await newLoader().parseScene(sceneYaml('HemisphereLight'), {
      filePath: 'res://scenes/main.pix3scene',
    });
    expect(graph.nodeMap.get('sun')).toBeInstanceOf(HemisphereLightNode);

    const yaml = new SceneSaver().serializeScene(graph);
    expect(yaml).toContain('type: HemisphereLightNode');
    expect(yaml).not.toMatch(/type: HemisphereLight$/m);
  });
});
