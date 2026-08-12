import { describe, expect, it } from 'vitest';
import { Color, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';

import { Slider2D, type Slider2DProps } from './Slider2D';
import { InputService } from '../../../core/InputService';
import { reactiveSchemaPropertyNames } from '../../../fw/reactive-schema-properties';

interface SliderInternals {
  trackGeometry: PlaneGeometry;
  filledTrackGeometry: PlaneGeometry;
  handleGeometry: PlaneGeometry;
  filledTrackMesh: Mesh;
  handleMesh: Mesh;
  trackMaterial: MeshBasicMaterial;
  filledTrackMaterial: MeshBasicMaterial;
  handleMaterial: MeshBasicMaterial;
}

const internalsOf = (slider: Slider2D): SliderInternals => slider as unknown as SliderInternals;

function createSlider(overrides: Partial<Slider2DProps> = {}): Slider2D {
  // Defaults: width 200, minValue 0, maxValue 100, value 50.
  return new Slider2D({ id: 'slider', name: 'Slider', ...overrides });
}

function hexOf(style: string): number {
  return new Color(style).getHex();
}

describe('Slider2D script assignments (reactive schema properties)', () => {
  it('moves the fill and handle when a script assigns value directly', () => {
    // The schema routed `value` to a PRIVATE setValue(), so `slider.value = x` was the only
    // spelling scripts had — and it moved nothing on screen before the reactive install.
    const slider = createSlider();
    const internals = internalsOf(slider);

    slider.value = 75;

    // width 200, normalized 0.75 → fill 150, anchored to the left edge.
    expect(internals.filledTrackGeometry.parameters.width).toBe(150);
    expect(internals.filledTrackMesh.position.x).toBe(-100 + 75);
    expect(internals.handleMesh.position.x).toBe(-100 + 150);
  });

  it('clamps a script-assigned value to the min/max range', () => {
    const slider = createSlider();
    const internals = internalsOf(slider);

    slider.value = 500;

    expect(slider.value).toBe(100);
    expect(internals.filledTrackGeometry.parameters.width).toBe(200);
  });

  it('emits the virtual axis when a script assigns value', () => {
    const slider = createSlider({ axisName: 'Volume' });
    const input = new InputService();
    slider.input = input;

    slider.value = 25;

    expect(input.getAxis('Volume')).toBe(0.25);
  });

  it('rebuilds the track and refreshes the fill when width changes', () => {
    const slider = createSlider();
    const internals = internalsOf(slider);

    slider.width = 300;

    expect(internals.trackGeometry.parameters.width).toBe(300);
    // value 50/100 → fill 150; handle rides the new track: -150 + 150 = 0.
    expect(internals.filledTrackGeometry.parameters.width).toBe(150);
    expect(internals.handleMesh.position.x).toBe(0);
  });

  it('pushes colour assignments into the materials', () => {
    const slider = createSlider();
    const internals = internalsOf(slider);

    slider.handleColor = '#ff0000';
    slider.trackFilledColor = '#00ff00';
    slider.trackBackgroundColor = '#0000ff';

    expect(internals.handleMaterial.color.getHex()).toBe(hexOf('#ff0000'));
    expect(internals.filledTrackMaterial.color.getHex()).toBe(hexOf('#00ff00'));
    expect(internals.trackMaterial.color.getHex()).toBe(hexOf('#0000ff'));
  });

  it('installs reactive accessors for every own schema field', () => {
    const names = reactiveSchemaPropertyNames(createSlider());
    for (const expected of [
      'width',
      'height',
      'handleSize',
      'value',
      'minValue',
      'maxValue',
      'trackBackgroundColor',
      'trackFilledColor',
      'handleColor',
      'axisName',
    ]) {
      expect(names.has(expected), `${expected} should be reactive`).toBe(true);
    }
    // Base label props are already accessors on UIControl2D and must be left alone.
    expect(names.has('label')).toBe(false);
    expect(names.has('enabled')).toBe(false);
  });
});
