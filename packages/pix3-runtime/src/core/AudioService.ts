export interface AudioPlayback {
  stop: () => void;
  ended: Promise<void>;
}

export interface ActiveAudioPlaybackSnapshot {
  readonly id: string;
  readonly label: string;
  readonly resourcePath: string | null;
  readonly startedAtMs: number;
  readonly elapsedMs: number;
  readonly loop: boolean;
  readonly volume: number;
  readonly playbackRate: number;
  readonly pan: number | null;
  readonly durationSeconds: number | null;
  readonly channelCount: number | null;
  readonly sampleRate: number | null;
  readonly bitrateKbps: number | null;
}

export interface PlayAudioOptions {
  label?: string;
  resourcePath?: string;
  sizeBytes?: number;
  volume?: number;
  loop?: boolean;
  playbackRate?: number;
  pan?: number;
}

type ActiveAudioPlaybackEntry = Omit<ActiveAudioPlaybackSnapshot, 'elapsedMs'>;

type WebkitAudioContextCtor = new () => AudioContext;

interface WindowWithWebkitAudioContext extends Window {
  webkitAudioContext?: WebkitAudioContextCtor;
}

export class AudioService {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private readonly activePlaybacks = new Set<AudioPlayback>();
  private readonly activePlaybackEntries = new Map<AudioPlayback, ActiveAudioPlaybackEntry>();
  private nextPlaybackId = 0;
  private suspendedByFocusLoss = false;
  private readonly unlockFromPointerDown = (): void => {
    this.unlock();
  };
  private readonly unlockFromKeydown = (): void => {
    this.unlock();
  };

  constructor() {
    const audioWindow = window as WindowWithWebkitAudioContext;
    const AudioContextCtor: typeof AudioContext | WebkitAudioContextCtor | undefined =
      window.AudioContext ?? audioWindow.webkitAudioContext;

    if (!AudioContextCtor) {
      console.warn('[AudioService] Web Audio API is not supported in this environment.');
      return;
    }

    try {
      this.context = new AudioContextCtor();
      this.masterGain = this.context.createGain();
      this.masterGain.connect(this.context.destination);
    } catch (error) {
      this.context = null;
      this.masterGain = null;
      console.warn('[AudioService] Failed to initialize AudioContext:', error);
      return;
    }

    // iOS Safari / Web Audio requirement: context must be resumed by user interaction
    window.addEventListener('pointerdown', this.unlockFromPointerDown, { once: true });
    window.addEventListener('keydown', this.unlockFromKeydown, { once: true });

    // Auto-mute on focus loss
    window.addEventListener('blur', this.handleActivityChange);
    window.addEventListener('focus', this.handleActivityChange);
    window.addEventListener('pageshow', this.handleActivityChange);
    window.addEventListener('pagehide', this.handleActivityChange);
    document.addEventListener('visibilitychange', this.handleActivityChange);
    this.handleActivityChange();
  }

  setVolume(value: number): void {
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(value, this.context?.currentTime ?? 0, 0.01);
    }
  }

  mute(): void {
    this.setVolume(0);
  }

  unmute(): void {
    this.setVolume(1);
  }

  private handleActivityChange = (): void => {
    const isVisible = document.visibilityState === 'visible';
    const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    const isActive = isVisible && hasFocus;

    if (!isActive) {
      if (this.context?.state === 'running') {
        this.suspendedByFocusLoss = true;
        void this.context.suspend();
      }
      return;
    }

    if (this.suspendedByFocusLoss && this.context?.state === 'suspended') {
      this.suspendedByFocusLoss = false;
      void this.context.resume();
    }
  };

  unlock(): void {
    if (!this.context) {
      return;
    }

    if (this.context.state === 'suspended' && !this.suspendedByFocusLoss) {
      this.context.resume().catch(err => {
        console.warn('[AudioService] Failed to resume AudioContext:', err);
      });
    }
  }

  /**
   * Stops all active playbacks.
   */
  stopAll(): void {
    const playbacks = Array.from(this.activePlaybacks);
    this.activePlaybacks.clear();
    this.activePlaybackEntries.clear();
    for (const playback of playbacks) {
      try {
        playback.stop();
      } catch (err) {
        // Ignore
      }
    }
  }

  play(buffer: AudioBuffer, options?: PlayAudioOptions): AudioPlayback {
    if (!this.context || !this.masterGain) {
      console.warn('[AudioService] Cannot play audio: AudioContext is unavailable.');
      return {
        stop: () => {
          // no-op
        },
        ended: Promise.resolve(),
      };
    }

    if (this.context.state === 'suspended' && !this.suspendedByFocusLoss) {
      console.warn(
        '[AudioService] Attempting to play audio while context is suspended. It might not be audible until user interaction.'
      );
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = options?.loop ?? false;
    const playbackRate = Math.max(0.01, options?.playbackRate ?? 1);
    source.playbackRate.value = playbackRate;

    const gainNode = this.context.createGain();
    const volume = Math.max(0, options?.volume ?? 1.0);
    gainNode.gain.value = volume;

    let outputNode: AudioNode = gainNode;
    let pannerNode: StereoPannerNode | null = null;
    const pan = typeof options?.pan === 'number' ? Math.max(-1, Math.min(1, options.pan)) : null;
    if (pan !== null && typeof this.context.createStereoPanner === 'function') {
      pannerNode = this.context.createStereoPanner();
      pannerNode.pan.value = pan;
      gainNode.connect(pannerNode);
      outputNode = pannerNode;
    }

    source.connect(gainNode);
    outputNode.connect(this.masterGain);

    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });

    let finished = false;

    const finalize = (): void => {
      if (finished) {
        return;
      }

      finished = true;
      this.activePlaybacks.delete(playback);
      this.activePlaybackEntries.delete(playback);
      source.disconnect();
      gainNode.disconnect();
      pannerNode?.disconnect();
      resolveEnded();
    };

    const playback: AudioPlayback = {
      stop: () => {
        try {
          source.stop();
        } catch (err) {
          // Ignore errors if already stopped
        } finally {
          finalize();
        }
      },
      ended,
    };

    source.onended = finalize;

    const resourcePath = this.normalizeResourcePath(options?.resourcePath);
    const durationSeconds = this.normalizePositiveNumber(buffer.duration);
    const channelCount = this.normalizePositiveNumber(buffer.numberOfChannels);
    const sampleRate = this.normalizePositiveNumber(buffer.sampleRate);

    this.activePlaybacks.add(playback);
    this.activePlaybackEntries.set(playback, {
      id: this.createPlaybackId(),
      label: this.normalizePlaybackLabel(options?.label, resourcePath),
      resourcePath,
      startedAtMs: this.readNowMs(),
      loop: source.loop,
      volume,
      playbackRate,
      pan,
      durationSeconds,
      channelCount,
      sampleRate,
      bitrateKbps: this.computeBitrateKbps(durationSeconds, options?.sizeBytes),
    });
    source.start();

    return playback;
  }

  getActivePlaybackSnapshot(nowMs: number = this.readNowMs()): ActiveAudioPlaybackSnapshot[] {
    const snapshotTime = Number.isFinite(nowMs) ? nowMs : this.readNowMs();

    return [...this.activePlaybackEntries.values()]
      .map(entry => ({
        ...entry,
        elapsedMs: Math.max(0, snapshotTime - entry.startedAtMs),
      }))
      .sort(
        (left, right) =>
          right.startedAtMs - left.startedAtMs ||
          left.label.localeCompare(right.label) ||
          left.id.localeCompare(right.id)
      );
  }

  async decodeAudioData(audioData: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.context) {
      throw new Error('AudioContext is unavailable.');
    }

    return this.context.decodeAudioData(audioData);
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.unlockFromPointerDown);
    window.removeEventListener('keydown', this.unlockFromKeydown);
    window.removeEventListener('blur', this.handleActivityChange);
    window.removeEventListener('focus', this.handleActivityChange);
    window.removeEventListener('pageshow', this.handleActivityChange);
    window.removeEventListener('pagehide', this.handleActivityChange);
    document.removeEventListener('visibilitychange', this.handleActivityChange);

    this.stopAll();
    void this.context?.close();
    this.context = null;
    this.masterGain = null;
    this.suspendedByFocusLoss = false;
  }

  private createPlaybackId(): string {
    this.nextPlaybackId += 1;
    return `playback-${this.nextPlaybackId}`;
  }

  private normalizePlaybackLabel(value: string | undefined, resourcePath: string | null): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized.length > 0) {
      return normalized;
    }

    const resourceLabel = this.extractFileName(resourcePath);
    return resourceLabel ?? 'Unknown';
  }

  private normalizeResourcePath(value: string | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
  }

  private extractFileName(resourcePath: string | null): string | null {
    if (!resourcePath) {
      return null;
    }

    const sanitized = resourcePath.split(/[?#]/, 1)[0] ?? resourcePath;
    const parts = sanitized.split(/[\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] ?? null : null;
  }

  private normalizePositiveNumber(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return null;
    }

    return value;
  }

  private computeBitrateKbps(durationSeconds: number | null, sizeBytes: number | undefined): number | null {
    if (
      typeof durationSeconds !== 'number' ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      typeof sizeBytes !== 'number' ||
      !Number.isFinite(sizeBytes) ||
      sizeBytes <= 0
    ) {
      return null;
    }

    return (sizeBytes * 8) / durationSeconds / 1000;
  }

  private readNowMs(): number {
    const now = globalThis.performance?.now?.();
    return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  }
}
