/**
 * AnimationPlayer script component (`core:AnimationPlayer`).
 *
 * Plays keyframe animation clips authored in the editor timeline on the host
 * node and its descendants. Clip data lives in `config.animations` (see
 * `keyframe-types.ts`) and therefore serializes with the scene.
 *
 * Signals emitted on the host node:
 * - `animation_started` (clipName)
 * - `animation_finished` (clipName) — non-looping clips only
 */

import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import {
  applyClipAtTime,
  collectAudioKeysInRange,
  collectEventKeysInRange,
  createClipBindings,
  fireEventKey,
  type ClipBinding,
} from './clip-evaluator';
import {
  createEmptyAnimationSet,
  findKeyframeClip,
  normalizeKeyframeAnimationSet,
  type AudioKeyframe,
  type KeyframeAnimationSet,
  type KeyframeClip,
} from './keyframe-types';

export class AnimationPlayerBehavior extends Script {
  private cachedSet: KeyframeAnimationSet | null = null;
  private activeClipName: string | null = null;
  private binding: ClipBinding | null = null;
  private time = 0;
  private playing = false;
  private paused = false;
  /** Fire audio keys at exactly t=0 on the first update after play(). */
  private pendingStartAudio = false;
  private missingTargetsWarned = false;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      autoplay: '',
      speed: 1,
      animations: createEmptyAnimationSet(),
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'AnimationPlayerBehavior',
      properties: [
        {
          name: 'autoplay',
          type: 'string',
          ui: {
            label: 'Autoplay Clip',
            description: 'Clip name to play automatically on start (empty = none)',
            group: 'Animation',
          },
          getValue: component => (component as AnimationPlayerBehavior).getAutoplay(),
          setValue: (component, value) => {
            (component as AnimationPlayerBehavior).config.autoplay =
              typeof value === 'string' ? value.trim() : '';
          },
        },
        {
          name: 'speed',
          type: 'number',
          ui: {
            label: 'Speed',
            description: 'Playback speed multiplier',
            group: 'Animation',
            min: 0,
            step: 0.1,
            precision: 2,
          },
          getValue: component => (component as AnimationPlayerBehavior).getSpeed(),
          setValue: (component, value) => {
            const num = typeof value === 'number' ? value : Number(value);
            (component as AnimationPlayerBehavior).config.speed = Number.isFinite(num)
              ? Math.max(0, num)
              : 1;
          },
        },
        {
          // Hidden from the inspector (edited via the Animation timeline panel).
          // Declaring it here gives free normalization when scenes load,
          // because SceneLoader re-applies config values through setValue.
          name: 'animations',
          type: 'object',
          ui: {
            label: 'Animations',
            group: 'Animation',
            hidden: true,
          },
          getValue: component => (component as AnimationPlayerBehavior).getAnimationSet(),
          setValue: (component, value) => {
            const player = component as AnimationPlayerBehavior;
            player.config.animations = normalizeKeyframeAnimationSet(value);
            player.invalidateBindings();
          },
        },
      ],
      groups: {
        Animation: {
          label: 'Animation',
          expanded: true,
        },
      },
    };
  }

  onStart(): void {
    this.warmUpAudio();
    const autoplay = this.getAutoplay();
    if (autoplay.length > 0) {
      this.play(autoplay);
    }
  }

  onUpdate(dt: number): void {
    if (!this.playing || this.paused) {
      return;
    }

    const clip = this.getActiveClip();
    if (!clip) {
      this.playing = false;
      return;
    }

    const binding = this.ensureBinding(clip);
    const includeStart = this.pendingStartAudio;
    this.pendingStartAudio = false;

    const prev = this.time;
    let next = prev + dt * this.getSpeed();

    if (next >= clip.duration) {
      if (clip.loop && clip.duration > 0) {
        this.fireTimeWindow(binding, prev, clip.duration, includeStart);
        next = next % clip.duration;
        this.time = next;
        applyClipAtTime(binding, next);
        this.fireTimeWindow(binding, 0, next, true);
      } else {
        this.fireTimeWindow(binding, prev, clip.duration, includeStart);
        this.time = clip.duration;
        applyClipAtTime(binding, clip.duration);
        this.playing = false;
        this.node?.emit('animation_finished', clip.name);
      }
      return;
    }

    this.time = next;
    applyClipAtTime(binding, next);
    this.fireTimeWindow(binding, prev, next, includeStart);
  }

  override onDetach(): void {
    this.playing = false;
    this.paused = false;
    this.binding = null;
    super.onDetach();
  }

  /**
   * Start playing a clip. Without an argument, plays the autoplay clip or the
   * first clip in the set. Returns false when no matching clip exists.
   */
  play(clipName?: string): boolean {
    const set = this.getAnimationSet();
    const requested = clipName ?? (this.getAutoplay() || undefined);
    const clip = findKeyframeClip(set, requested) ?? (requested ? null : (set.clips[0] ?? null));
    if (!clip) {
      return false;
    }

    this.activeClipName = clip.name;
    this.binding = null;
    this.time = 0;
    this.playing = true;
    this.paused = false;
    this.pendingStartAudio = true;
    this.node?.emit('animation_started', clip.name);
    return true;
  }

  /** Halt playback. The current pose is kept as-is (Godot-style). */
  stop(): void {
    this.playing = false;
    this.paused = false;
    this.pendingStartAudio = false;
  }

  pause(): void {
    if (this.playing) {
      this.paused = true;
    }
  }

  resume(): void {
    this.paused = false;
  }

  /** Jump to a time within the active clip and (by default) apply the pose. */
  seek(time: number, apply = true): void {
    const clip = this.getActiveClip();
    if (!clip) {
      return;
    }
    this.time = Math.min(Math.max(0, time), clip.duration);
    if (apply) {
      applyClipAtTime(this.ensureBinding(clip), this.time);
    }
  }

  get currentTime(): number {
    return this.time;
  }

  get duration(): number {
    return this.getActiveClip()?.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing && !this.paused;
  }

  get isPaused(): boolean {
    return this.playing && this.paused;
  }

  get currentClipName(): string | null {
    return this.activeClipName;
  }

  /** The normalized animation set (cached until invalidateBindings). */
  getAnimationSet(): KeyframeAnimationSet {
    if (!this.cachedSet) {
      this.cachedSet = normalizeKeyframeAnimationSet(this.config.animations);
    }
    return this.cachedSet;
  }

  /**
   * Drop cached clip data and target bindings. The editor calls this after
   * mutating `config.animations` or after structural scene changes.
   */
  invalidateBindings(): void {
    this.cachedSet = null;
    this.binding = null;
    this.missingTargetsWarned = false;
  }

  private getActiveClip(): KeyframeClip | null {
    if (!this.activeClipName) {
      return null;
    }
    return findKeyframeClip(this.getAnimationSet(), this.activeClipName);
  }

  private ensureBinding(clip: KeyframeClip): ClipBinding {
    if (!this.binding || this.binding.clip !== clip) {
      const host = this.node;
      if (!host) {
        return { clip, entries: [], audioTracks: [], eventEntries: [], missingTargets: [] };
      }
      this.binding = createClipBindings(host, clip);
      if (this.binding.missingTargets.length > 0 && !this.missingTargetsWarned) {
        this.missingTargetsWarned = true;
        console.warn(
          `[AnimationPlayer] Clip "${clip.name}" has unresolved tracks on node "${host.name}":`,
          this.binding.missingTargets
        );
      }
    }
    return this.binding;
  }

  /**
   * Fire all time-window keys (audio + events) crossed while advancing from
   * `from` to `to`. Audio and events share identical windowing so that keys on
   * either kind of track fire exactly once per crossing, including loop wraps.
   */
  private fireTimeWindow(
    binding: ClipBinding,
    from: number,
    to: number,
    includeStart: boolean
  ): void {
    for (const track of binding.audioTracks) {
      const keys = collectAudioKeysInRange(track, from, to, {
        wrapDuration: binding.clip.duration,
        includeStart,
      });
      for (const key of keys) {
        void this.playAudioKey(key);
      }
    }

    for (const entry of binding.eventEntries) {
      const keys = collectEventKeysInRange(entry.track, from, to, {
        wrapDuration: binding.clip.duration,
        includeStart,
      });
      for (const key of keys) {
        fireEventKey(entry.node, key);
      }
    }
  }

  private async playAudioKey(key: AudioKeyframe): Promise<void> {
    const scene = this.scene;
    if (!scene || key.audioPath.length === 0) {
      return;
    }

    const assetLoader = scene.getAssetLoader();
    const audioService = scene.getAudioService();
    if (!assetLoader || !audioService) {
      return;
    }

    try {
      const buffer = await assetLoader.loadAudio(key.audioPath);
      // Re-check the audio service after the async load (scene may have stopped).
      const currentAudioService = scene.getAudioService();
      if (!currentAudioService) {
        return;
      }
      const audioMetadata = assetLoader.getAudioMetadata(key.audioPath);
      currentAudioService.play(buffer, {
        resourcePath: key.audioPath,
        sizeBytes: audioMetadata?.sizeBytes,
        volume: key.volume,
      });
    } catch (error) {
      console.warn(`[AnimationPlayer] Failed to play audio key "${key.audioPath}":`, error);
    }
  }

  private warmUpAudio(): void {
    const assetLoader = this.scene?.getAssetLoader();
    if (!assetLoader) {
      return;
    }
    const paths = new Set<string>();
    for (const clip of this.getAnimationSet().clips) {
      for (const track of clip.tracks) {
        if (track.kind !== 'audio') {
          continue;
        }
        for (const key of track.keys) {
          if (key.audioPath.length > 0) {
            paths.add(key.audioPath);
          }
        }
      }
    }
    for (const path of paths) {
      void assetLoader.loadAudio(path).catch(error => {
        console.warn(`[AnimationPlayer] Failed to preload audio "${path}":`, error);
      });
    }
  }

  private getAutoplay(): string {
    const value = this.config.autoplay;
    return typeof value === 'string' ? value.trim() : '';
  }

  private getSpeed(): number {
    const value = this.config.speed;
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) && num >= 0 ? num : 1;
  }
}
