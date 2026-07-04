/**
 * Animation timeline panel (Godot-style bottom dock).
 *
 * Binds to the `core:AnimationPlayer` component of the selected node (or its
 * nearest ancestor) and edits its keyframe clips: tracks on the left, a
 * scrollable ruler/keyframe surface on the right, transport + clip management
 * in the toolbar. All persistent edits flow through
 * `UpdateAnimationPlayerClipsOperation`; scrub/playback preview goes through
 * `AnimationTimelinePreviewService` and never dirties the scene.
 *
 * Panel-local shortcuts use a local keydown listener (asset-generator
 * precedent) instead of global keybindings: Space = play/pause, Delete =
 * delete selected keys, arrows = nudge selection, Home/End = playhead.
 */

import { ComponentBase, customElement, html, inject, state, subscribe } from '@/fw';
import { appState } from '@/state';
import {
  EASING_NAMES,
  findKeyframeClip,
  fromSchemaValue,
  getNodePropertySchema,
  normalizeKeyframeAnimationSet,
  resolveTrackTarget,
  SceneManager,
  type AudioTrack,
  type ClipTrack,
  type KeyframeAnimationSet,
  type KeyframeClip,
  type KeyframeEasing,
  type KeyframeValue,
  type NodeBase,
  type PropertyDefinition,
  type PropertyTrack,
  type ScriptComponent,
  type TrackValueType,
} from '@pix3/runtime';
import { OperationService, type OperationEvent } from '@/services/OperationService';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { IconService } from '@/services/IconService';
import { AnimationTimelinePreviewService } from '@/services/AnimationTimelinePreviewService';
import {
  ANIMATION_PLAYER_COMPONENT_TYPE,
  UPDATE_ANIMATION_CLIPS_OPERATION_ID,
  UpdateAnimationPlayerClipsOperation,
} from '@/features/animation-timeline/UpdateAnimationPlayerClipsOperation';
import { AddAnimationPlayerToSelectionCommand } from '@/features/animation-timeline/AddAnimationPlayerToSelectionCommand';
import {
  addAudioTrack,
  addClip,
  addPropertyTrack,
  deleteClip,
  deleteKeys,
  duplicateClip,
  findTrack,
  moveKeys,
  removeTrack,
  renameClip,
  setClipDuration,
  setClipLoop,
  setKeyEasing,
  setKeyValue,
  setTrackEnabled,
  upsertAudioKey,
  upsertKey,
  KEY_TIME_EPSILON,
} from '@/features/animation-timeline/clip-edit-utils';
import {
  clampZoom,
  formatTime,
  getRulerTicks,
  pxPerSecond,
  snapTime,
  timeToX,
  xToTime,
} from './timeline-geometry';
import { DropdownPortal } from '@/ui/shared/dropdown-portal';
import { getDroppedAssetResourcePath, hasAssetDragData } from '@/ui/shared/asset-drag-drop';
import '@/ui/shared/pix3-panel';
import '@/ui/shared/pix3-toolbar';
import '@/ui/shared/pix3-toolbar-button';
import './animation-timeline-panel.ts.css';

const TRACK_LABEL_WIDTH = 260;
const SUPPORTED_TRACK_TYPES: Record<string, TrackValueType> = {
  number: 'number',
  boolean: 'boolean',
  string: 'string',
  vector2: 'vector2',
  vector3: 'vector3',
  euler: 'euler',
  color: 'color',
};
const EXCLUDED_PROPERTIES = new Set(['id', 'name', 'type', 'groups', 'locked', 'initiallyVisible']);
const SNAP_STEPS = [0.01, 0.05, 0.1, 0.25, 0.5];
const AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.wav'];

interface BoundPlayer {
  nodeId: string;
  nodeName: string;
  componentId: string;
}

interface KeyRef {
  trackId: string;
  time: number;
}

type OpenMenu =
  | { kind: 'key'; x: number; y: number; trackId: string; keyTime: number }
  | { kind: 'clip-actions'; anchorId: string }
  | { kind: 'add-track'; anchorId: string; stage: 'nodes' | 'props'; targetPath: string };

interface KeysDragState {
  pointerId: number;
  startClientX: number;
  previousSet: KeyframeAnimationSet;
  coalesceKey: string;
  /** Original key refs grouped by track, in selection order. */
  selection: KeyRef[];
  /** Time of the grabbed key (snapping anchor). */
  anchorTime: number;
  lastDelta: number;
  pendingDelta: number | null;
  commitInFlight: boolean;
  moved: boolean;
  /** The key was already the sole selection before this press (re-click). */
  reopenPopover: boolean;
  popoverTrackId: string;
  popoverKeyTime: number;
}

let dragSessionCounter = 0;

/** Value-equality for keyframe values, tolerant of float noise on numbers/vectors. */
function keyframeValuesDiffer(a: KeyframeValue, b: KeyframeValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return true;
    }
    return a.some((v, i) => Math.abs(Number(v) - Number(b[i])) > 1e-4);
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) > 1e-4;
  }
  return a !== b;
}

@customElement('pix3-animation-timeline-panel')
export class AnimationTimelinePanel extends ComponentBase {
  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(OperationService)
  private readonly operations!: OperationService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(IconService)
  private readonly iconService!: IconService;

  @inject(AnimationTimelinePreviewService)
  private readonly preview!: AnimationTimelinePreviewService;

  @state() private bound: BoundPlayer | null = null;
  @state() private animationSet: KeyframeAnimationSet | null = null;
  @state() private activeClipName: string | null = null;
  @state() private playhead = 0;
  @state() private zoom = 1;
  @state() private snapEnabled = true;
  @state() private snapStep = 0.1;
  @state() private selectedKeys: KeyRef[] = [];
  @state() private openMenu: OpenMenu | null = null;
  @state() private renameValue: string | null = null;
  @state() private previewPlaying = false;
  @state() private previewActive = false;
  @state() private hasSelection = false;
  @state() private hasScene = false;
  @state() private recording = false;

  private readonly portal = new DropdownPortal({ minWidth: '14rem' });
  private keysDrag: KeysDragState | null = null;
  private scrubPointerId: number | null = null;
  private disposers: Array<() => void> = [];
  /** Last-known live value per property track, for autokey diffing. */
  private recordBaseline = new Map<string, KeyframeValue>();
  private autokeyInFlight = false;

  private readonly onWindowPointerDown = (event: PointerEvent): void => {
    if (!this.openMenu) {
      return;
    }
    // Let trigger buttons toggle the menu from their own click handler.
    const target = event.target as Element;
    if (this.portal.contains(target) || target.closest?.('[data-atl-menu-trigger]')) {
      return;
    }
    this.openMenu = null;
  };

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.openMenu) {
      this.openMenu = null;
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.sync();
    this.disposers.push(subscribe(appState.selection, () => this.sync()));
    this.disposers.push(subscribe(appState.scenes, () => this.sync()));
    this.disposers.push(
      this.preview.subscribe(() => {
        this.previewPlaying = this.preview.isPlaying;
        this.previewActive = this.preview.isActive;
        if (this.preview.isActive) {
          this.playhead = this.preview.time;
        }
      })
    );
    this.disposers.push(this.operations.addListener(this.onAutokeyOperation));
    document.addEventListener('pointerdown', this.onWindowPointerDown, { capture: true });
    window.addEventListener('keydown', this.onWindowKeyDown);
  }

  disconnectedCallback(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
    document.removeEventListener('pointerdown', this.onWindowPointerDown, { capture: true });
    window.removeEventListener('keydown', this.onWindowKeyDown);
    this.portal.close();
    this.preview.stopAndRestore();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (!changed.has('openMenu')) {
      return;
    }
    // The menu element is a single stable node rendered (hidden) inside the
    // panel; the portal moves it to document.body while a menu is open and
    // restores it on close. Lit keeps updating the same node in place, so
    // close + reopen on every menu change is safe.
    if (this.portal.isOpen()) {
      this.portal.close();
    }
    const menu = this.openMenu;
    if (!menu) {
      return;
    }
    const menuElement = this.querySelector('.atl-menu') as HTMLElement | null;
    if (!menuElement) {
      return;
    }
    if (menu.kind === 'key') {
      this.portal.openAt(menu.x, menu.y, menuElement);
    } else {
      const anchor = this.querySelector(`#${menu.anchorId}`) as HTMLElement | null;
      if (anchor) {
        this.portal.open(anchor, menuElement);
      } else {
        this.openMenu = null;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Data binding
  // ---------------------------------------------------------------------

  private get activeClip(): KeyframeClip | null {
    if (!this.animationSet || !this.activeClipName) {
      return null;
    }
    return findKeyframeClip(this.animationSet, this.activeClipName);
  }

  private get hostNode(): NodeBase | null {
    if (!this.bound) {
      return null;
    }
    return this.sceneManager.getActiveSceneGraph()?.nodeMap.get(this.bound.nodeId) ?? null;
  }

  private sync(): void {
    const graph = this.sceneManager.getActiveSceneGraph();
    this.hasScene = Boolean(graph);
    const primaryId = appState.selection.primaryNodeId;
    this.hasSelection = Boolean(primaryId);

    let nextBound: BoundPlayer | null = null;
    if (graph && primaryId) {
      let node: NodeBase | null = graph.nodeMap.get(primaryId) ?? null;
      while (node) {
        const component = node.components?.find(c => c.type === ANIMATION_PLAYER_COMPONENT_TYPE) as
          | ScriptComponent
          | undefined;
        if (component) {
          nextBound = { nodeId: node.nodeId, nodeName: node.name, componentId: component.id };
          break;
        }
        node = node.parentNode;
      }
    }

    const boundChanged = nextBound?.componentId !== this.bound?.componentId;
    if (boundChanged && this.preview.isActive) {
      this.preview.stopAndRestore();
    }
    // Keep the panel bound to the last player when the selection moves away
    // from any player-owning subtree; rebinding happens as soon as another
    // player is selected. Losing the node entirely (deleted) clears below.
    if (nextBound) {
      this.bound = nextBound;
    } else if (this.bound && graph) {
      const stillExists = graph.nodeMap
        .get(this.bound.nodeId)
        ?.components?.some(c => c.id === this.bound?.componentId);
      if (!stillExists) {
        this.bound = null;
        this.preview.stopAndRestore();
      }
    } else if (!graph) {
      this.bound = null;
    }

    this.refreshAnimationSet();
  }

  private refreshAnimationSet(): void {
    const component = this.resolveComponent();
    if (!component) {
      this.animationSet = null;
      this.activeClipName = null;
      this.selectedKeys = [];
      return;
    }

    const set = normalizeKeyframeAnimationSet(component.config.animations);
    this.animationSet = set;

    if (!this.activeClipName || !findKeyframeClip(set, this.activeClipName)) {
      this.activeClipName = set.clips[0]?.name ?? null;
    }

    // Drop selection entries whose keys vanished.
    const clip = this.activeClip;
    if (clip) {
      this.selectedKeys = this.selectedKeys.filter(ref => {
        const track = findTrack(clip, ref.trackId);
        if (!track) {
          return false;
        }
        return (track.keys as Array<{ time: number }>).some(
          key => Math.abs(key.time - ref.time) < KEY_TIME_EPSILON
        );
      });
    } else {
      this.selectedKeys = [];
    }

    this.syncRecordBaseline(clip);
  }

  /**
   * Keep the autokey baseline in step with the clip's track set: seed newly
   * added tracks (never overwrite an existing baseline, so a pending edit still
   * diffs) and drop removed ones.
   */
  private syncRecordBaseline(clip: KeyframeClip | null): void {
    if (!this.recording) {
      return;
    }
    if (!clip) {
      this.recordBaseline.clear();
      return;
    }
    const liveIds = new Set<string>();
    for (const track of clip.tracks) {
      if (track.kind !== 'property') {
        continue;
      }
      liveIds.add(track.id);
      if (!this.recordBaseline.has(track.id)) {
        const value = this.captureTrackValue(track);
        if (value !== null) {
          this.recordBaseline.set(track.id, value);
        }
      }
    }
    for (const id of [...this.recordBaseline.keys()]) {
      if (!liveIds.has(id)) {
        this.recordBaseline.delete(id);
      }
    }
  }

  private resolveComponent(): ScriptComponent | null {
    const host = this.hostNode;
    if (!host || !this.bound) {
      return null;
    }
    return host.components.find(c => c.id === this.bound?.componentId) ?? null;
  }

  private async mutateClips(
    label: string,
    updater: (draft: KeyframeAnimationSet) => KeyframeAnimationSet | void,
    options?: { coalesceKey?: string; previousSet?: KeyframeAnimationSet }
  ): Promise<void> {
    const bound = this.bound;
    if (!bound) {
      return;
    }
    await this.operations.invokeAndPush(
      new UpdateAnimationPlayerClipsOperation({
        nodeId: bound.nodeId,
        componentId: bound.componentId,
        label,
        updater,
        previousSet: options?.previousSet,
      }),
      options?.coalesceKey ? { coalesceKey: options.coalesceKey } : {}
    );
  }

  // ---------------------------------------------------------------------
  // Preview / transport
  // ---------------------------------------------------------------------

  private ensurePreview(): boolean {
    const bound = this.bound;
    if (!bound || !this.activeClipName) {
      return false;
    }
    return this.preview.begin(bound.nodeId, bound.componentId, this.activeClipName);
  }

  private setPlayhead(time: number): void {
    const clip = this.activeClip;
    const clamped = Math.min(Math.max(0, time), clip?.duration ?? 0);
    this.playhead = clamped;
    if (this.ensurePreview()) {
      this.preview.setTime(clamped);
    }
  }

  private togglePlayback(): void {
    if (this.previewPlaying) {
      this.preview.pause();
      return;
    }
    if (this.ensurePreview()) {
      this.preview.setTime(this.playhead);
      this.preview.play();
    }
  }

  private stopPlayback(): void {
    this.preview.stopAndRestore();
  }

  // ---------------------------------------------------------------------
  // Toolbar actions
  // ---------------------------------------------------------------------

  private onClipSelectChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (this.preview.isActive) {
      this.preview.stopAndRestore();
    }
    this.activeClipName = value;
    this.selectedKeys = [];
    this.playhead = 0;
  }

  private async onCreateClip(): Promise<void> {
    let createdName = '';
    await this.mutateClips('Create animation clip', draft => {
      createdName = addClip(draft).name;
    });
    if (createdName) {
      this.activeClipName = createdName;
    }
    this.openMenu = null;
  }

  private async onDuplicateClip(): Promise<void> {
    const name = this.activeClipName;
    if (!name) {
      return;
    }
    let createdName = '';
    await this.mutateClips('Duplicate animation clip', draft => {
      createdName = duplicateClip(draft, name)?.name ?? '';
    });
    if (createdName) {
      this.activeClipName = createdName;
    }
    this.openMenu = null;
  }

  private async onDeleteClip(): Promise<void> {
    const name = this.activeClipName;
    if (!name) {
      return;
    }
    if (this.preview.isActive) {
      this.preview.stopAndRestore();
    }
    await this.mutateClips(`Delete animation clip ${name}`, draft => {
      deleteClip(draft, name);
    });
    this.openMenu = null;
  }

  private onStartRename(): void {
    this.renameValue = this.activeClipName ?? '';
    this.openMenu = null;
  }

  private async onCommitRename(): Promise<void> {
    const oldName = this.activeClipName;
    const newName = this.renameValue?.trim() ?? '';
    this.renameValue = null;
    if (!oldName || newName.length === 0 || newName === oldName) {
      return;
    }
    let renamed = false;
    await this.mutateClips(`Rename animation clip to ${newName}`, draft => {
      renamed = renameClip(draft, oldName, newName);
    });
    if (renamed) {
      this.activeClipName = newName;
    }
  }

  private async onDurationChange(event: Event): Promise<void> {
    const value = Number((event.target as HTMLInputElement).value);
    const clipName = this.activeClipName;
    if (!clipName || !Number.isFinite(value)) {
      return;
    }
    await this.mutateClips('Set clip duration', draft => {
      const clip = findKeyframeClip(draft, clipName);
      if (clip) {
        setClipDuration(clip, value);
      }
    });
  }

  private async onToggleLoop(): Promise<void> {
    const clipName = this.activeClipName;
    const clip = this.activeClip;
    if (!clipName || !clip) {
      return;
    }
    const nextLoop = !clip.loop;
    await this.mutateClips(nextLoop ? 'Enable clip loop' : 'Disable clip loop', draft => {
      const draftClip = findKeyframeClip(draft, clipName);
      if (draftClip) {
        setClipLoop(draftClip, nextLoop);
      }
    });
  }

  private onZoom(delta: number): void {
    this.zoom = clampZoom(delta === 0 ? 1 : this.zoom * (delta > 0 ? 1.25 : 0.8));
  }

  private async onAddKeyAtPlayhead(): Promise<void> {
    const clip = this.activeClip;
    const clipName = this.activeClipName;
    if (!clip || !clipName) {
      return;
    }
    const trackId = this.selectedKeys[0]?.trackId ?? this.firstPropertyTrackId(clip);
    if (!trackId) {
      return;
    }
    const track = findTrack(clip, trackId);
    if (!track || track.kind !== 'property') {
      return;
    }
    const time = snapTime(this.playhead, this.snapStep, this.snapEnabled);
    const value = this.captureTrackValue(track);
    if (value === null) {
      return;
    }
    await this.mutateClips('Add keyframe', draft => {
      const draftClip = findKeyframeClip(draft, clipName);
      const draftTrack = draftClip ? findTrack(draftClip, trackId) : null;
      if (draftTrack && draftTrack.kind === 'property') {
        upsertKey(draftTrack, time, value);
      }
    });
    this.selectedKeys = [{ trackId, time }];
  }

  private async onDeleteSelectedKeys(): Promise<void> {
    const clipName = this.activeClipName;
    if (!clipName || this.selectedKeys.length === 0) {
      return;
    }
    const selection = [...this.selectedKeys];
    await this.mutateClips('Delete keyframes', draft => {
      const clip = findKeyframeClip(draft, clipName);
      if (!clip) {
        return;
      }
      const byTrack = new Map<string, number[]>();
      for (const ref of selection) {
        const times = byTrack.get(ref.trackId) ?? [];
        times.push(ref.time);
        byTrack.set(ref.trackId, times);
      }
      for (const [trackId, times] of byTrack) {
        const track = findTrack(clip, trackId);
        if (track) {
          deleteKeys(track, times);
        }
      }
    });
    this.selectedKeys = [];
  }

  private async onSelectionEasingChange(event: Event): Promise<void> {
    const easing = (event.target as HTMLSelectElement).value as KeyframeEasing;
    const clipName = this.activeClipName;
    if (!clipName || this.selectedKeys.length === 0) {
      return;
    }
    const selection = [...this.selectedKeys];
    await this.mutateClips('Set keyframe easing', draft => {
      const clip = findKeyframeClip(draft, clipName);
      if (!clip) {
        return;
      }
      for (const ref of selection) {
        const track = findTrack(clip, ref.trackId);
        if (track && track.kind === 'property') {
          setKeyEasing(track, ref.time, easing);
        }
      }
    });
  }

  private async onAddPlayerClick(): Promise<void> {
    await this.commandDispatcher.execute(new AddAnimationPlayerToSelectionCommand());
  }

  private onAddTrackClick(): void {
    this.openMenu =
      this.openMenu?.kind === 'add-track'
        ? null
        : {
            kind: 'add-track',
            anchorId: 'atl-add-track-trigger',
            stage: 'nodes',
            targetPath: '',
          };
  }

  // ---------------------------------------------------------------------
  // Autokey (record) — Godot-style: pose the node, get a keyframe
  // ---------------------------------------------------------------------

  private onToggleRecording(): void {
    this.recording = !this.recording;
    if (this.recording) {
      // Park on the current pose so only real edits register as changes, then
      // snapshot the authored baseline to diff future edits against.
      if (this.preview.isActive) {
        this.preview.stopAndRestore();
      }
      this.captureRecordBaseline();
    } else {
      this.recordBaseline.clear();
    }
  }

  /** Snapshot each property track's current live value as the diff baseline. */
  private captureRecordBaseline(): void {
    this.recordBaseline.clear();
    const clip = this.activeClip;
    if (!clip) {
      return;
    }
    for (const track of clip.tracks) {
      if (track.kind !== 'property') {
        continue;
      }
      const value = this.captureTrackValue(track);
      if (value !== null) {
        this.recordBaseline.set(track.id, value);
      }
    }
  }

  private readonly onAutokeyOperation = (event: OperationEvent): void => {
    if (!this.recording || this.autokeyInFlight || !this.bound) {
      return;
    }
    if (event.type !== 'operation:completed' || !event.didMutate) {
      return;
    }
    // Ignore our own clip edits (they update the baseline directly) and pure
    // selection changes; every other mutation may have re-posed a tracked node.
    if (
      event.metadata.id === UPDATE_ANIMATION_CLIPS_OPERATION_ID ||
      event.metadata.id === 'scene.select-object'
    ) {
      return;
    }
    void this.recordChangedTracks();
  };

  /**
   * Compare each property track's live value against the baseline; insert a
   * keyframe at the playhead for every track the user actually changed. The
   * preview restores authored values before any edit performs (see
   * AnimationTimelinePreviewService), so untouched tracks stay equal to their
   * baseline and only the edited ones key.
   */
  private async recordChangedTracks(): Promise<void> {
    const clip = this.activeClip;
    const clipName = this.activeClipName;
    if (!clip || !clipName) {
      return;
    }
    const time = snapTime(this.playhead, this.snapStep, this.snapEnabled);
    const changes: Array<{ trackId: string; value: KeyframeValue }> = [];
    for (const track of clip.tracks) {
      if (track.kind !== 'property') {
        continue;
      }
      const live = this.captureTrackValue(track);
      if (live === null) {
        continue;
      }
      const baseline = this.recordBaseline.get(track.id);
      if (baseline === undefined) {
        // Track added after recording started: seed the baseline, don't key.
        this.recordBaseline.set(track.id, live);
        continue;
      }
      if (!keyframeValuesDiffer(live, baseline)) {
        continue;
      }
      changes.push({ trackId: track.id, value: live });
      this.recordBaseline.set(track.id, live);
    }
    if (changes.length === 0) {
      return;
    }
    this.autokeyInFlight = true;
    try {
      await this.mutateClips(
        'Record keyframe',
        draft => {
          const draftClip = findKeyframeClip(draft, clipName);
          if (!draftClip) {
            return;
          }
          for (const change of changes) {
            const track = findTrack(draftClip, change.trackId);
            if (track && track.kind === 'property') {
              upsertKey(track, time, change.value);
            }
          }
        },
        { coalesceKey: `animtl:autokey:${this.bound?.componentId}:${clipName}:${time.toFixed(4)}` }
      );
    } finally {
      this.autokeyInFlight = false;
    }
    this.selectedKeys = changes.map(c => ({ trackId: c.trackId, time }));
  }

  /**
   * The node's current live value for the track's property — a real "record"
   * capture. Adding a keyframe stores wherever the user posed the node (via the
   * gizmo/inspector), NOT the value the existing curve would interpolate to, so
   * "pose the node → add key" records the new pose. While scrubbing, the live
   * value already equals the sampled pose, so keying on the curve still works.
   */
  private captureTrackValue(track: PropertyTrack): KeyframeValue | null {
    const host = this.hostNode;
    if (!host) {
      return null;
    }
    const target = resolveTrackTarget(host, track.targetPath);
    if (!target) {
      return null;
    }
    const propDef = getNodePropertySchema(target).properties.find(p => p.name === track.property);
    if (!propDef) {
      return null;
    }
    return fromSchemaValue(track.valueType, propDef.getValue(target));
  }

  private firstPropertyTrackId(clip: KeyframeClip): string | null {
    return clip.tracks.find(track => track.kind === 'property')?.id ?? null;
  }

  // ---------------------------------------------------------------------
  // Ruler scrub + keyframe drag
  // ---------------------------------------------------------------------

  private laneTimeFromClientX(clientX: number, lane: HTMLElement): number {
    const rect = lane.getBoundingClientRect();
    return xToTime(clientX - rect.left, this.zoom);
  }

  /** setPointerCapture throws for inactive pointer ids (e.g. synthetic events). */
  private capturePointer(element: HTMLElement, pointerId: number): void {
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // Dragging still works while the pointer stays over the element.
    }
  }

  private onRulerPointerDown(event: PointerEvent): void {
    const ruler = event.currentTarget as HTMLElement;
    this.capturePointer(ruler, event.pointerId);
    this.scrubPointerId = event.pointerId;
    this.setPlayhead(
      snapTime(this.laneTimeFromClientX(event.clientX, ruler), this.snapStep, this.snapEnabled)
    );
  }

  private onRulerPointerMove(event: PointerEvent): void {
    if (this.scrubPointerId !== event.pointerId) {
      return;
    }
    const ruler = event.currentTarget as HTMLElement;
    this.setPlayhead(
      snapTime(this.laneTimeFromClientX(event.clientX, ruler), this.snapStep, this.snapEnabled)
    );
  }

  private onRulerPointerUp(event: PointerEvent): void {
    if (this.scrubPointerId === event.pointerId) {
      this.scrubPointerId = null;
    }
  }

  private onKeyPointerDown(event: PointerEvent, track: ClipTrack, keyTime: number): void {
    event.stopPropagation();
    if (event.button !== 0) {
      return;
    }

    const ref: KeyRef = { trackId: track.id, time: keyTime };
    const isSelected = this.isKeySelected(ref);
    // Re-clicking the sole selected key opens its property popover on pointerup
    // (unless it turns into a drag) — a fast check/tweak affordance.
    const reopenPopover = isSelected && !event.shiftKey && this.selectedKeys.length === 1;
    if (event.shiftKey) {
      this.selectedKeys = isSelected
        ? this.selectedKeys.filter(k => !this.sameKey(k, ref))
        : [...this.selectedKeys, ref];
    } else if (!isSelected) {
      this.selectedKeys = [ref];
    }

    if (!this.animationSet || !this.activeClipName || this.selectedKeys.length === 0) {
      return;
    }

    dragSessionCounter += 1;
    const element = event.currentTarget as HTMLElement;
    this.capturePointer(element, event.pointerId);
    this.keysDrag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      previousSet: structuredClone(this.animationSet),
      coalesceKey: `animtl:${this.bound?.componentId}:${this.activeClipName}:drag-${dragSessionCounter}`,
      selection: this.selectedKeys.map(k => ({ ...k })),
      anchorTime: keyTime,
      lastDelta: 0,
      pendingDelta: null,
      commitInFlight: false,
      moved: false,
      reopenPopover,
      popoverTrackId: track.id,
      popoverKeyTime: keyTime,
    };
  }

  private onKeyPointerMove(event: PointerEvent): void {
    const drag = this.keysDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const rawDelta = (event.clientX - drag.startClientX) / pxPerSecond(this.zoom);
    // Snap the grabbed key's destination, apply the same delta to the rest.
    const snappedAnchor = snapTime(drag.anchorTime + rawDelta, this.snapStep, this.snapEnabled);
    const delta = snappedAnchor - drag.anchorTime;
    if (Math.abs(delta - drag.lastDelta) < KEY_TIME_EPSILON) {
      return;
    }
    drag.moved = true;
    drag.lastDelta = delta;
    void this.commitKeysDrag(delta);
  }

  private onKeyPointerUp(event: PointerEvent): void {
    const drag = this.keysDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    this.keysDrag = null;
    if (drag.moved) {
      // Selection follows the moved keys.
      this.selectedKeys = drag.selection.map(ref => ({
        trackId: ref.trackId,
        time: Math.max(0, ref.time + drag.lastDelta),
      }));
      return;
    }
    if (drag.reopenPopover) {
      this.openMenu = {
        kind: 'key',
        x: event.clientX,
        y: event.clientY,
        trackId: drag.popoverTrackId,
        keyTime: drag.popoverKeyTime,
      };
    }
  }

  private async commitKeysDrag(delta: number): Promise<void> {
    const drag = this.keysDrag;
    const clipName = this.activeClipName;
    if (!drag || !clipName) {
      return;
    }
    if (drag.commitInFlight) {
      drag.pendingDelta = delta;
      return;
    }
    drag.commitInFlight = true;

    const previous = drag.previousSet;
    const selection = drag.selection;
    await this.mutateClips(
      'Move keyframes',
      () => {
        const next = structuredClone(previous);
        const clip = findKeyframeClip(next, clipName);
        if (!clip) {
          return next;
        }
        const byTrack = new Map<string, number[]>();
        for (const ref of selection) {
          const times = byTrack.get(ref.trackId) ?? [];
          times.push(ref.time);
          byTrack.set(ref.trackId, times);
        }
        for (const [trackId, times] of byTrack) {
          const track = findTrack(clip, trackId);
          if (track) {
            moveKeys(track, times, delta, clip.duration);
          }
        }
        return next;
      },
      { coalesceKey: drag.coalesceKey, previousSet: previous }
    );

    // The drag may have ended while the commit was in flight.
    const activeDrag = this.keysDrag;
    if (activeDrag) {
      activeDrag.commitInFlight = false;
      if (activeDrag.pendingDelta !== null && activeDrag.pendingDelta !== delta) {
        const pending = activeDrag.pendingDelta;
        activeDrag.pendingDelta = null;
        void this.commitKeysDrag(pending);
      } else {
        activeDrag.pendingDelta = null;
      }
    }
  }

  private async onLaneDoubleClick(event: MouseEvent, track: ClipTrack): Promise<void> {
    const clipName = this.activeClipName;
    if (!clipName || track.kind !== 'property') {
      return;
    }
    const lane = event.currentTarget as HTMLElement;
    const time = snapTime(
      this.laneTimeFromClientX(event.clientX, lane),
      this.snapStep,
      this.snapEnabled
    );
    const value = this.captureTrackValue(track);
    if (value === null) {
      return;
    }
    await this.mutateClips('Add keyframe', draft => {
      const clip = findKeyframeClip(draft, clipName);
      const draftTrack = clip ? findTrack(clip, track.id) : null;
      if (draftTrack && draftTrack.kind === 'property') {
        upsertKey(draftTrack, time, value);
      }
    });
    this.selectedKeys = [{ trackId: track.id, time }];
  }

  private onKeyContextMenu(event: MouseEvent, track: ClipTrack, keyTime: number): void {
    event.preventDefault();
    event.stopPropagation();
    const ref: KeyRef = { trackId: track.id, time: keyTime };
    if (!this.isKeySelected(ref)) {
      this.selectedKeys = [ref];
    }
    this.openMenu = { kind: 'key', x: event.clientX, y: event.clientY, trackId: track.id, keyTime };
  }

  // ---------------------------------------------------------------------
  // Audio drag & drop
  // ---------------------------------------------------------------------

  private onLaneDragOver(event: DragEvent, track: ClipTrack): void {
    if (track.kind !== 'audio' || !event.dataTransfer || !hasAssetDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  private async onLaneDrop(event: DragEvent, track: ClipTrack): Promise<void> {
    if (track.kind !== 'audio' || !event.dataTransfer) {
      return;
    }
    const resourcePath = getDroppedAssetResourcePath(event.dataTransfer);
    if (!resourcePath || !AUDIO_EXTENSIONS.some(ext => resourcePath.toLowerCase().endsWith(ext))) {
      return;
    }
    event.preventDefault();
    const lane = event.currentTarget as HTMLElement;
    const time = snapTime(
      this.laneTimeFromClientX(event.clientX, lane),
      this.snapStep,
      this.snapEnabled
    );
    const clipName = this.activeClipName;
    if (!clipName) {
      return;
    }
    await this.mutateClips('Add audio keyframe', draft => {
      const clip = findKeyframeClip(draft, clipName);
      const draftTrack = clip ? findTrack(clip, track.id) : null;
      if (draftTrack && draftTrack.kind === 'audio') {
        upsertAudioKey(draftTrack, time, resourcePath);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Track management
  // ---------------------------------------------------------------------

  private async onToggleTrackEnabled(track: ClipTrack, event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    const clipName = this.activeClipName;
    if (!clipName) {
      return;
    }
    await this.mutateClips(enabled ? 'Enable track' : 'Mute track', draft => {
      const clip = findKeyframeClip(draft, clipName);
      if (clip) {
        setTrackEnabled(clip, track.id, enabled);
      }
    });
  }

  private async onRemoveTrack(track: ClipTrack): Promise<void> {
    const clipName = this.activeClipName;
    if (!clipName) {
      return;
    }
    await this.mutateClips('Remove track', draft => {
      const clip = findKeyframeClip(draft, clipName);
      if (clip) {
        removeTrack(clip, track.id);
      }
    });
  }

  private async onAddPropertyTrack(targetPath: string, propDef: PropertyDefinition): Promise<void> {
    const clipName = this.activeClipName;
    const host = this.hostNode;
    if (!clipName || !host) {
      return;
    }
    const valueType = SUPPORTED_TRACK_TYPES[propDef.type];
    if (!valueType) {
      return;
    }
    const target = resolveTrackTarget(host, targetPath);
    const initialValue = target
      ? (fromSchemaValue(valueType, propDef.getValue(target)) ?? undefined)
      : undefined;

    await this.mutateClips(`Add track ${propDef.name}`, draft => {
      const clip = findKeyframeClip(draft, clipName);
      if (clip) {
        addPropertyTrack(clip, { targetPath, property: propDef.name, valueType, initialValue });
      }
    });
    this.openMenu = null;
  }

  private async onAddAudioTrack(): Promise<void> {
    const clipName = this.activeClipName;
    if (!clipName) {
      return;
    }
    await this.mutateClips('Add audio track', draft => {
      const clip = findKeyframeClip(draft, clipName);
      if (clip) {
        addAudioTrack(clip);
      }
    });
    this.openMenu = null;
  }

  // ---------------------------------------------------------------------
  // Key context menu actions
  // ---------------------------------------------------------------------

  private contextKey(): { track: ClipTrack; time: number } | null {
    const menu = this.openMenu;
    const clip = this.activeClip;
    if (!menu || menu.kind !== 'key' || !clip) {
      return null;
    }
    const track = findTrack(clip, menu.trackId);
    if (!track) {
      return null;
    }
    return { track, time: menu.keyTime };
  }

  private async onContextSetEasing(easing: KeyframeEasing): Promise<void> {
    const ctx = this.contextKey();
    const clipName = this.activeClipName;
    if (!ctx || !clipName || ctx.track.kind !== 'property') {
      return;
    }
    await this.mutateClips('Set keyframe easing', draft => {
      const clip = findKeyframeClip(draft, clipName);
      const track = clip ? findTrack(clip, ctx.track.id) : null;
      if (track && track.kind === 'property') {
        setKeyEasing(track, ctx.time, easing);
      }
    });
    this.openMenu = null;
  }

  private async onContextSetValue(value: KeyframeValue): Promise<void> {
    const ctx = this.contextKey();
    const clipName = this.activeClipName;
    if (!ctx || !clipName || ctx.track.kind !== 'property') {
      return;
    }
    await this.mutateClips('Set keyframe value', draft => {
      const clip = findKeyframeClip(draft, clipName);
      const track = clip ? findTrack(clip, ctx.track.id) : null;
      if (track && track.kind === 'property') {
        setKeyValue(track, ctx.time, value);
      }
    });
  }

  private async onContextSetAudio(pathOrVolume: { path?: string; volume?: number }): Promise<void> {
    const ctx = this.contextKey();
    const clipName = this.activeClipName;
    if (!ctx || !clipName || ctx.track.kind !== 'audio') {
      return;
    }
    const existing = ctx.track.keys.find(k => Math.abs(k.time - ctx.time) < KEY_TIME_EPSILON);
    if (!existing) {
      return;
    }
    const path = pathOrVolume.path ?? existing.audioPath;
    const volume = pathOrVolume.volume ?? existing.volume;
    await this.mutateClips('Edit audio keyframe', draft => {
      const clip = findKeyframeClip(draft, clipName);
      const track = clip ? findTrack(clip, ctx.track.id) : null;
      if (track && track.kind === 'audio') {
        upsertAudioKey(track, ctx.time, path, volume);
      }
    });
  }

  private async onContextDuplicateAtPlayhead(): Promise<void> {
    const ctx = this.contextKey();
    const clipName = this.activeClipName;
    if (!ctx || !clipName) {
      return;
    }
    const time = snapTime(this.playhead, this.snapStep, this.snapEnabled);
    await this.mutateClips('Duplicate keyframe', draft => {
      const clip = findKeyframeClip(draft, clipName);
      const track = clip ? findTrack(clip, ctx.track.id) : null;
      if (!track) {
        return;
      }
      if (track.kind === 'property') {
        const key = track.keys.find(k => Math.abs(k.time - ctx.time) < KEY_TIME_EPSILON);
        if (key) {
          upsertKey(track, time, structuredClone(key.value), key.easing);
        }
      } else {
        const key = track.keys.find(k => Math.abs(k.time - ctx.time) < KEY_TIME_EPSILON);
        if (key) {
          upsertAudioKey(track, time, key.audioPath, key.volume);
        }
      }
    });
    this.openMenu = null;
  }

  private async onContextDeleteKey(): Promise<void> {
    const ctx = this.contextKey();
    const clipName = this.activeClipName;
    if (!ctx || !clipName) {
      return;
    }
    await this.mutateClips('Delete keyframe', draft => {
      const clip = findKeyframeClip(draft, clipName);
      const track = clip ? findTrack(clip, ctx.track.id) : null;
      if (track) {
        deleteKeys(track, [ctx.time]);
      }
    });
    this.openMenu = null;
  }

  // ---------------------------------------------------------------------
  // Panel-local keyboard shortcuts
  // ---------------------------------------------------------------------

  private onPanelKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable
    ) {
      return;
    }

    switch (event.key) {
      case ' ':
        event.preventDefault();
        this.togglePlayback();
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        void this.onDeleteSelectedKeys();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        event.preventDefault();
        const step = this.snapStep * (event.shiftKey ? 5 : 1);
        const delta = event.key === 'ArrowLeft' ? -step : step;
        if (this.selectedKeys.length > 0) {
          void this.nudgeSelectedKeys(delta);
        } else {
          this.setPlayhead(this.playhead + delta);
        }
        break;
      }
      case 'Home':
        event.preventDefault();
        this.setPlayhead(0);
        break;
      case 'End':
        event.preventDefault();
        this.setPlayhead(this.activeClip?.duration ?? 0);
        break;
    }
  }

  private async nudgeSelectedKeys(delta: number): Promise<void> {
    const clipName = this.activeClipName;
    if (!clipName || this.selectedKeys.length === 0) {
      return;
    }
    const selection = [...this.selectedKeys];
    await this.mutateClips('Nudge keyframes', draft => {
      const clip = findKeyframeClip(draft, clipName);
      if (!clip) {
        return;
      }
      const byTrack = new Map<string, number[]>();
      for (const ref of selection) {
        const times = byTrack.get(ref.trackId) ?? [];
        times.push(ref.time);
        byTrack.set(ref.trackId, times);
      }
      for (const [trackId, times] of byTrack) {
        const track = findTrack(clip, trackId);
        if (track) {
          moveKeys(track, times, delta, clip.duration);
        }
      }
    });
    this.selectedKeys = selection.map(ref => ({
      trackId: ref.trackId,
      time: Math.min(Math.max(0, ref.time + delta), this.activeClip?.duration ?? Infinity),
    }));
  }

  private isKeySelected(ref: KeyRef): boolean {
    return this.selectedKeys.some(k => this.sameKey(k, ref));
  }

  private sameKey(a: KeyRef, b: KeyRef): boolean {
    return a.trackId === b.trackId && Math.abs(a.time - b.time) < KEY_TIME_EPSILON;
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  protected render() {
    return html`
      <pix3-panel
        panel-description="Animate node properties with keyframes, tweens, and sounds."
        actions-label="Animation timeline controls"
      >
        ${this.bound ? html`<span slot="subtitle">${this.bound.nodeName}</span>` : null}
        ${this.renderToolbar()}
        <div class="atl-root" tabindex="0" @keydown=${this.onPanelKeyDown}>
          ${this.renderBody()}${this.renderMenu()}
        </div>
      </pix3-panel>
    `;
  }

  private renderToolbar() {
    const clip = this.activeClip;
    const set = this.animationSet;
    const hasClip = Boolean(clip);
    const selectionHasPropertyKeys = this.selectedKeysOnPropertyTracks().length > 0;

    return html`
      <pix3-toolbar slot="toolbar" variant="panel" label="Animation timeline controls">
        ${this.renameValue !== null
          ? html`
              <input
                class="atl-input atl-input--rename"
                .value=${this.renameValue}
                aria-label="Clip name"
                @input=${(e: Event) => {
                  this.renameValue = (e.target as HTMLInputElement).value;
                }}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') {
                    void this.onCommitRename();
                  } else if (e.key === 'Escape') {
                    this.renameValue = null;
                  }
                }}
                @blur=${() => void this.onCommitRename()}
              />
            `
          : html`
              <select
                class="atl-select atl-select--clip"
                aria-label="Animation clip"
                ?disabled=${!set || set.clips.length === 0}
                @change=${this.onClipSelectChange}
              >
                ${(set?.clips ?? []).map(
                  c =>
                    html`<option value=${c.name} ?selected=${c.name === this.activeClipName}>
                      ${c.name}
                    </option>`
                )}
              </select>
            `}
        <pix3-toolbar-button
          id="atl-clip-actions-trigger"
          data-atl-menu-trigger
          icon="more-vertical"
          iconOnly
          aria-label="Clip actions"
          ?disabled=${!this.bound}
          @click=${() => {
            this.openMenu =
              this.openMenu?.kind === 'clip-actions'
                ? null
                : { kind: 'clip-actions', anchorId: 'atl-clip-actions-trigger' };
          }}
        ></pix3-toolbar-button>
        <span class="atl-toolbar-separator"></span>
        <pix3-toolbar-button
          icon=${this.previewPlaying ? 'pause' : 'play'}
          iconOnly
          aria-label=${this.previewPlaying ? 'Pause preview' : 'Play preview'}
          ?disabled=${!hasClip}
          @click=${() => this.togglePlayback()}
        ></pix3-toolbar-button>
        <pix3-toolbar-button
          icon="square"
          iconOnly
          aria-label="Stop preview and restore scene"
          ?disabled=${!this.previewActive}
          @click=${() => this.stopPlayback()}
        ></pix3-toolbar-button>
        <pix3-toolbar-button
          class="atl-record"
          icon="circle"
          iconOnly
          aria-label=${this.recording
            ? 'Autokey on: moving the node records keyframes'
            : 'Autokey off: enable to record keyframes as you pose the node'}
          ?toggled=${this.recording}
          ?disabled=${!hasClip}
          @click=${() => this.onToggleRecording()}
        ></pix3-toolbar-button>
        <span class="atl-time-readout">${formatTime(this.playhead)}</span>
        <span class="atl-toolbar-separator"></span>
        <label class="atl-field">
          <span>Length</span>
          <input
            class="atl-input atl-input--duration"
            type="number"
            min="0.01"
            step="0.1"
            .value=${clip ? String(clip.duration) : ''}
            ?disabled=${!hasClip}
            aria-label="Clip duration in seconds"
            @change=${this.onDurationChange}
          />
        </label>
        <pix3-toolbar-button
          icon="repeat"
          iconOnly
          aria-label="Loop clip"
          ?toggled=${clip?.loop ?? false}
          ?disabled=${!hasClip}
          @click=${() => void this.onToggleLoop()}
        ></pix3-toolbar-button>
        <span class="atl-toolbar-separator"></span>
        <pix3-toolbar-button
          icon="snap"
          iconOnly
          aria-label="Snap keys to grid"
          ?toggled=${this.snapEnabled}
          @click=${() => {
            this.snapEnabled = !this.snapEnabled;
          }}
        ></pix3-toolbar-button>
        <select
          class="atl-select atl-select--snap"
          aria-label="Snap step in seconds"
          ?disabled=${!this.snapEnabled}
          @change=${(e: Event) => {
            this.snapStep = Number((e.target as HTMLSelectElement).value);
          }}
        >
          ${SNAP_STEPS.map(
            step =>
              html`<option value=${String(step)} ?selected=${step === this.snapStep}>
                ${step}s
              </option>`
          )}
        </select>
        <span class="atl-toolbar-separator"></span>
        <pix3-toolbar-button
          icon="zoom-out"
          iconOnly
          aria-label="Zoom out"
          @click=${() => this.onZoom(-1)}
        ></pix3-toolbar-button>
        <pix3-toolbar-button
          icon="zoom-default"
          iconOnly
          aria-label="Reset zoom"
          @click=${() => this.onZoom(0)}
        ></pix3-toolbar-button>
        <pix3-toolbar-button
          icon="zoom-in"
          iconOnly
          aria-label="Zoom in"
          @click=${() => this.onZoom(1)}
        ></pix3-toolbar-button>
        <span class="atl-toolbar-separator"></span>
        <pix3-toolbar-button
          icon="plus-circle"
          iconOnly
          aria-label="Add keyframe at playhead"
          ?disabled=${!hasClip}
          @click=${() => void this.onAddKeyAtPlayhead()}
        ></pix3-toolbar-button>
        <pix3-toolbar-button
          icon="trash-2"
          iconOnly
          aria-label="Delete selected keyframes"
          ?disabled=${this.selectedKeys.length === 0}
          @click=${() => void this.onDeleteSelectedKeys()}
        ></pix3-toolbar-button>
        <select
          class="atl-select atl-select--easing"
          aria-label="Easing for selected keyframes"
          ?disabled=${!selectionHasPropertyKeys}
          @change=${this.onSelectionEasingChange}
        >
          <option value="" selected disabled>Easing…</option>
          ${EASING_NAMES.map(name => html`<option value=${name}>${name}</option>`)}
        </select>
      </pix3-toolbar>
    `;
  }

  private selectedKeysOnPropertyTracks(): KeyRef[] {
    const clip = this.activeClip;
    if (!clip) {
      return [];
    }
    return this.selectedKeys.filter(ref => {
      const track = findTrack(clip, ref.trackId);
      return track?.kind === 'property';
    });
  }

  private renderBody() {
    if (!this.hasScene) {
      return html`<p class="atl-placeholder">Open a scene to edit animations.</p>`;
    }
    if (!this.bound) {
      if (!this.hasSelection) {
        return html`<p class="atl-placeholder">
          Select a node to animate. The timeline binds to the node's AnimationPlayer component.
        </p>`;
      }
      return html`
        <div class="atl-placeholder">
          <p>The selected node has no AnimationPlayer component.</p>
          <button
            type="button"
            class="atl-primary-button"
            @click=${() => void this.onAddPlayerClick()}
          >
            Add AnimationPlayer
          </button>
        </div>
      `;
    }

    const clip = this.activeClip;
    if (!clip) {
      return html`
        <div class="atl-placeholder">
          <p>No animation clips yet.</p>
          <button type="button" class="atl-primary-button" @click=${() => void this.onCreateClip()}>
            Create clip
          </button>
        </div>
      `;
    }

    return this.renderTimeline(clip);
  }

  private renderTimeline(clip: KeyframeClip) {
    const lastKeyTime = clip.tracks.reduce((max, track) => {
      const keys = track.keys as Array<{ time: number }>;
      return keys.length > 0 ? Math.max(max, keys[keys.length - 1].time) : max;
    }, 0);
    const endTime = Math.max(clip.duration, lastKeyTime) + 0.25;
    const laneWidth = timeToX(endTime, this.zoom) + 40;
    const ticks = getRulerTicks(endTime, this.zoom);
    const playheadX = timeToX(this.playhead, this.zoom);
    const durationX = timeToX(clip.duration, this.zoom);
    const host = this.hostNode;

    return html`
      <div class="atl-scroll">
        <div class="atl-grid" style="grid-template-columns: ${TRACK_LABEL_WIDTH}px ${laneWidth}px;">
          <div class="atl-corner">
            <button
              type="button"
              id="atl-add-track-trigger"
              class="atl-add-track"
              data-atl-menu-trigger
              aria-haspopup="menu"
              aria-expanded=${this.openMenu?.kind === 'add-track' ? 'true' : 'false'}
              @click=${() => this.onAddTrackClick()}
            >
              <span class="atl-add-track-icon">${this.iconService.getIcon('plus', 14)}</span>
              <span>Add Track</span>
            </button>
          </div>
          <div
            class="atl-ruler"
            style="width: ${laneWidth}px;"
            @pointerdown=${this.onRulerPointerDown}
            @pointermove=${this.onRulerPointerMove}
            @pointerup=${this.onRulerPointerUp}
            @pointercancel=${this.onRulerPointerUp}
          >
            <div class="atl-ruler-overflow" style="left: ${durationX}px;"></div>
            ${ticks.map(
              tick => html`
                <span
                  class="atl-tick ${tick.major ? 'atl-tick--major' : ''}"
                  style="left: ${timeToX(tick.time, this.zoom)}px;"
                ></span>
                ${tick.label !== null
                  ? html`<span
                      class="atl-tick-label"
                      style="left: ${timeToX(tick.time, this.zoom) + 3}px;"
                      >${tick.label}</span
                    >`
                  : null}
              `
            )}
            <span class="atl-duration-marker" style="left: ${durationX}px;" title="Clip end"></span>
            <span class="atl-playhead-handle" style="left: ${playheadX}px;"></span>
          </div>
          ${clip.tracks.map(track => this.renderTrackRow(track, clip, laneWidth, host))}
          ${clip.tracks.length === 0
            ? html`
                <div class="atl-track-label atl-track-label--empty">No tracks</div>
                <div class="atl-lane atl-lane--empty" style="width: ${laneWidth}px;">
                  <span class="atl-lane-hint">Use “Add Track” to animate a property.</span>
                </div>
              `
            : null}
          <div class="atl-playhead" style="left: ${TRACK_LABEL_WIDTH + playheadX}px;"></div>
        </div>
      </div>
    `;
  }

  private renderTrackRow(
    track: ClipTrack,
    clip: KeyframeClip,
    laneWidth: number,
    host: NodeBase | null
  ) {
    const isAudio = track.kind === 'audio';
    const label = isAudio
      ? (track as AudioTrack).name
      : `${(track as PropertyTrack).targetPath || '(self)'} · ${(track as PropertyTrack).property}`;
    const missingTarget =
      !isAudio && host
        ? resolveTrackTarget(host, (track as PropertyTrack).targetPath) === null
        : false;

    return html`
      <div class="atl-track-label ${track.enabled ? '' : 'atl-track-label--muted'}">
        <input
          type="checkbox"
          class="atl-track-toggle"
          .checked=${track.enabled}
          aria-label="Track enabled"
          title="Enable / mute track"
          @change=${(e: Event) => void this.onToggleTrackEnabled(track, e)}
        />
        ${isAudio
          ? html`<span class="atl-track-icon">${this.iconService.getIcon('volume-2', 14)}</span>`
          : null}
        <span class="atl-track-name" title=${label}>${label}</span>
        ${missingTarget
          ? html`<span class="atl-track-warning" title="Target node not found">
              ${this.iconService.getIcon('alert-triangle', 14)}
            </span>`
          : null}
        <button
          type="button"
          class="atl-track-remove"
          aria-label="Remove track"
          title="Remove track"
          @click=${() => void this.onRemoveTrack(track)}
        >
          ${this.iconService.getIcon('x', 14)}
        </button>
      </div>
      <div
        class="atl-lane ${isAudio ? 'atl-lane--audio' : ''}"
        style="width: ${laneWidth}px;"
        @dblclick=${(e: MouseEvent) => void this.onLaneDoubleClick(e, track)}
        @dragover=${(e: DragEvent) => this.onLaneDragOver(e, track)}
        @drop=${(e: DragEvent) => void this.onLaneDrop(e, track)}
      >
        <span
          class="atl-lane-overflow"
          style="left: ${timeToX(clip.duration, this.zoom)}px;"
        ></span>
        ${(track.keys as Array<{ time: number }>).map(key => this.renderKey(track, key))}
      </div>
    `;
  }

  private renderKey(track: ClipTrack, key: { time: number }) {
    const isAudio = track.kind === 'audio';
    const selected = this.isKeySelected({ trackId: track.id, time: key.time });
    const title = isAudio
      ? `${formatTime(key.time)} · ${(key as AudioTrack['keys'][number]).audioPath}`
      : `${formatTime(key.time)} · ${(key as PropertyTrack['keys'][number]).easing}`;

    return html`
      <button
        type="button"
        class="atl-key ${isAudio ? 'atl-key--audio' : ''} ${selected ? 'atl-key--selected' : ''}"
        style="left: ${timeToX(key.time, this.zoom)}px;"
        title=${title}
        aria-label=${title}
        @pointerdown=${(e: PointerEvent) => this.onKeyPointerDown(e, track, key.time)}
        @pointermove=${this.onKeyPointerMove}
        @pointerup=${this.onKeyPointerUp}
        @pointercancel=${this.onKeyPointerUp}
        @contextmenu=${(e: MouseEvent) => this.onKeyContextMenu(e, track, key.time)}
        @dblclick=${(e: Event) => e.stopPropagation()}
      ></button>
    `;
  }

  // ---------------------------------------------------------------------
  // Menus (portal-rendered)
  // ---------------------------------------------------------------------

  /**
   * Always renders the same (single, stable) `.atl-menu` element so the
   * dropdown portal can move it to document.body and back without fighting
   * Lit over node ownership. It stays hidden while inline in the panel;
   * portal CSS makes it visible.
   */
  private renderMenu() {
    const menu = this.openMenu;
    let content: unknown = null;
    if (menu) {
      if (menu.kind === 'clip-actions') {
        content = this.renderClipActionsMenu();
      } else if (menu.kind === 'add-track') {
        content = this.renderAddTrackMenu(menu);
      } else {
        content = this.renderKeyContextMenu();
      }
    }
    return html`
      <div class="atl-menu" role="menu" @click=${(e: Event) => e.stopPropagation()}>${content}</div>
    `;
  }

  private renderClipActionsMenu() {
    return html`
      <button type="button" role="menuitem" @click=${() => void this.onCreateClip()}>
        New Clip
      </button>
      <button
        type="button"
        role="menuitem"
        ?disabled=${!this.activeClipName}
        @click=${() => this.onStartRename()}
      >
        Rename Clip
      </button>
      <button
        type="button"
        role="menuitem"
        ?disabled=${!this.activeClipName}
        @click=${() => void this.onDuplicateClip()}
      >
        Duplicate Clip
      </button>
      <button
        type="button"
        role="menuitem"
        class="atl-menu-danger"
        ?disabled=${!this.activeClipName}
        @click=${() => void this.onDeleteClip()}
      >
        Delete Clip
      </button>
    `;
  }

  private renderAddTrackMenu(menu: Extract<OpenMenu, { kind: 'add-track' }>) {
    const host = this.hostNode;
    if (!host) {
      return null;
    }

    if (menu.stage === 'nodes') {
      const entries = this.collectTargetEntries(host);
      return html`
        <button type="button" role="menuitem" @click=${() => void this.onAddAudioTrack()}>
          ${this.iconService.getIcon('volume-2', 14)} Audio Track
        </button>
        <div class="atl-menu-separator"></div>
        <div class="atl-menu-heading">Animate node property…</div>
        ${entries.map(
          entry => html`
            <button
              type="button"
              role="menuitem"
              style="padding-left: ${0.75 + entry.depth * 0.9}rem;"
              @click=${() => {
                this.openMenu = { ...menu, stage: 'props', targetPath: entry.path };
              }}
            >
              ${entry.label}
              ${entry.ambiguous
                ? html`<span
                    class="atl-track-warning"
                    title="Duplicate sibling name — path resolves to the first match"
                  >
                    ${this.iconService.getIcon('alert-triangle', 12)}
                  </span>`
                : null}
            </button>
          `
        )}
      `;
    }

    const target = resolveTrackTarget(host, menu.targetPath);
    const clip = this.activeClip;
    if (!target || !clip) {
      return null;
    }
    const props = this.collectAnimatableProperties(target, menu.targetPath, clip);
    return html`
      <button
        type="button"
        role="menuitem"
        class="atl-menu-back"
        @click=${() => {
          this.openMenu = { ...menu, stage: 'nodes', targetPath: '' };
        }}
      >
        ← ${menu.targetPath || '(self)'}
      </button>
      <div class="atl-menu-separator"></div>
      ${props.length > 0
        ? props.map(
            prop => html`
              <button
                type="button"
                role="menuitem"
                @click=${() => void this.onAddPropertyTrack(menu.targetPath, prop)}
              >
                ${prop.ui?.label ?? prop.name}
                <span class="atl-menu-hint">${prop.type}</span>
              </button>
            `
          )
        : html`<div class="atl-menu-heading">No animatable properties left</div>`}
    `;
  }

  private renderKeyContextMenu() {
    const ctx = this.contextKey();
    if (!ctx) {
      return null;
    }
    const isProperty = ctx.track.kind === 'property';
    const propertyKey = isProperty
      ? (ctx.track as PropertyTrack).keys.find(k => Math.abs(k.time - ctx.time) < KEY_TIME_EPSILON)
      : undefined;
    const audioKey = !isProperty
      ? (ctx.track as AudioTrack).keys.find(k => Math.abs(k.time - ctx.time) < KEY_TIME_EPSILON)
      : undefined;

    return html`
      ${isProperty && propertyKey
        ? html`
            <div class="atl-menu-heading">Easing</div>
            <select
              class="atl-select atl-menu-select"
              aria-label="Keyframe easing"
              @change=${(e: Event) =>
                void this.onContextSetEasing(
                  (e.target as HTMLSelectElement).value as KeyframeEasing
                )}
            >
              ${EASING_NAMES.map(
                name =>
                  html`<option value=${name} ?selected=${name === propertyKey.easing}>
                    ${name}
                  </option>`
              )}
            </select>
            <div class="atl-menu-heading">Value</div>
            ${this.renderKeyValueEditor(ctx.track as PropertyTrack, propertyKey)}
            <div class="atl-menu-separator"></div>
          `
        : null}
      ${audioKey
        ? html`
            <div class="atl-menu-heading">Volume</div>
            <input
              class="atl-input atl-menu-input"
              type="number"
              min="0"
              max="1"
              step="0.05"
              .value=${String(audioKey.volume)}
              aria-label="Audio key volume"
              @change=${(e: Event) =>
                void this.onContextSetAudio({
                  volume: Number((e.target as HTMLInputElement).value),
                })}
            />
            <div class="atl-menu-separator"></div>
          `
        : null}
      <button
        type="button"
        role="menuitem"
        @click=${() => void this.onContextDuplicateAtPlayhead()}
      >
        Duplicate at Playhead
      </button>
      <button
        type="button"
        role="menuitem"
        class="atl-menu-danger"
        @click=${() => void this.onContextDeleteKey()}
      >
        Delete Keyframe
      </button>
    `;
  }

  private renderKeyValueEditor(track: PropertyTrack, key: PropertyTrack['keys'][number]) {
    switch (track.valueType) {
      case 'number':
        return html`<input
          class="atl-input atl-menu-input"
          type="number"
          step="any"
          .value=${String(key.value)}
          aria-label="Keyframe value"
          @change=${(e: Event) =>
            void this.onContextSetValue(Number((e.target as HTMLInputElement).value))}
        />`;
      case 'boolean':
        return html`<label class="atl-menu-checkbox">
          <input
            type="checkbox"
            .checked=${key.value === true}
            aria-label="Keyframe value"
            @change=${(e: Event) =>
              void this.onContextSetValue((e.target as HTMLInputElement).checked)}
          />
          <span>Value</span>
        </label>`;
      case 'color':
        return html`<input
          class="atl-menu-color"
          type="color"
          .value=${typeof key.value === 'string' ? key.value : '#ffffff'}
          aria-label="Keyframe color"
          @change=${(e: Event) => void this.onContextSetValue((e.target as HTMLInputElement).value)}
        />`;
      case 'string':
        return html`<input
          class="atl-input atl-menu-input"
          type="text"
          .value=${String(key.value ?? '')}
          aria-label="Keyframe value"
          @change=${(e: Event) => void this.onContextSetValue((e.target as HTMLInputElement).value)}
        />`;
      case 'vector2':
      case 'vector3':
      case 'euler': {
        const parts = Array.isArray(key.value) ? key.value : [0, 0, 0];
        const size = track.valueType === 'vector2' ? 2 : 3;
        const labels = ['X', 'Y', 'Z'];
        return html`<div class="atl-menu-vector">
          ${Array.from({ length: size }, (_, index) => {
            return html`<label>
              <span>${labels[index]}</span>
              <input
                class="atl-input"
                type="number"
                step="any"
                .value=${String(parts[index] ?? 0)}
                aria-label="Keyframe component ${labels[index]}"
                @change=${(e: Event) => {
                  const next = [...parts] as number[];
                  next[index] = Number((e.target as HTMLInputElement).value);
                  void this.onContextSetValue(
                    (size === 2 ? [next[0], next[1]] : [next[0], next[1], next[2]]) as KeyframeValue
                  );
                }}
              />
            </label>`;
          })}
        </div>`;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Add-track data collection
  // ---------------------------------------------------------------------

  private collectTargetEntries(
    host: NodeBase
  ): Array<{ path: string; label: string; depth: number; ambiguous: boolean }> {
    const entries: Array<{ path: string; label: string; depth: number; ambiguous: boolean }> = [
      { path: '', label: `(self) ${host.name}`, depth: 0, ambiguous: false },
    ];

    const visit = (node: NodeBase, parentPath: string, depth: number): void => {
      for (const child of node.children) {
        if (!(child instanceof Object) || !('nodeId' in child)) {
          continue;
        }
        const childNode = child as NodeBase;
        const path = parentPath.length > 0 ? `${parentPath}/${childNode.name}` : childNode.name;
        const ambiguous = resolveTrackTarget(host, path) !== childNode;
        entries.push({ path, label: childNode.name, depth, ambiguous });
        visit(childNode, path, depth + 1);
      }
    };
    visit(host, '', 1);
    return entries;
  }

  private collectAnimatableProperties(
    target: NodeBase,
    targetPath: string,
    clip: KeyframeClip
  ): PropertyDefinition[] {
    const normalizedPath = targetPath.trim() === '.' ? '' : targetPath.trim();
    const tracked = new Set(
      clip.tracks
        .filter((t): t is PropertyTrack => t.kind === 'property')
        .filter(t => t.targetPath === normalizedPath)
        .map(t => t.property)
    );

    return getNodePropertySchema(target).properties.filter(prop => {
      if (!SUPPORTED_TRACK_TYPES[prop.type]) {
        return false;
      }
      if (EXCLUDED_PROPERTIES.has(prop.name) || tracked.has(prop.name)) {
        return false;
      }
      if (prop.ui?.hidden) {
        return false;
      }
      const readOnly = prop.ui?.readOnly;
      if (readOnly === true) {
        return false;
      }
      if (typeof readOnly === 'function') {
        try {
          if ((readOnly as (node: unknown) => boolean)(target)) {
            return false;
          }
        } catch {
          return false;
        }
      }
      return true;
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-animation-timeline-panel': AnimationTimelinePanel;
  }
}
