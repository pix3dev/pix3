import { Node2D, type Node2DProps } from '../../Node2D';
import type { PropertySchema } from '../../../fw/property-schema';
import { type InteractionDescriptor, type Interactive } from '../../../fw/interactive';
export interface Joystick2DProps extends Node2DProps {
    enabled?: boolean;
    radius?: number;
    handleRadius?: number;
    axisHorizontal?: string;
    axisVertical?: string;
    baseColor?: string;
    handleColor?: string;
    floating?: boolean;
}
export declare class Joystick2D extends Node2D implements Interactive {
    private static readonly BASE_OPACITY;
    private static readonly HANDLE_OPACITY;
    private static readonly FADE_SPEED;
    enabled: boolean;
    radius: number;
    handleRadius: number;
    axisHorizontal: string;
    axisVertical: string;
    baseColor: string;
    handleColor: string;
    floating: boolean;
    private baseMesh;
    private handleMesh;
    private baseMaterial;
    private handleMaterial;
    private isDragging;
    private inputVector;
    private authoredLocalPosition;
    private dragCenterWorld;
    private visibilityAlpha;
    private visibilityTarget;
    private tmpWorldPos;
    private pendingResetAfterHide;
    /**
     * The pointer this joystick follows, or null when it follows none.
     * {@link SEMANTIC_POINTER_ID} while `setStick` holds it — the latch IS ownership of a reserved
     * pseudo-pointer, which is why a real finger cannot quietly drive the stick alongside it.
     */
    private ownedPointerId;
    /**
     * Whether the un-addressed pointer was down on the previous tick. The addressed channel gets a
     * real `'down'` frame event; the legacy one has none, so its rising edge stands in for one.
     */
    private legacyPointerWasDown;
    /** Scratch for candidate unprojection; never handed out, only read within a call. */
    private readonly candidateWorld;
    constructor(props: Joystick2DProps);
    tick(dt: number): void;
    /**
     * Follow exactly one pointer — the one that started this drag — from claim to terminal.
     *
     * ## Ownership
     *
     * - **Claim** ({@link findClaimingPointer}) — a *fixed* stick takes any pointer that is down
     *   inside its base (a state, not an event, so a finger that wanders onto the base still takes the
     *   stick, as it always has). A *floating* stick takes a pointer whose `'down'` landed **this
     *   frame** and that is not over UI, asked per pointer via `isPointerOverUI(id)`. That last part
     *   is the whole fix: gating on the `isHoveringUI` aggregate made "hold a button with one thumb,
     *   plant the stick with the other" impossible, because the button's own hover blocked the stick.
     * - **Follow** — while owned, every other pointer is invisible to this joystick, so a second
     *   finger landing in the base cannot disturb the axes and two sticks can be driven at once.
     * - **Terminal** — see {@link finishOwnedPointer}.
     */
    private updateFromPointers;
    /**
     * Every pointer this joystick may consider this frame, in press order. Falls back to ONE synthetic
     * pointer at the shared `pointerPosition` when the addressed map is empty — see
     * {@link LEGACY_POINTER_ID}.
     */
    private collectCandidatePointers;
    /** The first pointer that may start a drag on this joystick this frame (see {@link updateFromPointers}). */
    private findClaimingPointer;
    private static hasDownEventThisFrame;
    /** Whether a world point is inside the base circle — the fixed stick's claim area. */
    private isWithinBase;
    /**
     * One frame of the drag machine with a pointer this joystick owns (or is claiming). The single
     * body both channels run: a real finger's tick, and the synthetic frames `setStick` pushes
     * through, take exactly the same path.
     */
    private driveDragFrame;
    /** Summon a floating stick under the finger that just landed. */
    private beginFloatingDrag;
    /** Deflect the stick towards the owned pointer: from the drag centre when floating, else from self. */
    private continueDrag;
    /**
     * The owned pointer is gone from the map. `'up'` is a normal release, `'cancel'` — and a pointer
     * that vanished with no terminal event at all (input lock, detach, a lost frame) — is a
     * cancellation. A stick ends the same way for all three, and that identity is the invariant, not
     * an oversight: a finger dragged off the edge of the screen must return the axes to neutral, or
     * the character it was steering runs forever. (The distinction matters where a terminal can
     * *produce* something — a click — which a joystick has none of.)
     */
    private finishOwnedPointer;
    /** Stop following anything and return the stick to rest. */
    private releaseDrag;
    /** Drop a drag the joystick may no longer run at all (it was disabled mid-gesture). */
    private abortDrag;
    /** Direction names `setStick` accepts, mapped to unit vectors (+y is up, as in world space). */
    private static readonly DIRECTIONS;
    /** The synthetic finger holding the stick, in world units, or null under real input. */
    private semanticPointer;
    getInteractions(): InteractionDescriptor[];
    invokeInteraction(name: string, args?: Record<string, unknown>): boolean;
    /** `dir` as a unit vector: a named direction, or an angle in degrees (0 = right, CCW). */
    private resolveDirection;
    /**
     * Put a finger on the stick and move it — two synthetic frames through the same drag machine a
     * touch drives, because that is the gesture: the press has to land inside the base (that is what
     * starts the drag, and what a press outside the radius correctly fails to do) before the travel
     * can be clamped to the radius and turned into axis values.
     *
     * The hold is latched, so the axes stay pushed across the frames that follow — a stick is held,
     * not tapped — until `releaseStick`.
     */
    private pushStick;
    /**
     * One synthetic frame of the drag machine, owned by {@link SEMANTIC_POINTER_ID}. Latching IS
     * taking ownership of that pseudo-pointer, which is what keeps the stick pushed across the ticks
     * that follow, and what makes "only a finger that would claim this joystick evicts it" the single
     * rule covering both channels.
     */
    private runSemanticStickFrame;
    /** Lift the finger off the stick through the machine's own release path. */
    private releaseStick;
    private updateHandleAndAxes;
    private endDrag;
    private updateVisibility;
    private applyVisibility;
    private setCenterFromWorld;
    static getPropertySchema(): PropertySchema;
}
