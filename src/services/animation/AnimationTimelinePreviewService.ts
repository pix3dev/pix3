/**
 * AnimationTimelinePreviewService — design-time preview for keyframe clips.
 *
 * Applies sampled clip values directly to live scene nodes for scrubbing and
 * editor playback WITHOUT dirtying the scene, touching undo history, or
 * bumping `nodeDataChangeSignal`. Original property values are snapshotted
 * when a preview session starts and restored when it ends (mirroring the
 * play-mode capture/restore in ScriptExecutionService, generalized to any
 * schema property).
 *
 * Guards (via OperationService events, which fire synchronously around each
 * operation):
 * - scene saves (`scene.save*`): preview values are restored before the
 *   operation serializes the graph and re-applied afterwards.
 * - our own clips operation: the session refreshes its bindings/snapshot so
 *   editing keys while parked on the playhead keeps the preview alive.
 * - any other mutating operation, undo, or redo: the session ends and the
 *   authored state is restored (this includes play-mode start, whose
 *   `scripts.set-play-mode` operation completes before GamePlaySessionService
 *   reacts to the state change and serializes the scene).
 */

import { inject, injectable } from '@/fw/di';
import {
  applyClipAtTime,
  collectAudioKeysInRange,
  collectEventKeysInRange,
  createClipBindings,
  fireEventKey,
  findKeyframeClip,
  normalizeKeyframeAnimationSet,
  AssetLoader,
  AudioService,
  Node2D,
  SceneManager,
  type AudioPlayback,
  type ClipBinding,
  type KeyframeClip,
  type NodeBase,
  type PropertyDefinition,
  type ScriptComponent,
} from '@pix3/runtime';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { OperationService, type OperationEvent } from '@/services/core/OperationService';
import { UPDATE_ANIMATION_CLIPS_OPERATION_ID } from '@/features/animation-timeline/UpdateAnimationPlayerClipsOperation';

const SAVE_OPERATION_IDS = new Set(['scene.save', 'scene.save-as', 'scene.save-as-prefab']);
const ALLOWED_OPERATION_IDS = new Set([UPDATE_ANIMATION_CLIPS_OPERATION_ID, 'scene.select-object']);
const REFLOW_2D_PROPERTIES = new Set([
  'layoutEnabled',
  'horizontalAlign',
  'verticalAlign',
  'width',
  'height',
  'size',
  'radius',
  'resolutionPreset',
]);

interface SnapshotEntry {
  node: NodeBase;
  propDef: PropertyDefinition;
  property: string;
  value: unknown;
}

interface PreviewSession {
  nodeId: string;
  componentId: string;
  clipName: string;
  host: NodeBase;
  component: ScriptComponent;
  binding: ClipBinding;
  /** Keyed by `${node.nodeId}:${property}`. */
  snapshot: Map<string, SnapshotEntry>;
  time: number;
}

export type AnimationPreviewListener = () => void;

@injectable()
export class AnimationTimelinePreviewService {
  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(ViewportRendererService)
  private readonly viewport!: ViewportRendererService;

  @inject(AssetLoader)
  private readonly assetLoader!: AssetLoader;

  @inject(AudioService)
  private readonly audioService!: AudioService;

  @inject(OperationService)
  private readonly operations!: OperationService;

  private session: PreviewSession | null = null;
  private playing = false;
  private rafHandle: number | null = null;
  private lastFrameTs: number | null = null;
  private suspendedForSave = false;
  private readonly listeners = new Set<AnimationPreviewListener>();
  private readonly audioHandles = new Set<AudioPlayback>();
  private disposeOperationListener: (() => void) | null = null;

  get isActive(): boolean {
    return this.session !== null;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get time(): number {
    return this.session?.time ?? 0;
  }

  get missingTargets(): string[] {
    return this.session?.binding.missingTargets ?? [];
  }

  subscribe(listener: AnimationPreviewListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Start (or retarget) a preview session for the given player component and
   * clip. Returns false when the component or clip cannot be resolved.
   */
  begin(nodeId: string, componentId: string, clipName: string): boolean {
    if (
      this.session &&
      this.session.nodeId === nodeId &&
      this.session.componentId === componentId &&
      this.session.clipName === clipName
    ) {
      return true;
    }

    const resolved = this.resolve(nodeId, componentId, clipName);
    if (!resolved) {
      return false;
    }

    const previousTime = this.stopAndRestoreInternal();
    const snapshot = new Map<string, SnapshotEntry>();
    this.captureSnapshot(resolved.binding, snapshot);

    this.session = {
      nodeId,
      componentId,
      clipName,
      host: resolved.host,
      component: resolved.component,
      binding: resolved.binding,
      snapshot,
      time: Math.min(previousTime ?? 0, resolved.binding.clip.duration),
    };
    this.ensureOperationListener();
    this.warmUpAudio(resolved.binding.clip);
    this.emit();
    return true;
  }

  /** Move the playhead and apply the sampled pose to the live nodes. */
  setTime(time: number): void {
    const session = this.session;
    if (!session) {
      return;
    }
    session.time = Math.min(Math.max(0, time), session.binding.clip.duration);
    this.applyAtCurrentTime();
    this.emit();
  }

  play(): void {
    const session = this.session;
    if (!session || this.playing) {
      return;
    }
    if (session.time >= session.binding.clip.duration) {
      session.time = 0;
    }
    this.playing = true;
    this.lastFrameTs = null;
    this.fireTimeWindow(session.time, session.time, true);
    this.rafHandle = requestAnimationFrame(this.onAnimationFrame);
    this.emit();
  }

  pause(): void {
    if (!this.playing) {
      return;
    }
    this.playing = false;
    this.cancelFrame();
    this.stopAudioPlayback();
    this.emit();
  }

  /** End the session and restore all snapshotted property values. */
  stopAndRestore(): void {
    if (!this.session) {
      return;
    }
    this.stopAndRestoreInternal();
    this.emit();
  }

  /**
   * Re-resolve bindings against the current component config (after clip
   * edits or structural scene changes) and re-apply the current time.
   * Ends the session when the component or clip no longer exists.
   */
  refreshSession(): void {
    const session = this.session;
    if (!session) {
      return;
    }

    const resolved = this.resolve(session.nodeId, session.componentId, session.clipName);
    if (!resolved) {
      this.stopAndRestore();
      return;
    }

    session.host = resolved.host;
    session.component = resolved.component;
    session.binding = resolved.binding;
    session.time = Math.min(session.time, resolved.binding.clip.duration);
    // Snapshot properties that were not part of the session yet (new tracks).
    this.captureSnapshot(resolved.binding, session.snapshot);
    this.applyAtCurrentTime();
    this.emit();
  }

  dispose(): void {
    this.stopAndRestoreInternal();
    this.disposeOperationListener?.();
    this.disposeOperationListener = null;
    this.listeners.clear();
  }

  private resolve(
    nodeId: string,
    componentId: string,
    clipName: string
  ): { host: NodeBase; component: ScriptComponent; binding: ClipBinding } | null {
    const graph = this.sceneManager.getActiveSceneGraph();
    const host = graph?.nodeMap.get(nodeId);
    if (!host) {
      return null;
    }
    const component = host.components.find(c => c.id === componentId);
    if (!component) {
      return null;
    }
    const set = normalizeKeyframeAnimationSet(component.config.animations);
    const clip = findKeyframeClip(set, clipName);
    if (!clip) {
      return null;
    }
    return { host, component, binding: createClipBindings(host, clip) };
  }

  private captureSnapshot(binding: ClipBinding, snapshot: Map<string, SnapshotEntry>): void {
    for (const entry of binding.entries) {
      const key = `${entry.node.nodeId}:${entry.track.property}`;
      if (snapshot.has(key)) {
        continue;
      }
      snapshot.set(key, {
        node: entry.node,
        propDef: entry.propDef,
        property: entry.track.property,
        value: structuredClone(entry.propDef.getValue(entry.node)),
      });
    }
  }

  /** Returns the session time before it was cleared (for retargeting). */
  private stopAndRestoreInternal(): number | null {
    const session = this.session;
    if (!session) {
      return null;
    }
    this.playing = false;
    this.cancelFrame();
    this.stopAudioPlayback();
    this.restoreSnapshotValues();
    this.session = null;
    this.suspendedForSave = false;
    return session.time;
  }

  private restoreSnapshotValues(): void {
    const session = this.session;
    if (!session) {
      return;
    }
    for (const entry of session.snapshot.values()) {
      try {
        entry.propDef.setValue(entry.node, structuredClone(entry.value));
      } catch (error) {
        console.warn('[AnimationTimelinePreview] Failed to restore property', {
          nodeId: entry.node.nodeId,
          property: entry.property,
          error,
        });
      }
    }
    this.refreshViewport(session);
  }

  private applyAtCurrentTime(): void {
    const session = this.session;
    if (!session || this.suspendedForSave) {
      return;
    }
    applyClipAtTime(session.binding, session.time);
    this.refreshViewport(session);
  }

  private refreshViewport(session: PreviewSession): void {
    try {
      let needsReflow = false;
      const touchedNodes = new Set<NodeBase>();
      for (const entry of session.binding.entries) {
        touchedNodes.add(entry.node);
        if (REFLOW_2D_PROPERTIES.has(entry.track.property) && entry.node instanceof Node2D) {
          needsReflow = true;
        }
      }
      // Include snapshotted nodes so restore refreshes removed tracks too.
      for (const entry of session.snapshot.values()) {
        touchedNodes.add(entry.node);
      }

      if (needsReflow) {
        this.viewport.reflow2DLayout();
      }
      for (const node of touchedNodes) {
        this.viewport.updateNodeTransform(node);
      }
      this.viewport.requestRender();
    } catch {
      // Viewport may not be initialized in headless contexts.
    }
  }

  private readonly onAnimationFrame = (ts: number): void => {
    if (!this.playing || !this.session) {
      return;
    }

    const session = this.session;
    const clip = session.binding.clip;
    const dt = this.lastFrameTs === null ? 0 : (ts - this.lastFrameTs) / 1000;
    this.lastFrameTs = ts;

    const speed = this.getComponentSpeed(session.component);
    const prev = session.time;
    let next = prev + dt * speed;

    if (next >= clip.duration) {
      if (clip.loop && clip.duration > 0) {
        next = next % clip.duration;
        this.fireTimeWindow(prev, clip.duration, false);
        this.fireTimeWindow(0, next, true);
      } else {
        next = clip.duration;
        this.fireTimeWindow(prev, next, false);
        session.time = next;
        this.applyAtCurrentTime();
        this.playing = false;
        this.cancelFrame();
        this.emit();
        return;
      }
    } else {
      this.fireTimeWindow(prev, next, false);
    }

    session.time = next;
    this.applyAtCurrentTime();
    this.emit();
    this.rafHandle = requestAnimationFrame(this.onAnimationFrame);
  };

  private getComponentSpeed(component: ScriptComponent): number {
    const value = component.config.speed;
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) && num >= 0 ? num : 1;
  }

  /**
   * Fire time-window keys (audio + events) crossed while scrubbing/playing the
   * preview from `from` to `to`. Event signals are emitted on the resolved
   * nodes; during design-time preview no game scripts are connected, so this is
   * typically a no-op, but it keeps preview timing WYSIWYG with play mode.
   */
  private fireTimeWindow(from: number, to: number, includeStart: boolean): void {
    const session = this.session;
    if (!session) {
      return;
    }
    for (const track of session.binding.audioTracks) {
      const keys = collectAudioKeysInRange(track, from, to, {
        wrapDuration: session.binding.clip.duration,
        includeStart,
      });
      for (const key of keys) {
        void this.playAudio(key.audioPath, key.volume);
      }
    }
    for (const entry of session.binding.eventEntries) {
      const keys = collectEventKeysInRange(entry.track, from, to, {
        wrapDuration: session.binding.clip.duration,
        includeStart,
      });
      for (const key of keys) {
        try {
          fireEventKey(entry.node, key);
        } catch (error) {
          console.warn('[AnimationTimelinePreview] Event listener failed', {
            signal: key.signal,
            error,
          });
        }
      }
    }
  }

  private async playAudio(path: string, volume: number): Promise<void> {
    try {
      const buffer = await this.assetLoader.loadAudio(path);
      if (!this.playing) {
        return;
      }
      const playback = this.audioService.play(buffer, { resourcePath: path, volume });
      this.audioHandles.add(playback);
      void playback.ended.finally(() => {
        this.audioHandles.delete(playback);
      });
    } catch (error) {
      console.warn(`[AnimationTimelinePreview] Failed to play audio "${path}":`, error);
    }
  }

  private stopAudioPlayback(): void {
    for (const playback of this.audioHandles) {
      try {
        playback.stop();
      } catch {
        // ignore
      }
    }
    this.audioHandles.clear();
  }

  private warmUpAudio(clip: KeyframeClip): void {
    for (const track of clip.tracks) {
      if (track.kind !== 'audio') {
        continue;
      }
      for (const key of track.keys) {
        if (key.audioPath.length > 0) {
          void this.assetLoader.loadAudio(key.audioPath).catch(() => undefined);
        }
      }
    }
  }

  private cancelFrame(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.lastFrameTs = null;
  }

  private ensureOperationListener(): void {
    if (this.disposeOperationListener) {
      return;
    }
    this.disposeOperationListener = this.operations.addListener(this.onOperationEvent);
  }

  private readonly onOperationEvent = (event: OperationEvent): void => {
    if (!this.session) {
      return;
    }

    // React on `invoked` (which fires BEFORE the operation performs) rather
    // than `completed` for user mutations. Restoring the authored pose before
    // the edit runs means a manual change (e.g. moving the node with the gizmo)
    // lands on the authored baseline instead of being clobbered by a late
    // restore — and its undo records the authored value, not the preview
    // sample. Our own clip edits and selection keep the session alive.
    if (event.type === 'operation:invoked') {
      // Scene saves serialize the live graph: restore authored values before
      // the save performs, re-apply the preview pose afterwards.
      if (SAVE_OPERATION_IDS.has(event.metadata.id)) {
        this.restoreSnapshotValues();
        this.suspendedForSave = true;
        return;
      }
      if (
        event.metadata.id === UPDATE_ANIMATION_CLIPS_OPERATION_ID ||
        ALLOWED_OPERATION_IDS.has(event.metadata.id)
      ) {
        return;
      }
      // Any other mutation (including play-mode start) invalidates the preview.
      this.stopAndRestore();
      return;
    }

    if (event.type === 'operation:completed') {
      if (SAVE_OPERATION_IDS.has(event.metadata.id)) {
        if (this.suspendedForSave) {
          this.suspendedForSave = false;
          this.applyAtCurrentTime();
        }
        return;
      }
      // Re-resolve bindings after our own clip edits so scrubbing stays live
      // while keys are added/moved (including autokey recording).
      if (event.didMutate && event.metadata.id === UPDATE_ANIMATION_CLIPS_OPERATION_ID) {
        this.refreshSession();
      }
      return;
    }

    if (event.type === 'operation:undone' || event.type === 'operation:redone') {
      this.stopAndRestore();
    }
  };

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('[AnimationTimelinePreview] Listener failed', error);
      }
    }
  }
}
