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
 * InputService - Central hub for handling user input.
 * Manages virtual axes, buttons, and raw pointer events.
 */
export declare class InputService {
    private axes;
    private buttons;
    /**
     * Position of the **primary** pointer (the oldest one still down); while no
     * pointer is down it follows hover moves, as it always has. Addressed
     * per-pointer positions live in {@link getActivePointers}/{@link getPointer}.
     */
    readonly pointerPosition: Vector2;
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
    isPointerDown: boolean;
    /**
     * The primary (oldest still-down) pointer, or `null` when nothing is down.
     *
     * @deprecated Multi-touch made "the" pointer ambiguous. Use the addressed API
     * ({@link getActivePointers}, {@link getPointer}, {@link pointerDownCount},
     * {@link isPointerOverUI}) — a control must follow the finger that started on
     * it, not whichever finger happens to be primary this frame. Still maintained.
     */
    activePointerId: number | null;
    wheelDelta: Vector2;
    pointerEvents: readonly InputPointerFrameEvent[];
    keyEvents: readonly InputKeyFrameEvent[];
    width: number;
    height: number;
    private hoveredUIElements;
    private hoveredUIPointers;
    /**
     * Every pointer that is currently down, keyed by `pointerId`, in **press
     * order** — `Map` iteration order is insertion order, so the first entry is
     * the oldest pointer and therefore the primary one. This map is the single
     * source of truth; `isPointerDown` / `activePointerId` / `pointerPosition`
     * are derived from it.
     */
    private readonly activePointers;
    private readonly pendingWheelDelta;
    private pendingPointerEvents;
    private pendingKeyEvents;
    private element;
    private previousTouchAction;
    /**
     * Depth-counted input lock. While > 0 the DOM handlers early-return so the
     * whole polled-input surface (`getAxis`/`getButton`/`pointerEvents`/
     * `pointerPosition`, and every UI control that polls it) goes quiet without
     * any per-consumer change. Used by the Cutscene Director to freeze gameplay
     * input during a cinematic. Nested locks stack; only the 0→1 transition
     * clears transient state.
     */
    private lockDepth;
    /**
     * Names passed to {@link getAxis}/{@link getButton} while a harness recording
     * is active, or `null` when nobody is recording — which is the normal state.
     *
     * `null` and not an always-present empty Set on purpose: the getters run from
     * every script on every tick, so the disabled cost has to be a single
     * reference check with no `Set.add`, no allocation and no growth.
     */
    private polledActions;
    private pollsTruncated;
    private lockedDuringPollWindow;
    /**
     * Resets frame-based input state. Should be called at the start of each frame.
     */
    beginFrame(): void;
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
    registerHover(id: string, pointerId?: number): void;
    /**
     * Returns true if any UI element is currently hovered.
     *
     * Aggregate over every pointer. Gating a gesture on this is what makes
     * "hold a button with one thumb, drag the stick with the other" impossible —
     * for that, ask {@link isPointerOverUI} about *your* finger.
     */
    get isHoveringUI(): boolean;
    /** True when the given pointer is over a UI control this frame. */
    isPointerOverUI(pointerId: number): boolean;
    /** Every pointer currently down, in press order (index 0 is the primary one). */
    getActivePointers(): readonly PointerSnapshot[];
    /** The given pointer if it is down right now, otherwise `null`. */
    getPointer(pointerId: number): PointerSnapshot | null;
    /** How many pointers are down right now. */
    get pointerDownCount(): number;
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
    lock(): void;
    /**
     * Drop every pointer that is down: release its capture and, when
     * `emitEvents`, queue a `'cancel'` frame event for it. Used by {@link lock},
     * {@link detach} and the window blur handler — the three ways a press can end
     * without the DOM ever delivering a `pointerup`.
     */
    private cancelActivePointers;
    /**
     * Release every keyboard-derived button (`Key_*`, set by {@link onKeyDown}).
     * Custom, script-set virtual buttons are left untouched — the lock only
     * silences raw DOM input.
     */
    private clearHeldKeyButtons;
    /**
     * Release one level of the input lock (floored at 0). Input flows again once
     * the depth returns to 0.
     */
    unlock(): void;
    /** True while the input lock is held (depth > 0). */
    get isLocked(): boolean;
    /**
     * Set a virtual axis value (e.g. from a specialized controller or script).
     * @param name Name of the axis (e.g. "Horizontal", "Vertical")
     * @param value Value typically between -1 and 1
     */
    setAxis(name: string, value: number): void;
    /**
     * Get a virtual axis value.
     * @param name Name of the axis
     * @returns The current value of the axis, or 0 if not set
     */
    getAxis(name: string): number;
    /**
     * Set a virtual button state.
     * @param name Name of the button (e.g. "Jump", "Fire")
     * @param pressed Whether the button is pressed
     */
    setButton(name: string, pressed: boolean): void;
    /**
     * Get a virtual button state.
     * @param name Name of the button
     * @returns True if the button is currently pressed
     */
    getButton(name: string): boolean;
    /**
     * Start (or restart) recording which actions the game polls. Clears whatever
     * a previous window collected, so each window reports only its own calls.
     *
     * Test-harness instrumentation, not a gameplay feature: leave it off in a
     * shipped game (that is also the only state with zero cost — see
     * {@link polledActions}).
     */
    startPollRecording(): void;
    /** Stop recording and release the accumulated names. Idempotent. */
    stopPollRecording(): void;
    /** True while a recording window is open. */
    get isPollRecording(): boolean;
    /** Read the window so far without disturbing it. */
    getObservedPolls(): ObservedPollsSnapshot;
    /**
     * Read the window and clear it, leaving recording ON — the call a harness
     * makes between two input steps to attribute polls to the step that caused
     * them. Use {@link stopPollRecording} to end recording entirely.
     */
    takeObservedPolls(): ObservedPollsSnapshot;
    private recordPoll;
    /**
     * Attach global event listeners to a DOM element.
     * Monitors pointer events to update raw pointer state and trigger global actions.
     * @param element The DOM element (usually canvas) to listen to
     */
    attach(element: HTMLElement): void;
    /**
     * Remove global event listeners.
     */
    detach(): void;
    private onPointerDown;
    private onPointerMove;
    private onPointerUp;
    private onPointerCancel;
    /**
     * `pointerleave` for a pointer that is down means the gesture left the canvas
     * (finger dragged off the edge of the screen — constant on mobile), which is a
     * cancellation, not a completed tap. For an untracked pointer it is just the
     * mouse leaving the element: nothing to end.
     */
    private onPointerLeave;
    private onWindowBlur;
    private endPointer;
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
    private syncDerivedPointerState;
    /**
     * Pointer capture is best-effort. Real user gestures always have a live pointer, but synthetic
     * PointerEvents (automation, tests, or an agent harness driving the canvas) do not, so the DOM
     * throws `NotFoundError: No active pointer with the given id` — which would otherwise surface
     * as an uncaught runtime error during play. Capture failing is harmless: pointer tracking still
     * works from the event stream; capture only keeps events flowing during an out-of-bounds drag.
     */
    private capturePointer;
    private releasePointer;
    private onContextMenu;
    private onWheel;
    private onKeyDown;
    private onKeyUp;
    /**
     * Event coordinates in input units (and a refresh of `width`/`height`).
     *
     * Does not touch {@link pointerPosition}: with several pointers alive, only
     * the caller knows whether this event belongs to the primary one.
     */
    private computePointerPosition;
    private getInputDimensions;
}
