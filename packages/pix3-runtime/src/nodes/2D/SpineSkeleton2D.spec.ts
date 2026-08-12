import { describe, expect, it, vi } from 'vitest';
import type { Color } from 'three';

import { SpineSkeleton2D } from './SpineSkeleton2D';
import { reactiveSchemaPropertyNames } from '../../fw/reactive-schema-properties';

/** The colour the per-frame applyTint pushes into the skeleton — the rendered tint input. */
const tintColorOf = (spine: SpineSkeleton2D): Color =>
  (spine as unknown as { tintColor: Color }).tintColor;

/**
 * Spine is a host-injected optional dependency, so tests never build a real view.
 * This fake covers exactly the surface the routed setValue paths call; injecting it
 * proves the write reaches the renderable, not just the field.
 */
function makeFakeView() {
  return {
    object: { parent: null },
    play: vi.fn().mockReturnValue(true),
    stop: vi.fn(),
    setSkin: vi.fn().mockReturnValue(true),
    setTimeScale: vi.fn(),
    setDefaultMix: vi.fn(),
    setTint: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
    getAnimationNames: vi.fn().mockReturnValue(['run']),
    getSkinNames: vi.fn().mockReturnValue(['warrior']),
  };
}

function makeSpine(withView: boolean): {
  spine: SpineSkeleton2D;
  view: ReturnType<typeof makeFakeView>;
} {
  const spine = new SpineSkeleton2D({ id: 'sp', name: 'Spine' });
  const view = makeFakeView();
  if (withView) {
    (spine as unknown as { view: unknown }).view = view;
  }
  return { spine, view };
}

describe('SpineSkeleton2D schema-property reactivity (direct script assignment)', () => {
  it('installs the schema-backed fields as reactive accessors', () => {
    const { spine } = makeSpine(false);
    const reactive = reactiveSchemaPropertyNames(spine);
    for (const name of [
      'color',
      'skin',
      'timeScale',
      'animation',
      'loop',
      'defaultMix',
      'twoColorTint',
    ]) {
      expect(reactive.has(name), `expected "${name}" to be reactive`).toBe(true);
    }
  });

  it('color assignment updates the tint the per-frame applyTint reads', () => {
    const { spine } = makeSpine(false);
    spine.color = '#ff0000';
    // The bug: applyTint reads the private tintColor, so a bare field write NEVER tinted —
    // not even on a later frame. The proof is the tintColor, not the field.
    expect(tintColorOf(spine).getHex()).toBe(0xff0000);
  });

  it('color assignment pushes the tint into a loaded view immediately', () => {
    const { spine, view } = makeSpine(true);
    spine.color = '#00ff00';
    expect(view.setTint).toHaveBeenCalledWith({ r: 0, g: 1, b: 0 }, 1);
    expect(view.refresh).toHaveBeenCalled();
  });

  it('skin assignment applies the skin to the view and syncs serialization', () => {
    const { spine, view } = makeSpine(true);
    spine.skin = 'warrior';
    expect(view.setSkin).toHaveBeenCalledWith('warrior');
    expect(view.setSkin).toHaveBeenCalledTimes(1);
    expect(spine.properties.skin).toBe('warrior');
  });

  it('timeScale assignment reaches the view', () => {
    const { spine, view } = makeSpine(true);
    spine.timeScale = 2;
    expect(view.setTimeScale).toHaveBeenCalledWith(2);
    expect(spine.properties.timeScale).toBe(2);
  });

  it('animation assignment (re)plays the authored animation on the view', () => {
    const { spine, view } = makeSpine(true);
    spine.animation = 'run';
    expect(view.play).toHaveBeenCalledWith('run', { loop: true });
    expect(view.refresh).toHaveBeenCalled();
  });

  it('loop assignment restarts the authored animation with the new loop flag', () => {
    const { spine, view } = makeSpine(true);
    spine.animation = 'run';
    view.play.mockClear();
    spine.loop = false;
    expect(view.play).toHaveBeenCalledWith('run', { loop: false });
  });

  it('defaultMix assignment clamps and reaches the view', () => {
    const { spine, view } = makeSpine(true);
    spine.defaultMix = 0.25;
    expect(view.setDefaultMix).toHaveBeenCalledWith(0.25);
    spine.defaultMix = -1;
    expect(spine.defaultMix).toBe(0); // getter reflects the clamp, not the raw write
  });

  it('twoColorTint assignment rebuilds the view (materials bake the flag at construction)', () => {
    const { spine, view } = makeSpine(true);
    spine.twoColorTint = true;
    // No asset is loaded here, so the rebuild tears the old view down and waits for the
    // loader — exactly what setSpineAsset does for a real toggle mid-load.
    expect(view.dispose).toHaveBeenCalled();
    expect(spine.isLoaded).toBe(false);
    expect(spine.twoColorTint).toBe(true);
  });

  it('every routed write tolerates the view not being loaded yet', () => {
    const { spine } = makeSpine(false);
    expect(() => {
      spine.color = '#123456';
      spine.skin = 'warrior';
      spine.timeScale = 0.5;
      spine.animation = 'run';
      spine.loop = false;
      spine.defaultMix = 0.1;
      spine.twoColorTint = true;
    }).not.toThrow();
    // Authored state still lands, so setSpineAsset re-applies it once the asset arrives.
    expect(spine.skin).toBe('warrior');
    expect(spine.properties.animation).toBe('run');
  });
});
