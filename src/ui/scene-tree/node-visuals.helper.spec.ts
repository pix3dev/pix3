import { describe, expect, it } from 'vitest';
import {
  AmbientLightNode,
  AudioPlayer,
  Camera3D,
  DirectionalLightNode,
  HemisphereLightNode,
  PointLightNode,
  SpotLightNode,
} from '@pix3/runtime';

import { getNodeVisuals } from './node-visuals.helper';

describe('getNodeVisuals', () => {
  it.each([
    [
      'DirectionalLightNode',
      new DirectionalLightNode({ id: 'dir-light', name: 'Directional Light' }),
    ],
    ['PointLightNode', new PointLightNode({ id: 'point-light', name: 'Point Light' })],
    ['SpotLightNode', new SpotLightNode({ id: 'spot-light', name: 'Spot Light' })],
    ['AmbientLightNode', new AmbientLightNode({ id: 'ambient-light', name: 'Ambient Light' })],
    [
      'HemisphereLightNode',
      new HemisphereLightNode({ id: 'hemi-light', name: 'Hemisphere Light' }),
    ],
  ])('returns sun icon for %s', (_label, node) => {
    expect(getNodeVisuals(node)).toEqual({
      color: '#ff7f6cff',
      icon: 'sun',
    });
  });

  it('keeps existing camera visuals unchanged', () => {
    expect(getNodeVisuals(new Camera3D({ id: 'camera-node', name: 'Camera' }))).toEqual({
      color: '#ff7f6cff',
      icon: 'camera',
    });
  });

  it('keeps existing audio visuals unchanged', () => {
    expect(getNodeVisuals(new AudioPlayer({ id: 'audio-node', name: 'Audio Player' }))).toEqual({
      color: '#a5abffff',
      icon: 'volume-2',
    });
  });
});
