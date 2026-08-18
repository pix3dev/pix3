import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial, type Mesh } from 'three';

import { AssetLoader } from './AssetLoader';
import { AudioService } from './AudioService';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { GeometryMesh } from '../nodes/3D/GeometryMesh';
import { AmbientLightNode } from '../nodes/3D/AmbientLightNode';
import { collectRenderabilityIssues } from './renderability-lint';

const newLoader = (): SceneLoader =>
  new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );

const materialOf = (mesh: GeometryMesh) =>
  (mesh.children.find(child => (child as unknown as Mesh).isMesh) as unknown as Mesh).material;

const sceneYaml = (materialType?: string): string => `version: "1.0.0"
metadata: {}
root:
  - id: cube
    name: Cube
    type: GeometryMesh
    properties:
      geometry: box
      material:
        color: "#ff8800"
${materialType ? `        type: ${materialType}\n` : ''}`;

describe('GeometryMesh material family', () => {
  it('still defaults to PBR, so existing scenes and consumers are untouched', () => {
    const mesh = new GeometryMesh({ id: 'cube', name: 'Cube', geometry: 'box' });

    expect(mesh.materialType).toBe('standard');
    expect(materialOf(mesh)).toBeInstanceOf(MeshStandardMaterial);
  });

  it('builds the family the scene asks for', () => {
    const lambert = new GeometryMesh({
      id: 'a',
      name: 'A',
      geometry: 'box',
      material: { type: 'lambert' },
    });
    const basic = new GeometryMesh({
      id: 'b',
      name: 'B',
      geometry: 'box',
      material: { type: 'basic' },
    });

    expect(materialOf(lambert)).toBeInstanceOf(MeshLambertMaterial);
    expect(materialOf(basic)).toBeInstanceOf(MeshBasicMaterial);
  });

  it('falls back to standard for a family it does not know', () => {
    const mesh = new GeometryMesh({
      id: 'cube',
      name: 'Cube',
      geometry: 'box',
      material: { type: 'toon-cel-shaded' },
    });

    expect(mesh.materialType).toBe('standard');
  });

  it('carries colour across a family switch and drops PBR-only values', () => {
    const mesh = new GeometryMesh({
      id: 'cube',
      name: 'Cube',
      geometry: 'box',
      material: { color: '#ff8800', roughness: 0.9, metalness: 0.1 },
    });

    mesh.materialType = 'lambert';

    const material = materialOf(mesh) as MeshLambertMaterial;
    expect(material).toBeInstanceOf(MeshLambertMaterial);
    expect('#' + material.color.clone().convertLinearToSRGB().getHexString()).toBe('#ff8800');
    expect((mesh.serializeConfig().material as Record<string, unknown>).roughness).toBeUndefined();
  });

  it('round-trips the family through save and load', async () => {
    const mesh = new GeometryMesh({
      id: 'cube',
      name: 'Cube',
      geometry: 'box',
      material: { type: 'lambert', color: '#ff8800' },
    });
    const yaml = new SceneSaver().serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [mesh],
      nodeMap: new Map([[mesh.nodeId, mesh]]),
    });

    expect(yaml).toContain('type: lambert');

    const graph = await newLoader().parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.nodeMap.get('cube') as GeometryMesh;

    expect(loaded.materialType).toBe('lambert');
    expect(materialOf(loaded)).toBeInstanceOf(MeshLambertMaterial);
  });

  it('reads the family from a hand-written scene file', async () => {
    const graph = await newLoader().parseScene(sceneYaml('basic'), {
      filePath: 'res://scenes/main.pix3scene',
    });

    expect((graph.nodeMap.get('cube') as GeometryMesh).materialType).toBe('basic');
  });

  it('an unlit mesh needs no light, and the lint agrees', () => {
    const basic = new GeometryMesh({
      id: 'cube',
      name: 'Cube',
      geometry: 'box',
      material: { type: 'basic' },
    });
    const lambert = new GeometryMesh({
      id: 'cube2',
      name: 'Cube2',
      geometry: 'box',
      material: { type: 'lambert' },
    });

    // basic draws without a light; lambert does not — which is the trade the mobile default makes,
    // and the reason the lint stays in place after this change.
    expect(collectRenderabilityIssues([basic]).map(issue => issue.code)).toEqual(['no-camera-3d']);
    expect(collectRenderabilityIssues([lambert]).map(issue => issue.code)).toContain(
      'lit-material-no-light'
    );
    expect(
      collectRenderabilityIssues([lambert, new AmbientLightNode({ id: 'amb', name: 'A' })]).map(
        issue => issue.code
      )
    ).not.toContain('lit-material-no-light');
  });
});
