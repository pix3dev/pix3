import { describe, expect, it } from 'vitest';
import { BufferGeometry, Mesh, MeshBasicMaterial, PlaneGeometry, Texture } from 'three';

import { Button2D } from './Button2D';
import { Bar2D } from './Bar2D';
import { Checkbox2D } from './Checkbox2D';
import { Slider2D } from './Slider2D';
import { BATCHABLE_2D_KEY } from '../../../core/batch-2d';
import { SHARED_UNIT_QUAD_GEOMETRY } from '../../../core/shared-quad-geometry';

/**
 * Nine-slice + texture slots on the UI controls that used to be colour-only.
 *
 * The load-bearing claim these tests pin is the one a screenshot would answer and
 * a "does the property exist" test would not: a corner patch keeps its SOURCE
 * pixel size no matter how wide the control gets. Everything else here is the
 * default-preserving half — an untouched control still draws the shared unit quad
 * and still rides the 2D quad batcher.
 */

interface Quad {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * Read a slice geometry back as quads. `assembleGeometry` emits six non-indexed
 * vertices per quad (two triangles), so the bounding box of each run of six is
 * exactly that patch's rect in both position and UV space.
 */
function readQuads(geometry: BufferGeometry): Quad[] {
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const quads: Quad[] = [];
  for (let start = 0; start < position.count; start += 6) {
    const quad: Quad = {
      x0: Infinity,
      y0: Infinity,
      x1: -Infinity,
      y1: -Infinity,
      u0: Infinity,
      v0: Infinity,
      u1: -Infinity,
      v1: -Infinity,
    };
    for (let i = start; i < start + 6; i += 1) {
      quad.x0 = Math.min(quad.x0, position.getX(i));
      quad.x1 = Math.max(quad.x1, position.getX(i));
      quad.y0 = Math.min(quad.y0, position.getY(i));
      quad.y1 = Math.max(quad.y1, position.getY(i));
      quad.u0 = Math.min(quad.u0, uv.getX(i));
      quad.u1 = Math.max(quad.u1, uv.getX(i));
      quad.v0 = Math.min(quad.v0, uv.getY(i));
      quad.v1 = Math.max(quad.v1, uv.getY(i));
    }
    quads.push(quad);
  }
  return quads;
}

/** The bottom-left patch: smallest x, then smallest y. */
function bottomLeftQuad(geometry: BufferGeometry): Quad {
  const quads = readQuads(geometry);
  expect(quads.length).toBeGreaterThan(0);
  return quads.reduce((best, quad) =>
    quad.x0 < best.x0 || (quad.x0 === best.x0 && quad.y0 < best.y0) ? quad : best
  );
}

/** Overall extent of a slice geometry, i.e. the rect it actually covers. */
function geometryWidth(geometry: BufferGeometry): number {
  const quads = readQuads(geometry);
  if (quads.length === 0) {
    return 0;
  }
  const min = Math.min(...quads.map(q => q.x0));
  const max = Math.max(...quads.map(q => q.x1));
  return max - min;
}

/** A Texture whose `image` reports a natural size, without decoding anything. */
function fakeTexture(width = 64, height = 64): Texture {
  const texture = new Texture();
  texture.image = { width, height };
  return texture;
}

const buttonMeshOf = (button: Button2D): Mesh =>
  (button as unknown as { buttonMesh: Mesh }).buttonMesh;
const buttonMaterialOf = (button: Button2D): MeshBasicMaterial =>
  (button as unknown as { buttonMaterial: MeshBasicMaterial }).buttonMaterial;

describe('Button2D nine-slice skin', () => {
  it('keeps the shared unit quad and stays batchable with the default (zero) border', () => {
    const button = new Button2D({ id: 'btn', name: 'Button', width: 200, height: 100 });
    const mesh = buttonMeshOf(button);

    expect(button.sliceBorder).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(mesh.geometry).toBe(SHARED_UNIT_QUAD_GEOMETRY);
    expect(mesh.scale.x).toBe(200);
    expect(mesh.scale.y).toBe(100);
    expect(mesh.userData[BATCHABLE_2D_KEY]).toBe(true);
  });

  it('cuts a 3x3 patch whose corners keep their source pixel size as the button widens', () => {
    const button = new Button2D({
      id: 'btn',
      name: 'Button',
      width: 200,
      height: 100,
      sliceBorder: { left: 16, right: 16, top: 16, bottom: 16 },
    });
    button.setStateTexture('normal', fakeTexture(64, 64));

    const mesh = buttonMeshOf(button);
    // The patch bakes pixel positions, so the mesh must NOT also be scaled by size.
    expect(mesh.scale.x).toBe(1);
    expect(mesh.scale.y).toBe(1);
    expect(readQuads(mesh.geometry).length).toBe(9);

    const corner = bottomLeftQuad(mesh.geometry);
    expect(corner.x1 - corner.x0).toBeCloseTo(16, 5);
    expect(corner.y1 - corner.y0).toBeCloseTo(16, 5);
    // 16 of 64 source px = the first quarter of the texture, on both axes.
    expect(corner.u0).toBeCloseTo(0, 5);
    expect(corner.u1).toBeCloseTo(0.25, 5);
    expect(corner.v0).toBeCloseTo(0, 5);
    expect(corner.v1).toBeCloseTo(0.25, 5);

    // The whole point: doubling the width must not touch the corner.
    button.width = 400;
    const wider = buttonMeshOf(button);
    expect(geometryWidth(wider.geometry)).toBeCloseTo(400, 5);
    const widerCorner = bottomLeftQuad(wider.geometry);
    expect(widerCorner.x1 - widerCorner.x0).toBeCloseTo(16, 5);
    expect(widerCorner.u1 - widerCorner.u0).toBeCloseTo(0.25, 5);
  });

  it('opts a sliced skin out of the 2D quad batcher, and back in when the border clears', () => {
    // The batcher extracts four UNIT corners through matrixWorld; a batched
    // 9-slice would collapse back into one stretched quad.
    const button = new Button2D({ id: 'btn', name: 'Button', width: 200, height: 100 });
    const mesh = buttonMeshOf(button);

    button.setSliceBorder({ left: 8, right: 8, top: 8, bottom: 8 });
    expect(mesh.userData[BATCHABLE_2D_KEY]).toBe(false);

    button.setSliceBorder({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(mesh.geometry).toBe(SHARED_UNIT_QUAD_GEOMETRY);
    expect(mesh.scale.x).toBe(200);
    expect(mesh.userData[BATCHABLE_2D_KEY]).toBe(true);
  });

  it('re-cuts the patch for every state texture, not just the normal one', () => {
    const button = new Button2D({
      id: 'btn',
      name: 'Button',
      width: 200,
      height: 100,
      sliceBorder: { left: 16, right: 16, top: 16, bottom: 16 },
    });
    button.setStateTexture('normal', fakeTexture(64, 64));
    // A hover skin authored at a different resolution: same 16 px inset, so its
    // UV split has to land at 16/128 rather than 16/64.
    button.setStateTexture('hover', fakeTexture(128, 128));

    const mesh = buttonMeshOf(button);
    (button as unknown as { isHovering: boolean }).isHovering = true;
    (button as unknown as { onHover(v: boolean): void }).onHover(true);

    expect(buttonMaterialOf(button).map).not.toBeNull();
    const corner = bottomLeftQuad(mesh.geometry);
    expect(corner.x1 - corner.x0).toBeCloseTo(16, 5);
    expect(corner.u1 - corner.u0).toBeCloseTo(16 / 128, 5);
  });
});

describe('Checkbox2D texture slots', () => {
  interface CheckboxInternals {
    boxMaterial: MeshBasicMaterial;
    checkMesh: Mesh | null;
    checkMaterial: MeshBasicMaterial | null;
    checkGeometry: PlaneGeometry | null;
  }
  const internalsOf = (checkbox: Checkbox2D): CheckboxInternals =>
    checkbox as unknown as CheckboxInternals;

  it('shows the mark mesh only while checked, and draws it from the mark sprite', () => {
    const checkbox = new Checkbox2D({ id: 'cb', name: 'Checkbox', size: 40 });
    const mark = fakeTexture(32, 32);
    checkbox.setSlotTexture('mark', mark);

    // Unchecked: no mark mesh at all.
    expect(internalsOf(checkbox).checkMesh).toBeNull();

    checkbox.checked = true;
    const internals = internalsOf(checkbox);
    expect(internals.checkMesh).not.toBeNull();
    expect(internals.checkMaterial?.map).toBe(mark);
    // A mark SPRITE covers the box unrotated; the colour tick is the tilted bar.
    expect(internals.checkGeometry?.parameters.width).toBe(40);
    expect(internals.checkGeometry?.parameters.height).toBe(40);
    expect(internals.checkMesh?.rotation.z).toBe(0);

    checkbox.checked = false;
    expect(internalsOf(checkbox).checkMesh).toBeNull();
  });

  it('keeps the tilted colour tick when no mark sprite is set', () => {
    const checkbox = new Checkbox2D({ id: 'cb', name: 'Checkbox', size: 30, checked: true });
    const internals = internalsOf(checkbox);

    expect(internals.checkMesh?.rotation.z).toBeCloseTo(Math.PI / 4, 5);
    expect(internals.checkGeometry?.parameters.width).toBe(18);
  });

  it('swaps the box sprite with the checked state and falls back to the box slot', () => {
    const checkbox = new Checkbox2D({ id: 'cb', name: 'Checkbox' });
    const box = fakeTexture();
    const boxChecked = fakeTexture();
    checkbox.setSlotTexture('box', box);

    const material = internalsOf(checkbox).boxMaterial;
    expect(material.map).toBe(box);
    // Material colour goes white so the sprite is not tinted by the flat colour.
    expect(material.color.getHexString()).toBe('ffffff');

    // No checked sprite yet: the checked state falls back to the box sprite.
    checkbox.checked = true;
    expect(material.map).toBe(box);

    checkbox.setSlotTexture('boxChecked', boxChecked);
    expect(material.map).toBe(boxChecked);

    checkbox.checked = false;
    expect(material.map).toBe(box);
  });

  it('drops the loaded texture when a script assigns a different ref', () => {
    const checkbox = new Checkbox2D({ id: 'cb', name: 'Checkbox' });
    checkbox.setSlotTexture('box', fakeTexture());
    expect(internalsOf(checkbox).boxMaterial.map).not.toBeNull();

    checkbox.textureBox = { type: 'texture', url: 'res://ui/box.png' };

    expect(internalsOf(checkbox).boxMaterial.map).toBeNull();
  });
});

describe('Bar2D texture slots', () => {
  interface BarInternals {
    backgroundMaterial: MeshBasicMaterial;
    barMaterial: MeshBasicMaterial;
    barGeometry: BufferGeometry;
    backgroundGeometry: BufferGeometry;
  }
  const internalsOf = (bar: Bar2D): BarInternals => bar as unknown as BarInternals;

  it('shrinks a nine-sliced fill by re-cutting it, not by squashing the caps', () => {
    const bar = new Bar2D({
      id: 'bar',
      name: 'HP',
      width: 200,
      height: 20,
      minValue: 0,
      maxValue: 100,
      value: 100,
      sliceBorder: { left: 16, right: 16, top: 0, bottom: 0 },
    });
    bar.setSlotTexture('fill', fakeTexture(64, 64));
    bar.setSlotTexture('trough', fakeTexture(64, 64));

    const internals = internalsOf(bar);
    expect(geometryWidth(internals.barGeometry)).toBeCloseTo(200, 5);
    expect(
      bottomLeftQuad(internals.barGeometry).x1 - bottomLeftQuad(internals.barGeometry).x0
    ).toBeCloseTo(16, 5);

    bar.value = 25;
    const shrunk = internalsOf(bar).barGeometry;
    // The fill follows `value`...
    expect(geometryWidth(shrunk)).toBeCloseTo(50, 5);
    // ...and its left cap still measures 16 source px, not 16 * 0.25.
    const cap = bottomLeftQuad(shrunk);
    expect(cap.x1 - cap.x0).toBeCloseTo(16, 5);
    expect(cap.u1 - cap.u0).toBeCloseTo(0.25, 5);
  });

  it('keeps the plain PlaneGeometry fill (width == value) with the default border', () => {
    const bar = new Bar2D({
      id: 'bar',
      name: 'HP',
      width: 150,
      height: 20,
      minValue: 0,
      maxValue: 100,
      value: 40,
    });
    const geometry = internalsOf(bar).barGeometry as PlaneGeometry;
    expect(geometry.parameters.width).toBeCloseTo(60, 5);

    bar.value = 80;
    expect((internalsOf(bar).barGeometry as PlaneGeometry).parameters.width).toBeCloseTo(120, 5);
  });

  it('replaces the flat colours with the trough/fill sprites', () => {
    const bar = new Bar2D({ id: 'bar', name: 'HP', width: 150, height: 20 });
    const trough = fakeTexture();
    const fill = fakeTexture();

    bar.setSlotTexture('trough', trough);
    bar.setSlotTexture('fill', fill);

    const internals = internalsOf(bar);
    expect(internals.backgroundMaterial.map).toBe(trough);
    expect(internals.backgroundMaterial.color.getHexString()).toBe('ffffff');
    expect(internals.barMaterial.map).toBe(fill);
    expect(internals.barMaterial.color.getHexString()).toBe('ffffff');

    // A colour edit must not repaint over a sprite.
    bar.barColor = '#ff0000';
    expect(internals.barMaterial.color.getHexString()).toBe('ffffff');
  });
});

describe('Slider2D texture slots', () => {
  interface SliderInternals {
    trackMaterial: MeshBasicMaterial;
    filledTrackMaterial: MeshBasicMaterial;
    handleMaterial: MeshBasicMaterial;
    trackGeometry: BufferGeometry;
    filledTrackGeometry: BufferGeometry;
    handleGeometry: PlaneGeometry;
  }
  const internalsOf = (slider: Slider2D): SliderInternals => slider as unknown as SliderInternals;

  it('skins the track, fill and thumb, and never slices the thumb', () => {
    const slider = new Slider2D({
      id: 'sl',
      name: 'Volume',
      width: 200,
      height: 20,
      handleSize: 24,
      minValue: 0,
      maxValue: 100,
      value: 50,
      sliceBorder: { left: 8, right: 8, top: 0, bottom: 0 },
    });
    const track = fakeTexture();
    const fill = fakeTexture();
    const thumb = fakeTexture();

    slider.setSlotTexture('track', track);
    slider.setSlotTexture('fill', fill);
    slider.setSlotTexture('thumb', thumb);

    const internals = internalsOf(slider);
    expect(internals.trackMaterial.map).toBe(track);
    expect(internals.filledTrackMaterial.map).toBe(fill);
    expect(internals.handleMaterial.map).toBe(thumb);

    // Track and fill are patches; the thumb stays a plain quad at its authored size.
    // Only the horizontal insets are set here, so the zero-height top/bottom rows
    // collapse and the 3x3 grid degenerates to a 3-part strip — which is right.
    expect(readQuads(internals.trackGeometry).length).toBe(3);
    expect(geometryWidth(internals.filledTrackGeometry)).toBeCloseTo(100, 5);
    expect((internals.handleGeometry as PlaneGeometry).parameters.width).toBe(24);

    const cap = bottomLeftQuad(internals.filledTrackGeometry);
    expect(cap.x1 - cap.x0).toBeCloseTo(8, 5);
  });

  it('keeps plain PlaneGeometry track/fill with the default border', () => {
    const slider = new Slider2D({ id: 'sl', name: 'Volume', width: 200, height: 20, value: 25 });
    const internals = internalsOf(slider);

    expect((internals.trackGeometry as PlaneGeometry).parameters.width).toBe(200);
    expect((internals.filledTrackGeometry as PlaneGeometry).parameters.width).toBeCloseTo(50, 5);
  });
});
