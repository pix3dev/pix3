import { describe, expect, it } from 'vitest';

import { PostProcess, POST_PROCESS_DEFAULTS } from './PostProcess';

describe('PostProcess node', () => {
  it('applies defaults for a freshly created node (bloom on, rest off)', () => {
    const pp = new PostProcess({ id: 'pp-1', name: 'PostFX' });

    expect(pp.type).toBe('PostProcess');
    expect(pp.isContainer).toBe(false);
    expect(pp.affect2D).toBe(POST_PROCESS_DEFAULTS.affect2D);
    expect(pp.bloomEnabled).toBe(true);
    expect(pp.bloomIntensity).toBe(POST_PROCESS_DEFAULTS.bloomIntensity);
    expect(pp.vignetteEnabled).toBe(false);
    expect(pp.chromaticAberrationEnabled).toBe(false);
    expect(pp.lutEnabled).toBe(false);
    expect(pp.treeIcon).toBe('sparkles');
  });

  it('reports isActive only when at least one effect is enabled', () => {
    const pp = new PostProcess({ id: 'pp-2', name: 'PostFX', bloomEnabled: false });
    expect(pp.isActive()).toBe(false);

    pp.vignetteEnabled = true;
    expect(pp.isActive()).toBe(true);
    pp.vignetteEnabled = false;
    expect(pp.isActive()).toBe(false);

    pp.chromaticAberrationEnabled = true;
    expect(pp.isActive()).toBe(true);
    pp.chromaticAberrationEnabled = false;

    pp.bloomEnabled = true;
    expect(pp.isActive()).toBe(true);
  });

  it('treats LUT as inactive until a source is provided', () => {
    const pp = new PostProcess({ id: 'pp-3', name: 'PostFX', bloomEnabled: false, lutEnabled: true });
    expect(pp.isActive()).toBe(false); // enabled but no src

    pp.lutSrc = 'res://luts/warm.cube';
    expect(pp.isActive()).toBe(true);
  });

  it('clamps numeric setters and ignores non-finite input', () => {
    const pp = new PostProcess({ id: 'pp-4', name: 'PostFX' });

    pp.bloomIntensity = -5;
    expect(pp.bloomIntensity).toBe(0); // clamped to min 0

    pp.bloomIntensity = 2.5;
    expect(pp.bloomIntensity).toBe(2.5);
    pp.bloomIntensity = Number.NaN;
    expect(pp.bloomIntensity).toBe(2.5); // NaN ignored, keeps previous

    pp.lutIntensity = 5;
    expect(pp.lutIntensity).toBe(1); // clamped to [0,1]
    pp.lutIntensity = -1;
    expect(pp.lutIntensity).toBe(0);
  });

  it('exposes a structured config snapshot mirroring the flat properties', () => {
    const pp = new PostProcess({
      id: 'pp-5',
      name: 'PostFX',
      affect2D: false,
      bloomEnabled: true,
      bloomIntensity: 1.5,
      bloomThreshold: 0.6,
      vignetteEnabled: true,
      vignetteOffset: 0.4,
      vignetteDarkness: 0.7,
      chromaticAberrationEnabled: true,
      chromaticAberrationOffset: 0.003,
    });

    const config = pp.getConfig();
    expect(config.affect2D).toBe(false);
    expect(config.bloom).toEqual({
      enabled: true,
      intensity: 1.5,
      threshold: 0.6,
      smoothing: POST_PROCESS_DEFAULTS.bloomSmoothing,
      radius: POST_PROCESS_DEFAULTS.bloomRadius,
    });
    expect(config.vignette).toEqual({ enabled: true, offset: 0.4, darkness: 0.7 });
    expect(config.chromaticAberration).toEqual({ enabled: true, offset: 0.003 });
  });

  it('hydrates from the node properties map (loader path)', () => {
    // The SceneLoader passes serialized config through `properties`; the
    // constructor must read it from there when no explicit props are given.
    const pp = new PostProcess({
      id: 'pp-6',
      name: 'PostFX',
      properties: {
        bloomEnabled: false,
        vignetteEnabled: true,
        vignetteDarkness: 0.9,
        affect2D: false,
      },
    });

    expect(pp.bloomEnabled).toBe(false);
    expect(pp.vignetteEnabled).toBe(true);
    expect(pp.vignetteDarkness).toBe(0.9);
    expect(pp.affect2D).toBe(false);
  });
});
