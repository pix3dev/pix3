import { describe, expect, it, vi } from 'vitest';

import { reactiveSchemaPropertyNames } from '../fw/reactive-schema-properties';
import { AudioPlayer } from './AudioPlayer';

describe('AudioPlayer script assignments', () => {
  it('re-arms the autoplay latch when a script toggles autoplay off', () => {
    const player = new AudioPlayer({ id: 'a1', name: 'Audio', autoplay: true });
    const play = vi.spyOn(player, 'play').mockResolvedValue();

    player.tick(0.016);
    player.tick(0.016);
    expect(play).toHaveBeenCalledTimes(1); // the latch stops per-frame re-triggering

    // Before the reactive install a direct field write left the private latch set, so
    // turning autoplay back on never played again.
    player.autoplay = false;
    player.autoplay = true;
    player.tick(0.016);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('applies the Inspector normalization when fields are assigned directly', () => {
    const player = new AudioPlayer({ id: 'a2', name: 'Audio' });

    player.volume = 7;
    expect(player.volume).toBe(1); // clamped, not stored raw

    // Blank tracks normalize away. The reactive accessor settles on what getValue reports, and
    // audioTrack's getValue coalesces null to '' — either way play() sees "no track configured".
    player.audioTrack = '   ';
    expect(player.audioTrack).toBeFalsy();

    player.bus = 'not-a-bus' as never;
    expect(player.bus).toBe('sfx'); // unknown buses fall back
  });

  it('installs reactive accessors for the schema-backed plain fields', () => {
    const player = new AudioPlayer({ id: 'a3', name: 'Audio' });
    const reactive = reactiveSchemaPropertyNames(player);
    for (const name of [
      'audioTrack',
      'autoplay',
      'loop',
      'volume',
      'bus',
      'pitchVariation',
      'volumeVariation',
    ]) {
      expect(reactive.has(name), `${name} should be reactive`).toBe(true);
    }
  });
});
