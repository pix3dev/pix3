import { describe, expect, it } from 'vitest';
import { Color, Mesh, MeshBasicMaterial, PlaneGeometry, Vector2 } from 'three';

import { Slider2D, type Slider2DProps } from './Slider2D';
import { Group2D } from '../Group2D';
import { ScrollContainer2D } from './ScrollContainer2D';
import { InputService } from '../../../core/InputService';
import { reactiveSchemaPropertyNames } from '../../../fw/reactive-schema-properties';

/** Every lifecycle signal the shared UIControl2D funnel emits, in the order it emits them. */
const FUNNEL_SIGNALS = ['pointerdown', 'pressed', 'pointerup', 'released', 'click'] as const;

/** Records the funnel signals a control emits, in order. */
function recordSignals(slider: Slider2D): string[] {
  const seen: string[] = [];
  const listener = {};
  for (const name of FUNNEL_SIGNALS) {
    slider.connect(name, listener, () => seen.push(name));
  }
  return seen;
}

// Input 200x200 and no scene → the logical camera equals the input size, so screen (100,100) maps
// to world (0,0) — the track centre of a default 200-wide slider, i.e. value 50.
function createInputService(): InputService {
  const input = new InputService();
  input.width = 200;
  input.height = 200;
  return input;
}

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

describe('Slider2D pointer funnel (UIControl2D.updatePointerState)', () => {
  function createInteractive(overrides: Partial<Slider2DProps> = {}): {
    slider: Slider2D;
    input: InputService;
    signals: string[];
  } {
    const slider = createSlider(overrides);
    const input = createInputService();
    slider.input = input;
    return { slider, input, signals: recordSignals(slider) };
  }

  it('sets the value on the press frame and emits the lifecycle signals', () => {
    // Before the funnel the slider polled the pointer itself: it moved silently, with no signal a
    // script could connect to.
    const { slider, input, signals } = createInteractive();

    // Screen 150 → world +50 → 75% along a 200-wide track.
    input.pointerPosition.set(150, 100);
    input.isPointerDown = true;
    slider.tick(1 / 60);

    expect(slider.value).toBe(75);
    expect(slider.isDragging).toBe(true);
    expect(signals).toEqual(['pointerdown', 'pressed']);

    input.isPointerDown = false;
    slider.tick(1 / 60);

    expect(slider.isDragging).toBe(false);
    expect(signals).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);
  });

  it('keeps tracking the pointer after it leaves the track (pointer capture)', () => {
    // The one thing the funnel could not express before this change: a grabbed slider must follow
    // the finger past its own bounds, where a button would cancel.
    const { slider, input, signals } = createInteractive();

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    slider.tick(1 / 60);
    expect(slider.value).toBe(50);

    // Far right of the track and 40px below it — outside the bounds on both axes.
    input.pointerPosition.set(250, 140);
    slider.tick(1 / 60);

    expect(slider.value).toBe(100);
    expect(slider.isDragging).toBe(true);

    input.isPointerDown = false;
    slider.tick(1 / 60);

    expect(slider.isDragging).toBe(false);
    // Released outside: a completed drag, not a click.
    expect(signals).toEqual(['pointerdown', 'pressed', 'pointerup', 'released']);
  });

  it('stays put while the pointer never touches the track', () => {
    const { slider, input, signals } = createInteractive();

    input.pointerPosition.set(100, 190);
    input.isPointerDown = true;
    slider.tick(1 / 60);
    input.pointerPosition.set(150, 190);
    slider.tick(1 / 60);
    input.isPointerDown = false;
    slider.tick(1 / 60);

    expect(slider.value).toBe(50);
    expect(signals).toEqual([]);
  });

  it('ignores the pointer entirely while disabled', () => {
    const { slider, input, signals } = createInteractive();
    slider.enabled = false;

    input.pointerPosition.set(150, 100);
    input.isPointerDown = true;
    slider.tick(1 / 60);
    input.isPointerDown = false;
    slider.tick(1 / 60);

    expect(slider.value).toBe(50);
    expect(signals).toEqual([]);
  });

  it('drops the drag when an ancestor scroll container claims the gesture', () => {
    // A scroll drag that starts on the slider must scroll the list, not scrub the value — the
    // ancestor gate wins even over the slider's own pointer capture.
    const container = new ScrollContainer2D({ id: 'list', name: 'List', width: 220, height: 120 });
    const content = new Group2D({
      id: 'list-content',
      name: 'List Content',
      width: 220,
      height: 320,
      position: new Vector2(0, 0),
    });
    const slider = createSlider();
    const signals = recordSignals(slider);
    content.adoptChild(slider);
    container.adoptChild(content);
    const input = createInputService();
    container.input = input;

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    container.tick(1 / 60);
    expect(slider.value).toBe(50);

    // Diagonal: enough vertical travel for the container to claim the drag, and enough horizontal
    // travel that an ungated slider would have scrubbed to 65.
    input.pointerPosition.set(130, 130);
    container.tick(1 / 60);

    expect(container.hasActivePointerCapture()).toBe(true);
    expect(slider.value).toBe(50);
    expect(slider.isDragging).toBe(false);
    expect(signals).not.toContain('click');
  });
});
