import { describe, expect, it } from 'vitest';
import { AmbientLightNode } from '../nodes/3D/AmbientLightNode';
import { Camera3D } from '../nodes/3D/Camera3D';
import { GeometryMesh } from '../nodes/3D/GeometryMesh';
import { Sprite3D } from '../nodes/3D/Sprite3D';
import { NodeBase } from '../nodes/NodeBase';
import { Node2D } from '../nodes/Node2D';
import { collectRenderabilityIssues } from './renderability-lint';

const cube = (id = 'cube'): GeometryMesh =>
  new GeometryMesh({ id, name: id, geometry: 'box', size: [1, 1, 1] });

const camera = (): Camera3D => new Camera3D({ id: 'cam', name: 'Camera' });

const codes = (nodes: NodeBase[]): string[] =>
  collectRenderabilityIssues(nodes).map(issue => issue.code);

describe('renderability lint', () => {
  it('reproduces the incident: lit cube, camera, and a light that loaded inert', () => {
    // What the failed session produced: a "light" under a name the loader does not build, so it
    // became a bare NodeBase that lights nothing. (`DirectionalLight3D`, the spelling that actually
    // sank that session, is an alias now and loads a real light — see node-type-registry.spec.)
    const inertLight = new NodeBase({
      id: 'sun',
      name: 'Sun',
      type: 'DirectionalLightSource',
      properties: {},
      metadata: {},
    });
    const issues = collectRenderabilityIssues([cube(), camera(), inertLight]);

    expect(issues.map(issue => issue.code)).toEqual(['lit-material-no-light', 'inert-nodes']);
    expect(issues[0].message).toContain('render black');
    expect(issues[0].nodeIds).toEqual(['cube']);
    // The second issue must name the typo AND the fix, or the agent has to guess twice.
    expect(issues[1].message).toContain('DirectionalLightSource');
    expect(issues[1].message).toContain('DirectionalLightNode');
  });

  it('is quiet once a real light is present', () => {
    const light = new AmbientLightNode({ id: 'amb', name: 'Ambient' });
    expect(codes([cube(), camera(), light])).toEqual([]);
  });

  it('does not count a hidden light, or complain about a hidden mesh', () => {
    const light = new AmbientLightNode({ id: 'amb', name: 'Ambient' });
    light.visible = false;
    expect(codes([cube(), camera(), light])).toContain('lit-material-no-light');

    const hiddenCube = cube('hidden');
    hiddenCube.visible = false;
    expect(codes([hiddenCube, camera()])).toEqual([]);
  });

  it('stays quiet for an unlit 3D scene', () => {
    // Sprite3D is MeshBasicMaterial — a scene of sprites needs no light, and warning here would
    // train everyone to ignore the lint.
    const sprite = new Sprite3D({ id: 'sprite', name: 'Sprite' });
    expect(codes([sprite, camera()])).toEqual([]);
  });

  it('flags 3D content with no camera', () => {
    const light = new AmbientLightNode({ id: 'amb', name: 'Ambient' });
    const issues = collectRenderabilityIssues([cube(), light]);
    expect(issues.map(issue => issue.code)).toEqual(['no-camera-3d']);
    expect(issues[0].message).toContain('Camera3D');
  });

  it('ignores a pure 2D scene entirely', () => {
    const node = new Node2D({ id: 'root2d', name: 'Root', properties: {}, metadata: {} });
    expect(codes([node])).toEqual([]);
  });

  it('treats Group as a legitimate bare NodeBase, not an inert node', () => {
    const group = new NodeBase({
      id: 'group',
      name: 'Group',
      type: 'Group',
      properties: {},
      metadata: {},
    });
    expect(codes([group])).toEqual([]);
  });

  it('advises against PBR on a mobile budget, without calling it broken', () => {
    const light = new AmbientLightNode({ id: 'amb', name: 'Ambient' });
    const issues = collectRenderabilityIssues([cube(), camera(), light], {
      targetPlatform: 'mobile',
    });

    expect(issues.map(issue => issue.code)).toEqual(['pbr-on-mobile']);
    expect(issues[0].severity).toBe('advice');
    expect(issues[0].message).toContain('lambert');
  });

  it('says nothing about PBR on desktop, or with no platform to judge against', () => {
    const light = new AmbientLightNode({ id: 'amb', name: 'Ambient' });
    expect(
      collectRenderabilityIssues([cube(), camera(), light], { targetPlatform: 'desktop' })
    ).toEqual([]);
    expect(collectRenderabilityIssues([cube(), camera(), light])).toEqual([]);
  });

  it('marks the draw-blocking findings as blocking', () => {
    const issues = collectRenderabilityIssues([cube()], { targetPlatform: 'mobile' });
    const blocking = issues.filter(issue => issue.severity === 'blocking').map(issue => issue.code);

    expect(blocking).toEqual(['lit-material-no-light', 'no-camera-3d']);
  });

  it('reports the true count while capping the listed ids', () => {
    const cubes = Array.from({ length: 12 }, (_, i) => cube(`cube-${i}`));
    const [issue] = collectRenderabilityIssues([...cubes, camera()]);
    expect(issue.code).toBe('lit-material-no-light');
    expect(issue.nodeCount).toBe(12);
    expect(issue.nodeIds).toHaveLength(8);
  });
});
