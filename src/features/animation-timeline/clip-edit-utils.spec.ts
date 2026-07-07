import { describe, expect, it } from 'vitest';
import {
  normalizeKeyframeAnimationSet,
  type AudioTrack,
  type EventTrack,
  type PropertyTrack,
} from '@pix3/runtime';
import {
  addAudioTrack,
  addClip,
  addEventTrack,
  addPropertyTrack,
  deleteClip,
  deleteKeys,
  duplicateClip,
  moveKeys,
  removeTrack,
  renameClip,
  setKeyEasing,
  setTrackEnabled,
  upsertAudioKey,
  upsertEventKey,
  upsertKey,
} from './clip-edit-utils';

function emptySet() {
  return normalizeKeyframeAnimationSet({ clips: [] });
}

describe('clip CRUD', () => {
  it('adds clips with unique names', () => {
    const set = emptySet();
    expect(addClip(set).name).toBe('new-clip');
    expect(addClip(set).name).toBe('new-clip-2');
    expect(addClip(set, 'walk').name).toBe('walk');
    expect(set.clips).toHaveLength(3);
  });

  it('renames clips, rejecting duplicates and blanks', () => {
    const set = emptySet();
    addClip(set, 'a');
    addClip(set, 'b');

    expect(renameClip(set, 'a', 'c')).toBe(true);
    expect(set.clips[0].name).toBe('c');
    expect(renameClip(set, 'c', 'b')).toBe(false);
    expect(renameClip(set, 'c', '   ')).toBe(false);
    expect(renameClip(set, 'missing', 'x')).toBe(false);
  });

  it('duplicates a clip with fresh track ids', () => {
    const set = emptySet();
    const clip = addClip(set, 'walk');
    const track = addPropertyTrack(clip, {
      targetPath: '',
      property: 'opacity',
      valueType: 'number',
      initialValue: 1,
    });

    const copy = duplicateClip(set, 'walk');
    expect(copy?.name).toBe('walk-2');
    expect(copy?.tracks[0].id).not.toBe(track?.id);
    expect((copy?.tracks[0] as PropertyTrack).keys).toHaveLength(1);
  });

  it('deletes clips', () => {
    const set = emptySet();
    addClip(set, 'a');
    expect(deleteClip(set, 'a')).toBe(true);
    expect(deleteClip(set, 'a')).toBe(false);
    expect(set.clips).toHaveLength(0);
  });
});

describe('tracks', () => {
  it('rejects duplicate target+property pairs', () => {
    const set = emptySet();
    const clip = addClip(set);

    expect(
      addPropertyTrack(clip, { targetPath: '.', property: 'opacity', valueType: 'number' })
    ).not.toBeNull();
    expect(
      addPropertyTrack(clip, { targetPath: '', property: 'opacity', valueType: 'number' })
    ).toBeNull();
    expect(
      addPropertyTrack(clip, { targetPath: 'Child', property: 'opacity', valueType: 'number' })
    ).not.toBeNull();
  });

  it('adds audio tracks, toggles and removes tracks', () => {
    const set = emptySet();
    const clip = addClip(set);
    const audio = addAudioTrack(clip, 'SFX');

    expect(setTrackEnabled(clip, audio.id, false)).toBe(true);
    expect(clip.tracks[0].enabled).toBe(false);
    expect(removeTrack(clip, audio.id)).toBe(true);
    expect(removeTrack(clip, audio.id)).toBe(false);
  });

  it('adds host-targeted event tracks with a default name', () => {
    const set = emptySet();
    const clip = addClip(set);
    const event = addEventTrack(clip);

    expect(event.kind).toBe('event');
    expect(event.name).toBe('Events');
    expect(event.targetPath).toBe('');
    expect(event.enabled).toBe(true);
    expect(event.keys).toEqual([]);
  });
});

describe('keys', () => {
  function trackWithKeys(): PropertyTrack {
    const set = emptySet();
    const clip = addClip(set);
    const track = addPropertyTrack(clip, {
      targetPath: '',
      property: 'opacity',
      valueType: 'number',
    });
    if (!track) {
      throw new Error('track');
    }
    upsertKey(track, 0, 0);
    upsertKey(track, 0.5, 0.5);
    upsertKey(track, 1, 1);
    return track;
  }

  it('upsertKey keeps keys sorted and replaces keys at the same time', () => {
    const track = trackWithKeys();
    upsertKey(track, 0.25, 0.25, 'quadOut');
    expect(track.keys.map(k => k.time)).toEqual([0, 0.25, 0.5, 1]);

    upsertKey(track, 0.5 + 1e-6, 0.75);
    expect(track.keys).toHaveLength(4);
    expect(track.keys[2].value).toBe(0.75);
  });

  it('upsertAudioKey replaces within epsilon', () => {
    const set = emptySet();
    const clip = addClip(set);
    const audio = addAudioTrack(clip) as AudioTrack;

    upsertAudioKey(audio, 0.5, 'res://a.mp3', 0.8);
    upsertAudioKey(audio, 0.5, 'res://b.mp3');
    expect(audio.keys).toHaveLength(1);
    expect(audio.keys[0].audioPath).toBe('res://b.mp3');
    expect(audio.keys[0].volume).toBe(1);
  });

  it('upsertEventKey inserts, sorts, and replaces within epsilon', () => {
    const set = emptySet();
    const clip = addClip(set);
    const event = addEventTrack(clip) as EventTrack;

    upsertEventKey(event, 1, 'late');
    upsertEventKey(event, 0.5, 'flash', '["white"]');
    expect(event.keys.map(k => k.signal)).toEqual(['flash', 'late']);

    upsertEventKey(event, 0.5 + 1e-6, 'flash', '["red", 2]');
    expect(event.keys).toHaveLength(2);
    expect(event.keys[0].args).toBe('["red", 2]');
  });

  it('moveKeys shifts selected keys, clamps, and swallows collisions', () => {
    const track = trackWithKeys();
    const newTimes = moveKeys(track, [0.5, 1], -0.5, 2);

    expect(newTimes).toEqual([0, 0.5]);
    // The unselected key at 0 collided with the moved key and was removed.
    expect(track.keys.map(k => k.time)).toEqual([0, 0.5]);
    expect(track.keys[0].value).toBe(0.5);
  });

  it('deleteKeys removes keys by time', () => {
    const track = trackWithKeys();
    expect(deleteKeys(track, [0.5, 42])).toBe(1);
    expect(track.keys.map(k => k.time)).toEqual([0, 1]);
  });

  it('setKeyEasing updates a key in place', () => {
    const track = trackWithKeys();
    expect(setKeyEasing(track, 0.5, 'bounceOut')).toBe(true);
    expect(track.keys[1].easing).toBe('bounceOut');
    expect(setKeyEasing(track, 0.42, 'bounceOut')).toBe(false);
  });
});
