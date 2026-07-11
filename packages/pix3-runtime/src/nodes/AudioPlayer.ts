import { NodeBase, type NodeBaseProps } from './NodeBase';
import type { PropertySchema } from '../fw/property-schema';
import { AUDIO_BUS_NAMES, type AudioBusName, type AudioPlayback } from '../core/AudioService';

export interface AudioPlayerProps extends Omit<NodeBaseProps, 'type'> {
  audioTrack?: string | null;
  autoplay?: boolean;
  loop?: boolean;
  volume?: number;
  bus?: string;
  pitchVariation?: number;
  volumeVariation?: number;
}

export class AudioPlayer extends NodeBase {
  audioTrack: string | null;
  autoplay: boolean;
  loop: boolean;
  volume: number;
  bus: AudioBusName;
  pitchVariation: number;
  volumeVariation: number;

  private playback: AudioPlayback | null = null;
  private autoPlayed = false;

  constructor(props: AudioPlayerProps) {
    super({ ...props, type: 'AudioPlayer' });

    this.audioTrack = AudioPlayer.normalizeTrack(props.audioTrack ?? this.properties.audioTrack);
    this.autoplay = AudioPlayer.toBoolean(props.autoplay ?? this.properties.autoplay, false);
    this.loop = AudioPlayer.toBoolean(props.loop ?? this.properties.loop, false);
    this.volume = AudioPlayer.clampVolume(props.volume ?? this.properties.volume, 1);
    this.bus = AudioPlayer.normalizeBus(props.bus ?? this.properties.bus);
    this.pitchVariation = AudioPlayer.clampVariation(props.pitchVariation ?? this.properties.pitchVariation);
    this.volumeVariation = AudioPlayer.clampVariation(
      props.volumeVariation ?? this.properties.volumeVariation
    );
  }

  get treeIcon(): string {
    return 'speaker';
  }

  override tick(dt: number): void {
    super.tick(dt);

    if (!this.autoPlayed && this.autoplay) {
      this.autoPlayed = true;
      void this.play();
    }
  }

  async play(): Promise<void> {
    if (!this.audioTrack) {
      console.warn(`[AudioPlayer] Node "${this.name}" has no audio track configured.`);
      return;
    }

    const scene = this.scene;
    if (!scene) {
      console.warn(`[AudioPlayer] Node "${this.name}" is not attached to a running scene.`);
      return;
    }

    const assetLoader = scene.getAssetLoader();
    const audioService = scene.getAudioService();
    if (!assetLoader || !audioService) {
      console.warn(
        '[AudioPlayer] Audio services are not available in the current runtime context.'
      );
      return;
    }

    try {
      const buffer = await assetLoader.loadAudio(this.audioTrack);

      // Re-check scene and audio service after async load to handle stop/unmount during loading
      const currentAudioService = scene.getAudioService();
      if (!currentAudioService) {
        return;
      }
      const audioMetadata = assetLoader.getAudioMetadata(this.audioTrack);

      this.stop();
      this.playback = currentAudioService.play(buffer, {
        resourcePath: this.audioTrack,
        sizeBytes: audioMetadata?.sizeBytes,
        loop: this.loop,
        volume: this.volume,
        bus: this.bus,
        pitchVariation: this.pitchVariation,
        volumeVariation: this.volumeVariation,
      });
    } catch (error) {
      console.warn(`[AudioPlayer] Failed to play "${this.audioTrack}":`, error);
    }
  }

  stop(): void {
    this.playback?.stop();
    this.playback = null;
  }

  /**
   * Live authored config for the saver. AudioPlayer schema setters write
   * instance fields (not the `properties` bag), so — like Camera2D /
   * VirtualCamera3D — the saver must read them back through here. Without this,
   * inspector edits were serialized from the stale load-time `properties`.
   */
  serializeConfig(): Record<string, unknown> {
    return {
      audioTrack: this.audioTrack ?? undefined,
      autoplay: this.autoplay,
      loop: this.loop,
      volume: this.volume,
      bus: this.bus,
      pitchVariation: this.pitchVariation,
      volumeVariation: this.volumeVariation,
    };
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = NodeBase.getPropertySchema();

    return {
      nodeType: 'AudioPlayer',
      extends: 'NodeBase',
      properties: [
        ...baseSchema.properties,
        {
          name: 'audioTrack',
          type: 'string',
          ui: {
            label: 'Audio Track',
            description: 'Asset URL (res://..., data:audio/..., or absolute URL)',
            group: 'Audio',
            editor: 'audio-resource',
          },
          getValue: node => (node as AudioPlayer).audioTrack ?? '',
          setValue: (node, value) => {
            (node as AudioPlayer).audioTrack = AudioPlayer.normalizeTrack(value);
          },
        },
        {
          name: 'autoplay',
          type: 'boolean',
          ui: {
            label: 'Autoplay',
            group: 'Audio',
          },
          getValue: node => (node as AudioPlayer).autoplay,
          setValue: (node, value) => {
            const audioPlayer = node as AudioPlayer;
            audioPlayer.autoplay = AudioPlayer.toBoolean(value, false);
            if (!audioPlayer.autoplay) {
              audioPlayer.autoPlayed = false;
            }
          },
        },
        {
          name: 'loop',
          type: 'boolean',
          ui: {
            label: 'Loop',
            group: 'Audio',
          },
          getValue: node => (node as AudioPlayer).loop,
          setValue: (node, value) => {
            (node as AudioPlayer).loop = AudioPlayer.toBoolean(value, false);
          },
        },
        {
          name: 'volume',
          type: 'number',
          ui: {
            label: 'Volume',
            group: 'Audio',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
          },
          getValue: node => (node as AudioPlayer).volume,
          setValue: (node, value) => {
            (node as AudioPlayer).volume = AudioPlayer.clampVolume(value, 1);
          },
        },
        {
          name: 'bus',
          type: 'enum',
          ui: {
            label: 'Bus',
            group: 'Audio',
            options: [...AUDIO_BUS_NAMES],
          },
          getValue: node => (node as AudioPlayer).bus,
          setValue: (node, value) => {
            (node as AudioPlayer).bus = AudioPlayer.normalizeBus(value);
          },
        },
        {
          name: 'pitchVariation',
          type: 'number',
          ui: {
            label: 'Pitch Variation',
            description: 'Random ± playback-rate spread per shot',
            group: 'Audio',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
          },
          getValue: node => (node as AudioPlayer).pitchVariation,
          setValue: (node, value) => {
            (node as AudioPlayer).pitchVariation = AudioPlayer.clampVariation(value);
          },
        },
        {
          name: 'volumeVariation',
          type: 'number',
          ui: {
            label: 'Volume Variation',
            description: 'Random ± volume spread per shot',
            group: 'Audio',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
          },
          getValue: node => (node as AudioPlayer).volumeVariation,
          setValue: (node, value) => {
            (node as AudioPlayer).volumeVariation = AudioPlayer.clampVariation(value);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Audio: {
          label: 'Audio',
          expanded: true,
        },
      },
    };
  }

  private static normalizeTrack(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private static toBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
    }

    return fallback;
  }

  private static clampVolume(value: unknown, fallback: number): number {
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }

    return Math.min(1, Math.max(0, numberValue));
  }

  private static normalizeBus(value: unknown): AudioBusName {
    return typeof value === 'string' && (AUDIO_BUS_NAMES as readonly string[]).includes(value)
      ? (value as AudioBusName)
      : 'sfx';
  }

  private static clampVariation(value: unknown): number {
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue)) {
      return 0;
    }

    return Math.min(1, Math.max(0, numberValue));
  }
}
