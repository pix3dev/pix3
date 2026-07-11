export interface AudioPlayback {
  stop: () => void;
  ended: Promise<void>;
}

/** The three fixed mixer buses. `music`/`sfx` route into `master`. */
export type AudioBusName = 'master' | 'music' | 'sfx';
export const AUDIO_BUS_NAMES: readonly AudioBusName[] = ['master', 'music', 'sfx'];

export interface AudioSnapshot {
  name: string;
  /** Per-bus lowpass cutoff (Hz); omitted buses ramp to the open cutoff (20000). */
  lowpassHz?: Partial<Record<AudioBusName, number>>;
  /** Per-bus multiplier composed ON TOP of the user bus volume; omitted = 1. */
  volumeScale?: Partial<Record<AudioBusName, number>>;
}

interface AudioBus {
  /** Node other sources / buses connect INTO. */
  input: GainNode;
  /** Permanently-wired transparent lowpass; null only when unavailable (mock/legacy). */
  filter: BiquadFilterNode | null;
  /** Authoritative mixer volume (gain.value ramps lag behind, so we don't read it back). */
  userVolume: number;
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
  readonly bus: AudioBusName;
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
  /** Destination bus (default `'sfx'`). */
  bus?: AudioBusName;
  /** Random ± spread applied to playback rate per shot, 0..1 (default 0). */
  pitchVariation?: number;
  /** Random ± spread applied to volume per shot, 0..1 (default 0). */
  volumeVariation?: number;
}

function clamp01(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

type ActiveAudioPlaybackEntry = Omit<ActiveAudioPlaybackSnapshot, 'elapsedMs'>;

type WebkitAudioContextCtor = new () => AudioContext;

interface WindowWithWebkitAudioContext extends Window {
  webkitAudioContext?: WebkitAudioContextCtor;
}

export class AudioService {
  private static readonly LOWPASS_OPEN_HZ = 20000;

  private context: AudioContext | null = null;
  private readonly buses = new Map<AudioBusName, AudioBus>();
  private readonly snapshots = new Map<string, AudioSnapshot>();
  private activeSnapshotName = 'default';
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
      // Bus graph: sfx / music feed master's input; master's filter feeds the
      // output. Filters are permanently wired but transparent (20 kHz Butterworth
      // lowpass), so snapshots are pure AudioParam ramps with no graph rewiring.
      const master = this.createBus(this.context.destination);
      const music = this.createBus(master.input);
      const sfx = this.createBus(master.input);
      this.buses.set('master', master);
      this.buses.set('music', music);
      this.buses.set('sfx', sfx);
    } catch (error) {
      this.context = null;
      this.buses.clear();
      console.warn('[AudioService] Failed to initialize AudioContext:', error);
      return;
    }

    this.snapshots.set('default', { name: 'default' });
    this.snapshots.set('muffled', {
      name: 'muffled',
      lowpassHz: { master: 700 },
      volumeScale: { master: 0.85 },
    });

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

  /** Alias for the master bus volume — keeps {@link mute}/{@link unmute} working. */
  setVolume(value: number): void {
    this.setBusVolume('master', value, 0.03);
  }

  mute(): void {
    this.setVolume(0);
  }

  unmute(): void {
    this.setVolume(1);
  }

  // ── Bus mixer ─────────────────────────────────────────────────────────────

  /** Set the authored volume of a bus, ramping over ~`fadeSec` to avoid clicks. */
  setBusVolume(bus: AudioBusName, volume: number, fadeSec = 0.05): void {
    const entry = this.buses.get(bus);
    if (!entry || !this.context) {
      return;
    }
    entry.userVolume = Math.max(0, Number.isFinite(volume) ? volume : 1);
    this.applyBusGain(bus, Math.max(0.001, fadeSec / 3));
  }

  /** Authoritative user volume of a bus (not the ramping `gain.value`). */
  getBusVolume(bus: AudioBusName): number {
    return this.buses.get(bus)?.userVolume ?? 1;
  }

  /** Compose the active snapshot's per-bus scale on top of the user volume. */
  private applyBusGain(bus: AudioBusName, timeConstantSec: number): void {
    const entry = this.buses.get(bus);
    if (!entry || !this.context) {
      return;
    }
    const scale = this.snapshots.get(this.activeSnapshotName)?.volumeScale?.[bus] ?? 1;
    entry.input.gain.setTargetAtTime(entry.userVolume * scale, this.context.currentTime, timeConstantSec);
  }

  /**
   * Blend the mixer to a named snapshot (per-bus lowpass + volume scale). User
   * bus volumes compose with the snapshot, so leaving a snapshot restores the
   * authored mix. Unknown names warn and leave state unchanged.
   */
  applySnapshot(name: string, options?: { timeConstantSec?: number }): void {
    const snap = this.snapshots.get(name);
    if (!snap || !this.context) {
      if (!snap) {
        console.warn(`[AudioService] Unknown snapshot "${name}".`);
      }
      return;
    }
    this.activeSnapshotName = name;
    const tc = Math.max(0.001, options?.timeConstantSec ?? 0.08);
    for (const busName of AUDIO_BUS_NAMES) {
      this.applyBusGain(busName, tc);
      const filter = this.buses.get(busName)?.filter;
      filter?.frequency.setTargetAtTime(
        snap.lowpassHz?.[busName] ?? AudioService.LOWPASS_OPEN_HZ,
        this.context.currentTime,
        tc
      );
    }
  }

  /** Blend back to the transparent `'default'` snapshot. */
  resetSnapshot(options?: { timeConstantSec?: number }): void {
    this.applySnapshot('default', options);
  }

  /** Register (or replace) a named snapshot; user scripts can add their own. */
  registerSnapshot(snapshot: AudioSnapshot): void {
    if (!snapshot || typeof snapshot.name !== 'string' || snapshot.name.length === 0) {
      console.warn('[AudioService] registerSnapshot requires a non-empty name.');
      return;
    }
    this.snapshots.set(snapshot.name, snapshot);
  }

  getActiveSnapshotName(): string {
    return this.activeSnapshotName;
  }

  /** Reset all bus volumes to 1 and snap to `'default'` — called on scene stop. */
  resetBuses(): void {
    for (const busName of AUDIO_BUS_NAMES) {
      const entry = this.buses.get(busName);
      if (entry) {
        entry.userVolume = 1;
      }
    }
    this.applySnapshot('default', { timeConstantSec: 0.01 });
  }

  private createBus(target: AudioNode): AudioBus {
    const context = this.context!;
    const input = context.createGain();
    let filter: BiquadFilterNode | null = null;
    if (typeof context.createBiquadFilter === 'function') {
      filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = AudioService.LOWPASS_OPEN_HZ;
      filter.Q.value = 0.7071; // Butterworth — no resonance bump, inaudible when open
      input.connect(filter);
      filter.connect(target);
    } else {
      input.connect(target);
    }
    return { input, filter, userVolume: 1 };
  }

  private getBusInput(bus: AudioBusName | undefined): AudioNode {
    return this.buses.get(bus ?? 'sfx')?.input ?? this.buses.get('master')!.input;
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
    if (!this.context || this.buses.size === 0) {
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

    // Per-shot randomization: linear fraction spread, clamped to audible ranges.
    // random() is only sampled when a variation is set, so a zero spread stays
    // exactly deterministic (the diagnostics snapshot records the effective values).
    const pitchVariation = clamp01(options?.pitchVariation);
    const volumeVariation = clamp01(options?.volumeVariation);
    const pitchFactor = pitchVariation > 0 ? 1 + (Math.random() * 2 - 1) * pitchVariation : 1;
    const volumeFactor = volumeVariation > 0 ? 1 + (Math.random() * 2 - 1) * volumeVariation : 1;

    const playbackRate = Math.max(0.01, (options?.playbackRate ?? 1) * pitchFactor);
    source.playbackRate.value = playbackRate;

    const gainNode = this.context.createGain();
    const volume = Math.max(0, (options?.volume ?? 1.0) * volumeFactor);
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

    const bus = options?.bus ?? 'sfx';
    source.connect(gainNode);
    outputNode.connect(this.getBusInput(bus));

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
      bus,
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
    this.buses.clear();
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
