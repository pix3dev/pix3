import { Vector2 } from 'three';

export interface InputPointerFrameEvent {
  /**
   * `'cancel'` is deliberately NOT folded into `'up'`: a pointer that was taken
   * away (finger dragged off the screen edge, `pointercancel`, an input lock or
   * the window losing focus mid-press) must not read as a completed press. They
   * used to be the same event, which is why a finger slid off the edge of the
   * screen over a button still *clicked* it.
   */
  type: 'down' | 'move' | 'up' | 'cancel';
  pointerId: number;
  x: number;
  y: number;
}

/**
 * One pointer that is currently down, in the same units as
 * {@link InputService.pointerPosition}.
 *
 * `isPrimary` is *ours*, not the DOM's: the primary pointer is the oldest one
 * still down (the first entry of the active-pointer map), so when the first
 * finger lifts the next one inherits the role. The DOM's `PointerEvent.isPrimary`
 * would keep pointing at a finger that is already gone.
 */
export interface PointerSnapshot {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly isPrimary: boolean;
}

/** Internal, mutable counterpart of {@link PointerSnapshot}. */
interface TrackedPointer {
  pointerId: number;
  x: number;
  y: number;
  isPrimary: boolean;
}

export interface InputKeyFrameEvent {
  type: 'down' | 'up';
  code: string;
  key: string;
  repeat: boolean;
}

/**
 * What the game asked the input layer for during a recording window.
 *
 * Deliberately named "observed **polls**": it records only that `getAxis` /
 * `getButton` were *called* with these names — it is an **observation, not proof
 * that any input was handled**. Proof that an input did something is an assert
 * on its effect. What it does close, in one line, is the class of agent flailing
 * where the harness presses `Key_ArrowLeft` while the game only ever polls
 * `Key_KeyA` / `Key_KeyD`.
 */
export interface ObservedPollsSnapshot {
  /** Action/axis names the game polled during the window (insertion-ordered). */
  observedPolls: string[];
  /** True when the input lock is held right now — nothing reaches the game at all. */
  locked: boolean;
  /**
   * True when the lock was held at any point during the window. Separates
   * "the game is not listening for that action" from "input was frozen", which
   * look identical from an empty/short poll list.
   */
  lockedDuringWindow: boolean;
  /** True when the name cap was hit and later distinct names were dropped. */
  truncated: boolean;
}

/**
 * Cap on distinct polled names kept per window. A game that polls generated
 * names (`Key_${i}`) must not grow this set without bound; 64 is far past what
 * any real control scheme uses.
 */
const MAX_OBSERVED_POLLS = 64;

/**
 * InputService - Central hub for handling user input.
 * Manages virtual axes, buttons, and raw pointer events.
 */
export class InputService {
  private axes = new Map<string, number>();
  private buttons = new Map<string, boolean>();

  /**
   * Position of the **primary** pointer (the oldest one still down); while no
   * pointer is down it follows hover moves, as it always has. Addressed
   * per-pointer positions live in {@link getActivePointers}/{@link getPointer}.
   */
  public readonly pointerPosition = new Vector2();

  /**
   * True while **any** pointer is down — "the map is not empty", not "the primary
   * pointer is down". With one finger the two are the same sentence, which is why
   * this stayed compatible through the multi-touch migration; with two they are
   * not, and this is the reading that matches every other multi-touch API.
   *
   * It is a *summary*, not a handle: it cannot tell you which finger, or how many.
   * Anything that has to follow one finger reads the addressed API instead
   * ({@link getActivePointers}, {@link getPointer}, {@link pointerDownCount}) —
   * inside the runtime nothing polls this flag to decide ownership any more.
   *
   * Kept as a writable field rather than a getter because it is a long-standing
   * part of the public surface that tests and harnesses assign to directly; it
   * is a *mirror* of {@link activePointers}, recomputed on every pointer event,
   * so an external write only survives until the next one.
   */
  public isPointerDown = false;

  /**
   * The primary (oldest still-down) pointer, or `null` when nothing is down.
   *
   * @deprecated Multi-touch made "the" pointer ambiguous. Use the addressed API
   * ({@link getActivePointers}, {@link getPointer}, {@link pointerDownCount},
   * {@link isPointerOverUI}) — a control must follow the finger that started on
   * it, not whichever finger happens to be primary this frame. Still maintained.
   */
  public activePointerId: number | null = null;

  public wheelDelta = new Vector2();
  public pointerEvents: readonly InputPointerFrameEvent[] = [];
  public keyEvents: readonly InputKeyFrameEvent[] = [];

  public width = 0;
  public height = 0;

  private hoveredUIElements = new Set<string>();
  private hoveredUIPointers = new Set<number>();

  /**
   * Every pointer that is currently down, keyed by `pointerId`, in **press
   * order** — `Map` iteration order is insertion order, so the first entry is
   * the oldest pointer and therefore the primary one. This map is the single
   * source of truth; `isPointerDown` / `activePointerId` / `pointerPosition`
   * are derived from it.
   */
  private readonly activePointers = new Map<number, TrackedPointer>();

  private readonly pendingWheelDelta = new Vector2();
  private pendingPointerEvents: InputPointerFrameEvent[] = [];
  private pendingKeyEvents: InputKeyFrameEvent[] = [];

  private element: HTMLElement | null = null;
  private previousTouchAction: string | null = null;

  /**
   * Depth-counted input lock. While > 0 the DOM handlers early-return so the
   * whole polled-input surface (`getAxis`/`getButton`/`pointerEvents`/
   * `pointerPosition`, and every UI control that polls it) goes quiet without
   * any per-consumer change. Used by the Cutscene Director to freeze gameplay
   * input during a cinematic. Nested locks stack; only the 0→1 transition
   * clears transient state.
   */
  private lockDepth = 0;

  /**
   * Names passed to {@link getAxis}/{@link getButton} while a harness recording
   * is active, or `null` when nobody is recording — which is the normal state.
   *
   * `null` and not an always-present empty Set on purpose: the getters run from
   * every script on every tick, so the disabled cost has to be a single
   * reference check with no `Set.add`, no allocation and no growth.
   */
  private polledActions: Set<string> | null = null;
  private pollsTruncated = false;
  private lockedDuringPollWindow = false;

  /**
   * Resets frame-based input state. Should be called at the start of each frame.
   */
  beginFrame(): void {
    this.hoveredUIElements.clear();
    this.hoveredUIPointers.clear();
    this.wheelDelta.copy(this.pendingWheelDelta);
    this.pendingWheelDelta.set(0, 0);
    this.pointerEvents = this.pendingPointerEvents;
    this.pendingPointerEvents = [];
    this.keyEvents = this.pendingKeyEvents;
    this.pendingKeyEvents = [];
  }

  /**
   * Registers that a UI element is currently being hovered by a pointer.
   *
   * @param id Node id of the hovered control.
   * @param pointerId Which pointer is over it. Omitted (the legacy call), it is
   *   attributed to the primary pointer if one is down — which is exactly what
   *   an un-migrated control means, since it hit-tests against
   *   {@link pointerPosition}. With nothing down (mouse hover) there is no
   *   pointer to attribute it to and only the {@link isHoveringUI} aggregate moves.
   */
  registerHover(id: string, pointerId?: number): void {
    this.hoveredUIElements.add(id);
    const attributed = pointerId ?? this.activePointerId;
    if (attributed !== null && attributed !== undefined) {
      this.hoveredUIPointers.add(attributed);
    }
  }

  /**
   * Returns true if any UI element is currently hovered.
   *
   * Aggregate over every pointer. Gating a gesture on this is what makes
   * "hold a button with one thumb, drag the stick with the other" impossible —
   * for that, ask {@link isPointerOverUI} about *your* finger.
   */
  get isHoveringUI(): boolean {
    return this.hoveredUIElements.size > 0;
  }

  /** True when the given pointer is over a UI control this frame. */
  isPointerOverUI(pointerId: number): boolean {
    return this.hoveredUIPointers.has(pointerId);
  }

  // -- addressed pointer access (multi-touch) ------------------------------------

  /** Every pointer currently down, in press order (index 0 is the primary one). */
  getActivePointers(): readonly PointerSnapshot[] {
    return [...this.activePointers.values()];
  }

  /** The given pointer if it is down right now, otherwise `null`. */
  getPointer(pointerId: number): PointerSnapshot | null {
    return this.activePointers.get(pointerId) ?? null;
  }

  /** How many pointers are down right now. */
  get pointerDownCount(): number {
    return this.activePointers.size;
  }

  /**
   * Acquire the input lock (depth-counted). On the 0→1 transition, force-release
   * all transient input state so nothing stays "held" behind the lock: cancel
   * (not "release" — see {@link InputPointerFrameEvent}) every pointer that is
   * down, clear `isPointerDown`/`activePointerId`, drop the `Action_Primary`
   * button and every held `Key_*` button, and empty the pending pointer/key/wheel
   * queues. Clearing the held keys is what makes gameplay
   * actually go quiet (a movement key held at lock time would otherwise keep
   * polling `true`), and it prevents a key *released* during the lock — whose
   * keyup the guards swallow — from sticking `true` after {@link unlock}. Keys
   * physically still held re-assert via OS key-repeat after unlock.
   */
  lock(): void {
    this.lockDepth += 1;
    // Remember the lock even if it is released before the window is read: an
    // empty poll list under a lock means "input was frozen", not "the game is
    // not listening", and those two demand opposite fixes.
    if (this.polledActions !== null) this.lockedDuringPollWindow = true;
    if (this.lockDepth !== 1) {
      return;
    }
    this.pendingPointerEvents = [];
    this.pendingKeyEvents = [];
    this.pendingWheelDelta.set(0, 0);
    this.wheelDelta.set(0, 0);
    // Cancel *after* emptying the queues: dropping the queued gesture is the
    // point of the lock, but a control holding a finger still has to hear that
    // the finger went away, or it stays pressed for as long as the lock lasts.
    this.cancelActivePointers(true);
    this.isPointerDown = false;
    this.activePointerId = null;
    this.setButton('Action_Primary', false);
    this.clearHeldKeyButtons();
  }

  /**
   * Drop every pointer that is down: release its capture and, when
   * `emitEvents`, queue a `'cancel'` frame event for it. Used by {@link lock},
   * {@link detach} and the window blur handler — the three ways a press can end
   * without the DOM ever delivering a `pointerup`.
   */
  private cancelActivePointers(emitEvents: boolean): void {
    for (const pointer of this.activePointers.values()) {
      this.releasePointer(pointer.pointerId);
      if (emitEvents) {
        this.pendingPointerEvents.push({
          type: 'cancel',
          pointerId: pointer.pointerId,
          x: pointer.x,
          y: pointer.y,
        });
      }
    }
    this.activePointers.clear();
    this.syncDerivedPointerState();
  }

  /**
   * Release every keyboard-derived button (`Key_*`, set by {@link onKeyDown}).
   * Custom, script-set virtual buttons are left untouched — the lock only
   * silences raw DOM input.
   */
  private clearHeldKeyButtons(): void {
    for (const name of this.buttons.keys()) {
      if (name.startsWith('Key_')) {
        this.buttons.set(name, false);
      }
    }
  }

  /**
   * Release one level of the input lock (floored at 0). Input flows again once
   * the depth returns to 0.
   */
  unlock(): void {
    if (this.lockDepth > 0) {
      this.lockDepth -= 1;
    }
  }

  /** True while the input lock is held (depth > 0). */
  get isLocked(): boolean {
    return this.lockDepth > 0;
  }

  /**
   * Set a virtual axis value (e.g. from a specialized controller or script).
   * @param name Name of the axis (e.g. "Horizontal", "Vertical")
   * @param value Value typically between -1 and 1
   */
  setAxis(name: string, value: number): void {
    this.axes.set(name, value);
  }

  /**
   * Get a virtual axis value.
   * @param name Name of the axis
   * @returns The current value of the axis, or 0 if not set
   */
  getAxis(name: string): number {
    if (this.polledActions !== null) this.recordPoll(name);
    return this.axes.get(name) || 0;
  }

  /**
   * Set a virtual button state.
   * @param name Name of the button (e.g. "Jump", "Fire")
   * @param pressed Whether the button is pressed
   */
  setButton(name: string, pressed: boolean): void {
    this.buttons.set(name, pressed);
  }

  /**
   * Get a virtual button state.
   * @param name Name of the button
   * @returns True if the button is currently pressed
   */
  getButton(name: string): boolean {
    if (this.polledActions !== null) this.recordPoll(name);
    return this.buttons.get(name) || false;
  }

  // -- harness poll observation (plan §5.1 / §6 rule 5) --------------------------

  /**
   * Start (or restart) recording which actions the game polls. Clears whatever
   * a previous window collected, so each window reports only its own calls.
   *
   * Test-harness instrumentation, not a gameplay feature: leave it off in a
   * shipped game (that is also the only state with zero cost — see
   * {@link polledActions}).
   */
  startPollRecording(): void {
    this.polledActions = new Set();
    this.pollsTruncated = false;
    this.lockedDuringPollWindow = this.lockDepth > 0;
  }

  /** Stop recording and release the accumulated names. Idempotent. */
  stopPollRecording(): void {
    this.polledActions = null;
    this.pollsTruncated = false;
    this.lockedDuringPollWindow = false;
  }

  /** True while a recording window is open. */
  get isPollRecording(): boolean {
    return this.polledActions !== null;
  }

  /** Read the window so far without disturbing it. */
  getObservedPolls(): ObservedPollsSnapshot {
    return {
      observedPolls: this.polledActions ? [...this.polledActions] : [],
      locked: this.lockDepth > 0,
      lockedDuringWindow: this.lockedDuringPollWindow || this.lockDepth > 0,
      truncated: this.pollsTruncated,
    };
  }

  /**
   * Read the window and clear it, leaving recording ON — the call a harness
   * makes between two input steps to attribute polls to the step that caused
   * them. Use {@link stopPollRecording} to end recording entirely.
   */
  takeObservedPolls(): ObservedPollsSnapshot {
    const snapshot = this.getObservedPolls();
    if (this.polledActions !== null) {
      this.polledActions.clear();
      this.pollsTruncated = false;
      this.lockedDuringPollWindow = this.lockDepth > 0;
    }
    return snapshot;
  }

  private recordPoll(name: string): void {
    const polled = this.polledActions;
    if (!polled || polled.has(name)) return;
    if (polled.size >= MAX_OBSERVED_POLLS) {
      this.pollsTruncated = true;
      return;
    }
    polled.add(name);
  }

  /**
   * Attach global event listeners to a DOM element.
   * Monitors pointer events to update raw pointer state and trigger global actions.
   * @param element The DOM element (usually canvas) to listen to
   */
  attach(element: HTMLElement): void {
    this.detach(); // detach previous if any
    this.element = element;
    this.previousTouchAction = element.style.touchAction;
    element.style.touchAction = 'none';

    // Initialize dimensions
    const dimensions = this.getInputDimensions();
    this.width = dimensions.width;
    this.height = dimensions.height;
    console.log(`[InputService] Attached to element. Dimensions: ${this.width}x${this.height}`);

    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerCancel);
    element.addEventListener('pointerleave', this.onPointerLeave);
    element.addEventListener('wheel', this.onWheel, { passive: false });

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // Alt-tab / app switch / OS notification: the press never gets a pointerup,
    // so without this every finger held at that moment stays down forever.
    window.addEventListener('blur', this.onWindowBlur);

    // Prevent context menu on right click for better game experience
    element.addEventListener('contextmenu', this.onContextMenu);
  }

  /**
   * Remove global event listeners.
   */
  detach(): void {
    if (!this.element) return;

    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('pointercancel', this.onPointerCancel);
    this.element.removeEventListener('pointerleave', this.onPointerLeave);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);

    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);

    // Release captures before the element goes away. No frame events: nobody is
    // left to read them and the queues are emptied right below.
    this.cancelActivePointers(false);

    if (this.previousTouchAction !== null) {
      this.element.style.touchAction = this.previousTouchAction;
      this.previousTouchAction = null;
    }

    this.element = null;
    this.isPointerDown = false;
    this.activePointerId = null;
    this.wheelDelta.set(0, 0);
    this.pendingWheelDelta.set(0, 0);
    this.pointerEvents = [];
    this.pendingPointerEvents = [];
    this.keyEvents = [];
    this.pendingKeyEvents = [];
    this.setButton('Action_Primary', false);
    // Never leak a lock into the next scene — the InputService instance is
    // reused across play/stop cycles (a stopped cutscene must not keep the
    // next run muted). Harness poll recording goes with it, for the same
    // reason: a window that outlived its scene would attribute the next run's
    // polls to the previous one.
    this.lockDepth = 0;
    this.stopPollRecording();
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.lockDepth > 0) {
      return;
    }
    // A second `pointerdown` for a pointer that is already tracked is not a real
    // gesture (only synthetic events do it) and would corrupt press order.
    if (this.activePointers.has(event.pointerId)) {
      return;
    }

    const position = this.computePointerPosition(event);
    const wasIdle = this.activePointers.size === 0;
    this.activePointers.set(event.pointerId, {
      pointerId: event.pointerId,
      x: position.x,
      y: position.y,
      isPrimary: wasIdle,
    });
    this.syncDerivedPointerState();
    this.pendingPointerEvents.push({
      type: 'down',
      pointerId: event.pointerId,
      x: position.x,
      y: position.y,
    });
    this.capturePointer(event.pointerId);

    // Global "Tap to Action": `Action_Primary` stays a single shared flag meaning
    // "at least one pointer is down", so it is raised on the 0→1 transition only
    // and released by the last pointer to leave (see `endPointer`).
    if (wasIdle) {
      this.setButton('Action_Primary', true);
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.lockDepth > 0) {
      return;
    }

    const tracked = this.activePointers.get(event.pointerId);
    const position = this.computePointerPosition(event);
    if (!tracked) {
      // Hover: with nothing down, the shared position follows the mouse (as it
      // always has). With something down it must not be yanked away by a
      // hovering device that is not part of the gesture.
      if (this.activePointers.size === 0) {
        this.pointerPosition.set(position.x, position.y);
      }
      return;
    }

    tracked.x = position.x;
    tracked.y = position.y;
    if (tracked.isPrimary) {
      this.pointerPosition.set(position.x, position.y);
    }
    this.pendingPointerEvents.push({
      type: 'move',
      pointerId: event.pointerId,
      x: position.x,
      y: position.y,
    });
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.endPointer(event, 'up');
  };

  private onPointerCancel = (event: PointerEvent): void => {
    this.endPointer(event, 'cancel');
  };

  /**
   * `pointerleave` for a pointer that is down means the gesture left the canvas
   * (finger dragged off the edge of the screen — constant on mobile), which is a
   * cancellation, not a completed tap. For an untracked pointer it is just the
   * mouse leaving the element: nothing to end.
   */
  private onPointerLeave = (event: PointerEvent): void => {
    this.endPointer(event, 'cancel');
  };

  private onWindowBlur = (): void => {
    if (this.activePointers.size === 0) {
      return;
    }
    this.cancelActivePointers(true);
    this.setButton('Action_Primary', false);
  };

  private endPointer(event: PointerEvent, type: 'up' | 'cancel'): void {
    if (this.lockDepth > 0) {
      return;
    }
    const tracked = this.activePointers.get(event.pointerId);
    if (!tracked) {
      return;
    }

    const position = this.computePointerPosition(event);
    if (tracked.isPrimary) {
      this.pointerPosition.set(position.x, position.y);
    }
    this.activePointers.delete(event.pointerId);
    // Promotes the next-oldest pointer to primary (and re-points
    // `pointerPosition` at it) when the primary is the one that just left.
    this.syncDerivedPointerState();
    this.pendingPointerEvents.push({
      type,
      pointerId: event.pointerId,
      x: position.x,
      y: position.y,
    });
    this.releasePointer(event.pointerId);

    if (this.activePointers.size === 0) {
      this.setButton('Action_Primary', false);
    }
  }

  /**
   * Re-derive the shared, non-addressed state from the pointer map: which
   * pointer is primary, `isPointerDown`, `activePointerId` and — while anything
   * is down — `pointerPosition`. With the map empty the position is left where
   * it was, so a mouse keeps its last known spot after a click, as before.
   *
   * The three derived values answer three different questions on purpose, and
   * only one of them is about "the" pointer:
   *
   * - `isPointerDown` — **any** finger (map size), see its docs;
   * - `activePointerId` — the primary one, `@deprecated` but still maintained;
   * - `pointerPosition` — the primary one's position, because a single `Vector2`
   *   can only ever hold one finger's coordinates. Everything that needs another
   *   finger's position asks {@link getPointer} for it.
   */
  private syncDerivedPointerState(): void {
    let primary: TrackedPointer | null = null;
    for (const pointer of this.activePointers.values()) {
      const isPrimary = primary === null;
      pointer.isPrimary = isPrimary;
      if (isPrimary) primary = pointer;
    }
    this.isPointerDown = this.activePointers.size > 0;
    this.activePointerId = primary ? primary.pointerId : null;
    if (primary) {
      this.pointerPosition.set(primary.x, primary.y);
    }
  }

  /**
   * Pointer capture is best-effort. Real user gestures always have a live pointer, but synthetic
   * PointerEvents (automation, tests, or an agent harness driving the canvas) do not, so the DOM
   * throws `NotFoundError: No active pointer with the given id` — which would otherwise surface
   * as an uncaught runtime error during play. Capture failing is harmless: pointer tracking still
   * works from the event stream; capture only keeps events flowing during an out-of-bounds drag.
   */
  private capturePointer(pointerId: number): void {
    try {
      this.element?.setPointerCapture?.(pointerId);
    } catch {
      // No live pointer (synthetic event) — safe to ignore.
    }
  }

  private releasePointer(pointerId: number): void {
    try {
      this.element?.releasePointerCapture?.(pointerId);
    } catch {
      // Capture was never established or already released — safe to ignore.
    }
  }

  private onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private onWheel = (event: WheelEvent): void => {
    // Still swallow the gesture while locked (the page must not scroll behind
    // a cutscene), but accumulate nothing.
    event.preventDefault();
    if (this.lockDepth > 0) {
      return;
    }
    this.pendingWheelDelta.x += event.deltaX;
    this.pendingWheelDelta.y += event.deltaY;
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.lockDepth > 0) {
      return;
    }
    this.setButton(`Key_${event.code}`, true);
    this.setButton(`Key_${event.key.toUpperCase()}`, true);
    this.pendingKeyEvents.push({
      type: 'down',
      code: event.code,
      key: event.key,
      repeat: event.repeat,
    });
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (this.lockDepth > 0) {
      return;
    }
    this.setButton(`Key_${event.code}`, false);
    this.setButton(`Key_${event.key.toUpperCase()}`, false);
    this.pendingKeyEvents.push({
      type: 'up',
      code: event.code,
      key: event.key,
      repeat: event.repeat,
    });
  };

  /**
   * Event coordinates in input units (and a refresh of `width`/`height`).
   *
   * Does not touch {@link pointerPosition}: with several pointers alive, only
   * the caller knows whether this event belongs to the primary one.
   */
  private computePointerPosition(event: PointerEvent): { x: number; y: number } {
    if (!this.element) {
      return { x: this.pointerPosition.x, y: this.pointerPosition.y };
    }

    // Calculate position relative to the element
    const rect = this.element.getBoundingClientRect();
    const dimensions = this.getInputDimensions();
    this.width = dimensions.width;
    this.height = dimensions.height;

    const safeRectWidth = rect.width > 0 ? rect.width : 1;
    const safeRectHeight = rect.height > 0 ? rect.height : 1;
    const scaleX = this.width / safeRectWidth;
    const scaleY = this.height / safeRectHeight;

    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;

    return { x, y };
  }

  private getInputDimensions(): { width: number; height: number } {
    if (!this.element) {
      return { width: 0, height: 0 };
    }

    if (this.element instanceof HTMLCanvasElement) {
      const canvasWidth = this.element.width;
      const canvasHeight = this.element.height;
      if (canvasWidth > 0 && canvasHeight > 0) {
        return { width: canvasWidth, height: canvasHeight };
      }
    }

    const rect = this.element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }
}
