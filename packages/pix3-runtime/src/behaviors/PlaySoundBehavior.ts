import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';

export class PlaySoundBehavior extends Script {
  private readonly onNodeSignal = (): void => {
    void this.playConfiguredSound();
  };

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      audioTrack: '',
      triggerEvent: 'pointerdown',
      volume: 1,
      loop: false,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'PlaySoundBehavior',
      properties: [
        {
          name: 'audioTrack',
          type: 'string',
          ui: {
            label: 'Audio Track',
            description: 'Asset URL (res://..., data:audio/..., or absolute URL)',
            group: 'Audio',
            editor: 'audio-resource',
          },
          getValue: component => (component as PlaySoundBehavior).getAudioTrack(),
          setValue: (component, value) => {
            (component as PlaySoundBehavior).setAudioTrack(value);
          },
        },
        {
          name: 'triggerEvent',
          type: 'string',
          ui: {
            label: 'Trigger Event',
            description: 'Node signal or UI event (pointerdown, pointerup, click)',
            group: 'Audio',
          },
          getValue: component => (component as PlaySoundBehavior).getTriggerEvent(),
          setValue: (component, value) => {
            (component as PlaySoundBehavior).setTriggerEvent(value);
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
          getValue: component => (component as PlaySoundBehavior).getVolume(),
          setValue: (component, value) => {
            (component as PlaySoundBehavior).setVolume(value);
          },
        },
        {
          name: 'loop',
          type: 'boolean',
          ui: {
            label: 'Loop',
            group: 'Audio',
          },
          getValue: component => (component as PlaySoundBehavior).getLoop(),
          setValue: (component, value) => {
            (component as PlaySoundBehavior).setLoop(value);
          },
        },
      ],
      groups: {
        Audio: {
          label: 'Audio',
          expanded: true,
        },
      },
    };
  }

  onStart(): void {
    this.bindTrigger();
  }

  override onDetach(): void {
    this.unbindTrigger();
    super.onDetach();
  }

  private bindTrigger(): void {
    if (!this.node) {
      return;
    }

    const trigger = this.getTriggerEvent();
    this.node.connect(trigger, this, this.onNodeSignal);
  }

  private unbindTrigger(): void {
    if (!this.node) {
      return;
    }

    const trigger = this.getTriggerEvent();
    this.node.disconnect(trigger, this, this.onNodeSignal);
  }

  private async playConfiguredSound(): Promise<void> {
    const scene = this.scene;
    const node = this.node;
    if (!scene || !node) {
      return;
    }

    const track = this.getAudioTrack();
    if (!track) {
      console.warn('[PlaySoundBehavior] audioTrack is not configured.');
      return;
    }

    const assetLoader = scene.getAssetLoader();
    const audioService = scene.getAudioService();
    if (!assetLoader || !audioService) {
      console.warn('[PlaySoundBehavior] Audio services are not available in this runtime context.');
      return;
    }

    try {
      const buffer = await assetLoader.loadAudio(track);

      // Re-check scene and audio service after async load
      const currentAudioService = scene.getAudioService();
      if (!currentAudioService) {
        return;
      }
      const audioMetadata = assetLoader.getAudioMetadata(track);

      currentAudioService.play(buffer, {
        resourcePath: track,
        sizeBytes: audioMetadata?.sizeBytes,
        volume: this.getVolume(),
        loop: this.getLoop(),
      });
    } catch (error) {
      console.warn(`[PlaySoundBehavior] Failed to play "${track}" on node "${node.name}":`, error);
    }
  }

  private getAudioTrack(): string {
    return this.normalizeTrack(this.config.audioTrack);
  }

  private setAudioTrack(value: unknown): void {
    this.config.audioTrack = this.normalizeTrack(value);
  }

  private getTriggerEvent(): string {
    const value = this.config.triggerEvent;
    if (typeof value !== 'string') {
      return 'pointerdown';
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : 'pointerdown';
  }

  private setTriggerEvent(value: unknown): void {
    const wasBound = Boolean(this.node);
    if (wasBound) {
      this.unbindTrigger();
    }

    this.config.triggerEvent = this.toTrimmedString(value, 'pointerdown');

    if (wasBound) {
      this.bindTrigger();
    }
  }

  private getVolume(): number {
    return this.toVolume(this.config.volume, 1);
  }

  private setVolume(value: unknown): void {
    this.config.volume = this.toVolume(value, 1);
  }

  private getLoop(): boolean {
    return this.toBoolean(this.config.loop, false);
  }

  private setLoop(value: unknown): void {
    this.config.loop = this.toBoolean(value, false);
  }

  private normalizeTrack(value: unknown): string {
    return this.toTrimmedString(value, '');
  }

  private toTrimmedString(value: unknown, fallback: string): string {
    if (typeof value !== 'string') {
      return fallback;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : fallback;
  }

  private toBoolean(value: unknown, fallback: boolean): boolean {
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

  private toVolume(value: unknown, fallback: number): number {
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }
    return Math.min(1, Math.max(0, numberValue));
  }
}
