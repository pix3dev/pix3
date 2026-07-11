import { describe, expect, it, vi } from 'vitest';
import type { SceneService } from '../core/SceneService';
import { Node2D } from '../nodes/Node2D';
import { AnimationPlayerBehavior } from './AnimationPlayerBehavior';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface TestSetup {
  host: Node2D;
  child: Node2D;
  player: AnimationPlayerBehavior;
  play: ReturnType<typeof vi.fn>;
  loadAudio: ReturnType<typeof vi.fn>;
}

function createPlayer(animations: unknown, config: Record<string, unknown> = {}): TestSetup {
  const host = new Node2D({ id: 'host', name: 'Host' });
  const child = new Node2D({ id: 'child', name: 'Icon' });
  host.adoptChild(child);

  const player = new AnimationPlayerBehavior('player-1', 'core:AnimationPlayer');
  const play = vi.fn();
  const loadAudio = vi.fn().mockResolvedValue({} as AudioBuffer);
  player.scene = {
    getAssetLoader: () => ({ loadAudio, getAudioMetadata: () => undefined }),
    getAudioService: () => ({ play }),
  } as unknown as SceneService;
  player.config = { ...player.config, ...config, animations };
  host.addComponent(player);

  return { host, child, player, play, loadAudio };
}

const MOVE_CLIP = {
  clips: [
    {
      name: 'move',
      duration: 1,
      loop: false,
      tracks: [
        {
          kind: 'property',
          targetPath: '',
          property: 'position',
          valueType: 'vector2',
          keys: [
            { time: 0, value: [0, 0], easing: 'linear' },
            { time: 1, value: [100, 50], easing: 'linear' },
          ],
        },
      ],
    },
  ],
};

describe('AnimationPlayerBehavior', () => {
  it('autoplays the configured clip and advances the pose via node.tick', () => {
    const { host } = createPlayer(MOVE_CLIP, { autoplay: 'move' });

    host.tick(0.5); // onStart (play) + onUpdate(0.5)
    expect(host.position.x).toBeCloseTo(50, 6);
    expect(host.position.y).toBeCloseTo(25, 6);
  });

  it('does not play without autoplay until play() is called', () => {
    const { host, player } = createPlayer(MOVE_CLIP);

    host.tick(0.5);
    expect(player.isPlaying).toBe(false);
    expect(host.position.x).toBe(0);

    expect(player.play('move')).toBe(true);
    host.tick(0.25);
    expect(player.isPlaying).toBe(true);
    expect(host.position.x).toBeCloseTo(25, 6);
  });

  it('returns false for unknown clips', () => {
    const { player } = createPlayer(MOVE_CLIP);
    expect(player.play('nope')).toBe(false);
    expect(player.isPlaying).toBe(false);
  });

  it('clamps to the final pose and emits animation_finished for non-looping clips', () => {
    const { host, player } = createPlayer(MOVE_CLIP, { autoplay: 'move' });
    const finished = vi.fn();
    host.connect('animation_finished', host, finished);

    host.tick(0.4);
    host.tick(2);

    expect(host.position.x).toBeCloseTo(100, 6);
    expect(player.isPlaying).toBe(false);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith('move');
  });

  it('wraps time and keeps playing for looping clips', () => {
    const looping = {
      clips: [{ ...MOVE_CLIP.clips[0], loop: true }],
    };
    const { host, player } = createPlayer(looping, { autoplay: 'move' });

    host.tick(0.75);
    host.tick(0.5); // 1.25 -> wraps to 0.25

    expect(player.isPlaying).toBe(true);
    expect(player.currentTime).toBeCloseTo(0.25, 6);
    expect(host.position.x).toBeCloseTo(25, 6);
  });

  it('respects the speed multiplier', () => {
    const { host, player } = createPlayer(MOVE_CLIP, { autoplay: 'move', speed: 2 });
    host.tick(0.25);
    expect(player.currentTime).toBeCloseTo(0.5, 6);
    expect(host.position.x).toBeCloseTo(50, 6);
  });

  it('seek applies the pose without playing; pause halts advancement', () => {
    const { host, player } = createPlayer(MOVE_CLIP);

    host.tick(0); // onStart
    player.play('move');
    player.pause();
    host.tick(0.5);
    expect(player.currentTime).toBe(0);
    expect(player.isPaused).toBe(true);

    player.seek(0.5);
    expect(host.position.x).toBeCloseTo(50, 6);

    player.resume();
    host.tick(0.25);
    expect(player.currentTime).toBeCloseTo(0.75, 6);
  });

  it('fires audio keys exactly once when the playhead crosses them', async () => {
    const withAudio = {
      clips: [
        {
          name: 'sfx',
          duration: 1,
          loop: false,
          tracks: [
            {
              kind: 'audio',
              keys: [
                { time: 0, audioPath: 'res://start.mp3', volume: 1 },
                { time: 0.5, audioPath: 'res://mid.mp3', volume: 0.5 },
              ],
            },
          ],
        },
      ],
    };
    const { host, play } = createPlayer(withAudio, { autoplay: 'sfx' });

    host.tick(0.4); // fires the t=0 key (includeStart on first frame)
    await flushMicrotasks();
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0][1]).toMatchObject({ resourcePath: 'res://start.mp3', volume: 1 });

    host.tick(0.2); // crosses t=0.5
    await flushMicrotasks();
    expect(play).toHaveBeenCalledTimes(2);
    expect(play.mock.calls[1][1]).toMatchObject({ resourcePath: 'res://mid.mp3', volume: 0.5 });

    host.tick(0.2); // no keys in (0.6, 0.8]
    await flushMicrotasks();
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('fires event keys exactly once when the playhead crosses them', () => {
    const withEvents = {
      clips: [
        {
          name: 'cue',
          duration: 1,
          loop: false,
          tracks: [
            {
              kind: 'event',
              name: 'Events',
              targetPath: '',
              keys: [
                { time: 0, signal: 'intro_started', args: '' },
                { time: 0.5, signal: 'flash', args: '["white", 3]' },
              ],
            },
          ],
        },
      ],
    };
    const { host } = createPlayer(withEvents, { autoplay: 'cue' });
    const started = vi.fn();
    const flash = vi.fn();
    host.connect('intro_started', host, started);
    host.connect('flash', host, flash);

    host.tick(0.4); // fires the t=0 key (includeStart on first frame)
    expect(started).toHaveBeenCalledTimes(1);
    expect(flash).not.toHaveBeenCalled();

    host.tick(0.2); // crosses t=0.5
    expect(flash).toHaveBeenCalledTimes(1);
    expect(flash).toHaveBeenCalledWith('white', 3);

    host.tick(0.2); // no keys in (0.6, 0.8]
    expect(started).toHaveBeenCalledTimes(1);
    expect(flash).toHaveBeenCalledTimes(1);
  });

  it('emits event keys to a descendant target node', () => {
    const withEvents = {
      clips: [
        {
          name: 'cue',
          duration: 1,
          tracks: [
            {
              kind: 'event',
              name: 'Child events',
              targetPath: 'Icon',
              keys: [{ time: 0.5, signal: 'hit', args: '' }],
            },
          ],
        },
      ],
    };
    const { host, child } = createPlayer(withEvents, { autoplay: 'cue' });
    const hit = vi.fn();
    child.connect('hit', child, hit);

    host.tick(0.6);
    expect(hit).toHaveBeenCalledTimes(1);
  });

  it('preloads audio buffers on start', async () => {
    const withAudio = {
      clips: [
        {
          name: 'sfx',
          duration: 1,
          tracks: [
            { kind: 'audio', keys: [{ time: 0.5, audioPath: 'res://boom.mp3', volume: 1 }] },
          ],
        },
      ],
    };
    const { host, loadAudio } = createPlayer(withAudio);

    host.tick(0);
    await flushMicrotasks();
    expect(loadAudio).toHaveBeenCalledWith('res://boom.mp3');
  });

  it('invalidateBindings picks up new clip data', () => {
    const { host, player } = createPlayer(MOVE_CLIP, { autoplay: 'move' });
    host.tick(0.5);
    expect(host.position.x).toBeCloseTo(50, 6);

    player.config.animations = {
      clips: [
        {
          name: 'move',
          duration: 1,
          tracks: [
            {
              kind: 'property',
              targetPath: '',
              property: 'position',
              valueType: 'vector2',
              keys: [
                { time: 0, value: [0, 0], easing: 'linear' },
                { time: 1, value: [-100, 0], easing: 'linear' },
              ],
            },
          ],
        },
      ],
    };
    player.invalidateBindings();
    player.play('move');
    host.tick(0.5);
    expect(host.position.x).toBeCloseTo(-50, 6);
  });

  it('stop halts playback and keeps the current pose', () => {
    const { host, player } = createPlayer(MOVE_CLIP, { autoplay: 'move' });
    host.tick(0.5);
    player.stop();
    host.tick(0.25);

    expect(player.isPlaying).toBe(false);
    expect(host.position.x).toBeCloseTo(50, 6);
  });
});

const FINISH_CLIP = {
  clips: [
    {
      name: 'cut',
      duration: 1,
      loop: false,
      tracks: [
        {
          kind: 'property',
          targetPath: '',
          property: 'position',
          valueType: 'vector2',
          keys: [
            { time: 0, value: [0, 0], easing: 'linear' },
            { time: 1, value: [100, 0], easing: 'linear' },
          ],
        },
        {
          kind: 'event',
          name: 'Events',
          targetPath: '',
          keys: [{ time: 0.9, signal: 'boss_spawn', args: '' }],
        },
      ],
    },
  ],
};

describe('AnimationPlayerBehavior.finish (Cutscene Director skip, D8)', () => {
  it('fires the remaining event keys once, snaps to the end pose, and emits animation_finished', () => {
    const { host, player } = createPlayer(FINISH_CLIP, { autoplay: 'cut' });
    const finished = vi.fn();
    const bossSpawn = vi.fn();
    host.connect('animation_finished', host, finished);
    host.connect('boss_spawn', host, bossSpawn);

    host.tick(0.2); // onStart → play('cut'), advance to t=0.2 (x=20); event at 0.9 not yet fired
    expect(bossSpawn).not.toHaveBeenCalled();
    expect(host.position.x).toBeCloseTo(20, 6);

    player.finish(true);

    expect(bossSpawn).toHaveBeenCalledTimes(1); // the 0.9 event is not silently dropped
    expect(host.position.x).toBeCloseTo(100, 6); // end pose applied
    expect(player.isPlaying).toBe(false);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith('cut');
  });

  it('finish(false) skips the remaining keys but still poses and emits', () => {
    const { host, player } = createPlayer(FINISH_CLIP, { autoplay: 'cut' });
    const finished = vi.fn();
    const bossSpawn = vi.fn();
    host.connect('animation_finished', host, finished);
    host.connect('boss_spawn', host, bossSpawn);

    host.tick(0.2);
    player.finish(false);

    expect(bossSpawn).not.toHaveBeenCalled();
    expect(host.position.x).toBeCloseTo(100, 6);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('degrades to stop + emit for a looping clip (no end to fast-forward to)', () => {
    const looping = { clips: [{ ...FINISH_CLIP.clips[0], loop: true }] };
    const { host, player } = createPlayer(looping, { autoplay: 'cut' });
    const finished = vi.fn();
    const bossSpawn = vi.fn();
    host.connect('animation_finished', host, finished);
    host.connect('boss_spawn', host, bossSpawn);

    host.tick(0.2);
    player.finish(true);

    expect(player.isPlaying).toBe(false);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith('cut');
    expect(bossSpawn).not.toHaveBeenCalled(); // no wrap window fired
    expect(host.position.x).toBeCloseTo(20, 6); // pose left where it was
  });

  it('is a no-op when not playing', () => {
    const { host, player } = createPlayer(FINISH_CLIP);
    const finished = vi.fn();
    host.connect('animation_finished', host, finished);

    player.finish();

    expect(finished).not.toHaveBeenCalled();
    expect(player.isPlaying).toBe(false);
  });

  it('is a no-op after stop() even though the clip is still the active one', () => {
    // stop() leaves activeClipName set, so this exercises the `!this.playing`
    // guard (not the missing-clip short-circuit): a stopped player must not
    // re-fire keys / re-emit on finish().
    const { host, player } = createPlayer(FINISH_CLIP, { autoplay: 'cut' });
    const finished = vi.fn();
    const bossSpawn = vi.fn();
    host.connect('animation_finished', host, finished);
    host.connect('boss_spawn', host, bossSpawn);

    host.tick(0.2);
    player.stop();
    expect(player.currentClipName).toBe('cut'); // clip still active, just not playing

    player.finish(true);

    expect(finished).not.toHaveBeenCalled();
    expect(bossSpawn).not.toHaveBeenCalled();
    expect(host.position.x).toBeCloseTo(20, 6); // pose untouched
  });
});
