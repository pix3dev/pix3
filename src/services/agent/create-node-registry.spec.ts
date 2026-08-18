import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { NodeRegistry } from '@/services/scene/NodeRegistry';
import { buildCreateNodeCommand, CREATABLE_NODE_TYPES } from './create-node-registry';

/**
 * Create-menu node types the agent deliberately cannot create, each with the reason.
 *
 * This list is the point of the drift test below: adding a `Create*Command` to the Create menu now
 * forces a decision about whether an agent may use it, instead of the type quietly never existing
 * for the agent — which is how 3D scenes ended up being authored as hand-written YAML.
 */
const EXCLUDED_FROM_AGENT: Readonly<Record<string, string>> = {
  canvaslayer2d: 'Screen-space layer plumbing; an agent building a prototype uses Group2D.',
  joystick2d: 'Needs input wiring the tool cannot express; add when the payload is settled.',
  scrollcontainer2d: 'Needs content/viewport sizing decisions the flat option set cannot carry.',
  slider2d: 'Range/step/value payload not represented in CreateNodeOptions yet.',
  inventoryslot2d: 'Game-specific composite; belongs in a prefab, not a bare create call.',
  virtualcamera3d: 'Camera-brain rig; Camera3D is the one an agent should reach for.',
  animatedsprite3d: 'Needs an animation asset to be meaningful; create via the sprite pipeline.',
  particles3d: 'Emitter config is the whole node; a default emitter is not useful on its own.',
  postprocess: 'Effect stack authoring is a separate flow (and a mobile-cost decision).',
  audioplayer: 'Needs a clip; the audio pipeline creates it.',
};

describe('create-node registry', () => {
  it('can create the 3D essentials a scene needs to render at all', () => {
    // The incident: none of these existed, so the agent hand-wrote scene YAML and typo'd the
    // light's type name into an inert node.
    for (const type of [
      'DirectionalLightNode',
      'AmbientLightNode',
      'HemisphereLightNode',
      'PointLightNode',
      'SpotLightNode',
      'GeometryMesh',
    ]) {
      expect(buildCreateNodeCommand(type, {}), type).not.toBeNull();
    }
  });

  it('accepts the spellings a model actually writes', () => {
    expect(buildCreateNodeCommand('DirectionalLight', {})).not.toBeNull();
    expect(buildCreateNodeCommand('directional-light', {})).not.toBeNull();
    expect(buildCreateNodeCommand('PointLight3D', {})).not.toBeNull();
    expect(buildCreateNodeCommand('Box', {})).not.toBeNull();
    expect(buildCreateNodeCommand('cube', {})).not.toBeNull();
    expect(buildCreateNodeCommand('MeshInstance', {})).not.toBeNull();
  });

  it('still refuses a type it has no factory for', () => {
    expect(buildCreateNodeCommand('VoxelChunk3D', {})).toBeNull();
  });

  it('takes a 3D position for a light', () => {
    const command = buildCreateNodeCommand('DirectionalLightNode', {
      name: 'Sun',
      position3: new Vector3(3, 6, 4),
    });
    expect(command).not.toBeNull();
  });

  it('offers Box under one canonical label, not two', () => {
    expect(CREATABLE_NODE_TYPES).toContain('GeometryMesh');
    expect(CREATABLE_NODE_TYPES).not.toContain('Box');
  });

  it('decides, for every Create-menu node type, whether the agent may create it', () => {
    // Drift guard (same shape as the strippable-runtime-modules table): a new entry in NodeRegistry
    // must be either creatable by the agent or excluded on purpose with a reason.
    const undecided = new NodeRegistry()
      .getAllNodeTypes()
      .map(nodeType => nodeType.id)
      .filter(id => buildCreateNodeCommand(id, {}) === null && !(id in EXCLUDED_FROM_AGENT));

    expect(
      undecided,
      `Create-menu node type(s) the agent can neither create nor is documented to skip: ${undecided.join(', ')}. Add a factory to create-node-registry.ts, or an entry with a reason to EXCLUDED_FROM_AGENT.`
    ).toEqual([]);
  });

  it('keeps the exclusion list honest', () => {
    const menuIds = new Set(new NodeRegistry().getAllNodeTypes().map(nodeType => nodeType.id));
    const stale = Object.keys(EXCLUDED_FROM_AGENT).filter(
      id => !menuIds.has(id) || buildCreateNodeCommand(id, {}) !== null
    );

    expect(stale, `Exclusions that no longer apply: ${stale.join(', ')}`).toEqual([]);
  });
});
