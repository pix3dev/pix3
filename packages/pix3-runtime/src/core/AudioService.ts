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
  /**
   * Bumped whenever the active-playback set changes (a playback starts, ends or
   * is stopped). `SceneRunner` compares it frame to frame to decide whether
   * {@link getActivePlaybackSnapshot} — which copies and sorts every entry —
   * needs to run at all; in steady state (music looping, no new SFX) it does
   * not, and the frame sample reuses the previous list by reference.
   */
  private activePlaybackRevision = 0;
  /**
   * Whether audio *should* be audible right now — i.e. the page is visible and focused.
   *
   * Intent, not observation: {@link reconcileContextState} drives the context towards it. Keeping
   * the two apart is what makes the focus handling survive the asynchrony of `suspend()`/`resume()`.
   */
  private wantsAudible = true;
  /** Page-activity half of {@link wantsAudible}: the document is visible and focused. */
  private pageActive = true;
  /**
   * Host-pause half of {@link wantsAudible}. A paused game must go quiet even though its window is
   * still focused — a frozen scene over continuing music reads as a hang, not a pause. Suspending
   * the context (rather than stopping playbacks) is what makes resume seamless: every buffer picks
   * up where the pause caught it.
   */
  private pausedByHost = false;
  /** Whether the browser has ever permitted this context to run (autoplay unlock has happened). */
  private unlockedByGesture = false;
  private readonly unlockFromPointerDown = (): void => {
    this.unlock();
  };
  private readonly unlockFromKeydown = (): void => {
    this.unlock();
  };
  private readonly handleContextStateChange = (): void => {
    this.reconcileContextState();
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

    // iOS Safari / Web Audio requirement: context must be resumed by user interaction.
    // Deliberately NOT `{ once: true }`: `resume()` can reject (the gesture was not one the browser
    // counts, the context was still being constructed), and a one-shot listener spends the only
    // retry the service has on that failure. `unlock()` is idempotent and costs nothing per event.
    window.addEventListener('pointerdown', this.unlockFromPointerDown);
    window.addEventListener('keydown', this.unlockFromKeydown);

    // Auto-mute on focus loss
    window.addEventListener('blur', this.handleActivityChange);
    window.addEventListener('focus', this.handleActivityChange);
    window.addEventListener('pageshow', this.handleActivityChange);
    window.addEventListener('pagehide', this.handleActivityChange);
    document.addEventListener('visibilitychange', this.handleActivityChange);
    // The reconciler's feedback edge: every completed suspend/resume re-runs it, so a transition
    // that landed after the intent behind it had already changed is corrected instead of sticking.
    this.context.addEventListener?.('statechange', this.handleContextStateChange);
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
    entry.input.gain.setTargetAtTime(
      entry.userVolume * scale,
      this.context.currentTime,
      timeConstantSec
    );
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
    this.pageActive = isVisible && hasFocus;
    this.updateWantsAudible();
  };

  /**
   * Silence (or un-silence) the mixer because the host paused the game. Idempotent, and orthogonal
   * to the focus rule: whichever of the two wants silence gets it, and audio only comes back when
   * both are happy. Driven by {@link SceneRunner.pause}/`resume`.
   */
  setPaused(paused: boolean): void {
    if (this.pausedByHost === paused) {
      return;
    }
    this.pausedByHost = paused;
    this.updateWantsAudible();
  }

  private updateWantsAudible(): void {
    this.wantsAudible = this.pageActive && !this.pausedByHost;
    this.reconcileContextState();
  }

  /**
   * Drive the context towards {@link wantsAudible}.
   *
   * Deliberately a *reconciler* rather than a transition handler, and idempotent, because
   * `suspend()` / `resume()` are asynchronous: `state` does not flip when the call is made, it flips
   * when the operation lands. The previous version decided what to do from `state` at the moment an
   * event arrived and recorded the verdict in a `suspendedByFocusLoss` flag, which deadlocks on a
   * fast blur→focus: `focus` sees a context still reading `'running'` (the `suspend()` from `blur`
   * is in flight), so it neither resumes nor clears the flag — and then the flag it left set is the
   * very thing that made `unlock()` refuse to resume, so no amount of clicking recovered it. The
   * game stayed silent while everything still reported itself as playing.
   *
   * Reading intent instead of history makes the fast path a no-op and the slow path self-healing:
   * whatever the state turns out to be, this is re-run on every `statechange` until it matches.
   */
  private reconcileContextState(): void {
    const context = this.context;
    if (!context) {
      return;
    }

    // A running context is proof the browser has let us out of autoplay jail — whether that came
    // from a gesture, or because the context was constructed after one and started running. Latching
    // it here (not only in `unlock`) is what lets focus loss suspend/resume a context nobody ever
    // had to click to start.
    if (context.state === 'running') {
      this.unlockedByGesture = true;
    }

    if (!this.wantsAudible) {
      if (context.state === 'running') {
        void context.suspend().catch(() => {
          // A context closed underneath us is not an error worth surfacing.
        });
      }
      return;
    }

    // Only resume a context the browser has already let us out of autoplay jail for. Before the
    // first gesture `resume()` rejects, and retrying it on every focus event would spam the console.
    if (context.state === 'suspended' && this.unlockedByGesture) {
      void context.resume().catch(err => {
        console.warn('[AudioService] Failed to resume AudioContext:', err);
      });
    }
  }

  /**
   * Resume after a user gesture (the Web Audio autoplay unlock).
   *
   * Also the point where {@link unlockedByGesture} latches: from here on the reconciler is allowed
   * to resume on its own, so a context suspended by focus loss comes back without a click.
   */
  unlock(): void {
    if (!this.context) {
      return;
    }

    this.unlockedByGesture = true;
    this.reconcileContextState();
  }

  /**
   * Stops all active playbacks.
   */
  stopAll(): void {
    const playbacks = Array.from(this.activePlaybacks);
    this.activePlaybacks.clear();
    this.activePlaybackEntries.clear();
    this.activePlaybackRevision++;
    for (const playback of playbacks) {
      try {
        playback.stop();
      } catch {
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

    // Only worth warning about when we are not the ones holding the context down: a page the user
    // has tabbed away from is *supposed* to be silent, and a game that keeps firing SFX there would
    // otherwise flood the console.
    if (this.context.state === 'suspended' && this.wantsAudible) {
      console.warn(
        '[AudioService] Attempting to play audio while context is suspended. It might not be audible until user interaction.'
      );
    }

    // One-shots fired while the page is away are dropped rather than queued.
    //
    // Every playback this service tracks is cleaned up by `source.onended`, and a suspended context
    // has a frozen `currentTime` — so nothing started against it ever ends. A game that keeps
    // running while the user is in another window (the default: `pauseRenderingOnUnfocus` is a
    // setting, not a guarantee) therefore piles up an unbounded number of live source/gain nodes,
    // all still wired into the bus graph, plus their diagnostics entries — and on resume they would
    // all fire at once, replaying every explosion the player missed as a single blast.
    //
    // Loops are exempt: music and ambience are meant to still be there on return, and there is a
    // bounded number of them.
    const isLoop = options?.loop ?? false;
    if (!isLoop && !this.wantsAudible && this.context.state !== 'running') {
      return {
        stop: () => {
          // Nothing was started.
        },
        // Resolved, not pending — a script awaiting `ended` to sequence the next step must not hang
        // just because the window lost focus.
        ended: Promise.resolve(),
      };
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = isLoop;

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
    const ended = new Promise<void>(resolve => {
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
      this.activePlaybackRevision++;
      source.disconnect();
      gainNode.disconnect();
      pannerNode?.disconnect();
      resolveEnded();
    };

    const playback: AudioPlayback = {
      stop: () => {
        try {
          source.stop();
        } catch {
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
    this.activePlaybackRevision++;
    source.start();

    return playback;
  }

  /** Monotonic count of active-playback set changes; see {@link activePlaybackRevision}. */
  getActivePlaybackRevision(): number {
    return this.activePlaybackRevision;
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

  /**
   * Output sample rate, or null when Web Audio is unavailable. Together with
   * {@link createBuffer} this is the whole surface procedural audio needs (see
   * {@link ./SfxSynth}) — no caller has to reach for the raw AudioContext.
   */
  getSampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }

  /**
   * Allocate an empty buffer at the output sample rate for callers that synthesize
   * their own samples. Null (never a throw) when Web Audio is unavailable, which is
   * what makes procedural SFX a silent no-op in headless runs and tests.
   */
  createBuffer(lengthSamples: number, channels = 1): AudioBuffer | null {
    if (!this.context) {
      return null;
    }
    try {
      return this.context.createBuffer(
        Math.max(1, Math.floor(channels)),
        Math.max(1, Math.floor(lengthSamples)),
        this.context.sampleRate
      );
    } catch (error) {
      console.warn('[AudioService] Failed to allocate an AudioBuffer:', error);
      return null;
    }
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
    this.context?.removeEventListener?.('statechange', this.handleContextStateChange);

    this.stopAll();
    void this.context?.close();
    this.context = null;
    this.buses.clear();
    this.wantsAudible = true;
    this.pageActive = true;
    this.pausedByHost = false;
    this.unlockedByGesture = false;
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
    return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
  }

  private normalizePositiveNumber(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return null;
    }

    return value;
  }

  private computeBitrateKbps(
    durationSeconds: number | null,
    sizeBytes: number | undefined
  ): number | null {
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
