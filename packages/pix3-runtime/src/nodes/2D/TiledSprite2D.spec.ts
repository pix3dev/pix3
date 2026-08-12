import { describe, expect, it } from 'vitest';
import type { BufferGeometry, Mesh } from 'three';

import { TiledSprite2D } from './TiledSprite2D';
import { reactiveSchemaPropertyNames } from '../../fw/reactive-schema-properties';

const meshOf = (node: TiledSprite2D): Mesh => (node as unknown as { mesh: Mesh }).mesh;
const geometryOf = (node: TiledSprite2D): BufferGeometry => meshOf(node).geometry;

/** Horizontal extent of the built geometry — the actually-rendered width. */
const geometryWidth = (node: TiledSprite2D): number => {
  const geometry = geometryOf(node);
  geometry.computeBoundingBox();
  return geometry.boundingBox!.max.x - geometry.boundingBox!.min.x;
};

const vertexCount = (node: TiledSprite2D): number =>
  geometryOf(node).getAttribute('position').count;

/** A nine-slice-ready node: borders + a known texture size, so slicing has real insets. */
function makeSliceable(): TiledSprite2D {
  const node = new TiledSprite2D({
    id: 't',
    name: 'T',
    width: 128,
    height: 128,
    sliceBorder: { left: 8, right: 8, top: 8, bottom: 8 },
  });
  // Texture natural size normally arrives via setTexture; stamp it directly so slice
  // borders map to UVs without loading an image.
  node.textureWidth = 64;
  node.textureHeight = 64;
  return node;
}

describe('TiledSprite2D schema-property reactivity (direct script assignment)', () => {
  it('installs the schema-backed fields as reactive accessors', () => {
    const node = new TiledSprite2D({ id: 't', name: 'T' });
    const reactive = reactiveSchemaPropertyNames(node);
    for (const name of [
      'width',
      'height',
      'patchMode',
      'drawCenter',
      'axisStretchHorizontal',
      'axisStretchVertical',
      'anchor',
      'texture',
    ]) {
      expect(reactive.has(name), `expected "${name}" to be reactive`).toBe(true);
    }
    // sliceBorder is exposed in the schema as four scalar props (sliceBorderLeft, …) that are
    // not instance fields, so whole-object assignment stays non-reactive — scripts use
    // setSliceBorder() for that.
    expect(reactive.has('sliceBorder')).toBe(false);
  });

  it('width/height assignment rebuilds the geometry to the new extent', () => {
    const node = new TiledSprite2D({ id: 't', name: 'T', width: 128, height: 128 });
    node.width = 300;
    expect(geometryWidth(node)).toBe(300);
    node.height = 40;
    const geometry = geometryOf(node);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.y - geometry.boundingBox!.min.y).toBe(40);
  });

  it('patchMode assignment rebuilds into the sliced vertex layout', () => {
    const node = makeSliceable();
    expect(vertexCount(node)).toBe(6); // stretch = one quad

    node.patchMode = 'nine-slice';
    expect(vertexCount(node)).toBe(9 * 6); // 3×3 patches

    node.patchMode = 'three-slice-h';
    expect(vertexCount(node)).toBe(3 * 6);
  });

  it('drawCenter assignment drops the centre patch from the geometry', () => {
    const node = makeSliceable();
    node.patchMode = 'nine-slice';
    node.drawCenter = false;
    expect(vertexCount(node)).toBe(8 * 6); // hollow frame
  });

  it('axis stretch assignment swaps the built geometry', () => {
    const node = makeSliceable();
    node.patchMode = 'nine-slice';
    const before = geometryOf(node);
    node.axisStretchHorizontal = 'tile';
    expect(geometryOf(node)).not.toBe(before); // rebuildGeometry replaced the buffer
    expect(node.axisStretchHorizontal).toBe('tile');
  });

  it('anchor assignment moves the mesh pivot offset', () => {
    const node = new TiledSprite2D({ id: 't', name: 'T', width: 100, height: 100 });
    node.anchor = { x: 0, y: 1 };
    expect(meshOf(node).position.x).toBe(50);
    expect(meshOf(node).position.y).toBe(-50);
  });
});
