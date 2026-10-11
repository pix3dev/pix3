import { type Texture, Vector2 } from 'three';
import { Group2D, type Group2DProps } from '../Group2D';
import { Node2D } from '../../Node2D';
import { type TextureResourceRef } from '../../../core/TextureResource';
import type { PropertySchema } from '../../../fw/property-schema';
import { type InteractionDescriptor, type Interactive } from '../../../fw/interactive';
export interface ScrollContainer2DProps extends Group2DProps {
    scrollY?: number;
    dragScrollEnabled?: boolean;
    wheelScrollEnabled?: boolean;
    inertiaEnabled?: boolean;
    showScrollbar?: boolean;
    wheelSensitivity?: number;
    dragThreshold?: number;
    inertiaDamping?: number;
    scrollbarWidth?: number;
    scrollbarMinHeight?: number;
    scrollbarInset?: number;
    scrollbarColor?: string;
    scrollbarTrackColor?: string;
    scrollbarThumbTexture?: TextureResourceRef | string | null;
    scrollbarTrackTexture?: TextureResourceRef | string | null;
}
export declare class ScrollContainer2D extends Group2D implements Interactive {
    dragScrollEnabled: boolean;
    wheelScrollEnabled: boolean;
    inertiaEnabled: boolean;
    showScrollbar: boolean;
    wheelSensitivity: number;
    dragThreshold: number;
    inertiaDamping: number;
    scrollbarWidth: number;
    scrollbarMinHeight: number;
    scrollbarInset: number;
    scrollbarColor: string;
    scrollbarTrackColor: string;
    scrollbarThumbTexture: TextureResourceRef | null;
    scrollbarTrackTexture: TextureResourceRef | null;
    private _scrollY;
    private readonly tmpWorldPos;
    private readonly tmpWorldScale;
    private readonly pointerWorld;
    private readonly candidateWorld;
    /**
     * The pointer this container follows, or null when it follows none.
     * {@link SEMANTIC_POINTER_ID} while a scripted gesture is running.
     */
    private ownedPointerId;
    private readonly clippingPlanes;
    private readonly appliedClippingMaterials;
    private readonly childBasePositions;
    private dragMode;
    private pointerStartedInside;
    private pointerWasDown;
    private lastAppliedScrollY;
    private lastPointerWorldY;
    private pointerDownWorldY;
    private pointerDownScrollY;
    private scrollVelocity;
    private thumbHeight;
    private thumbCenterY;
    private trackCenterX;
    private trackGeometry;
    private thumbGeometry;
    private readonly trackMaterial;
    private readonly thumbMaterial;
    private readonly trackMesh;
    private readonly thumbMesh;
    constructor(props: ScrollContainer2DProps);
    get scrollY(): number;
    set scrollY(value: number);
    /** Assign the loaded thumb Texture (called by SceneLoader after loading). */
    setScrollbarThumbTexture(texture: Texture | null): void;
    /** Assign the loaded track Texture (called by SceneLoader after loading). */
    setScrollbarTrackTexture(texture: Texture | null): void;
    private setScrollbarThumbTextureRef;
    private setScrollbarTrackTextureRef;
    /**
     * True while this container is running a drag (content or thumb) — and therefore while every
     * descendant control is gated off, **for every finger, not just the one doing the scrolling**
     * (`UIControl2D.isPointerAllowedByAncestorScrollContainers` asks this without naming a pointer).
     * That is deliberate and matches every native scroller: while a list is being flicked, a second
     * finger landing on a row inside it must not activate the row.
     */
    hasActivePointerCapture(): boolean;
    isPointInViewportBounds(worldPoint: Vector2): boolean;
    getContentNode(): Node2D | null;
    getContentHeight(): number;
    getMaxScrollY(): number;
    tick(dt: number): void;
    /** The synthetic finger a semantic scroll interaction is currently driving, in world units. */
    private semanticPointer;
    /** Frame length the synthetic drag frames are timed with (velocity and inertia read it). */
    private static readonly SEMANTIC_FRAME_DT;
    getInteractions(): InteractionDescriptor[];
    invokeInteraction(name: string, args?: Record<string, unknown>): boolean;
    /**
     * Perform a real drag gesture: press inside the viewport, cross the drag threshold, travel, and
     * release — optionally releasing while still moving, which is what makes it a fling.
     *
     * The frames are synthesized here rather than latched across real ticks because a gesture with a
     * beginning and an end is the whole interaction; only the inertia it leaves behind belongs to the
     * frames that follow.
     *
     * Returns false when drag scrolling is switched off — the gesture genuinely cannot be delivered.
     * A container whose content already fits returns true and simply does not move, exactly like a
     * finger dragging a short list.
     */
    private dragScrollBy;
    /**
     * One synthetic frame of the scroll machine — the tick body minus advancing children and minus
     * the clipping planes, which follow the container's own transform and cannot change during a
     * gesture.
     */
    private runSemanticScrollFrame;
    static getPropertySchema(): PropertySchema;
    protected disposeResources(): void;
    private updatePointerAndScroll;
    /**
     * The pointer this frame's drag machine runs on — the one this container owns.
     *
     * - **Claim** — a pointer that is down inside the viewport (thumb included). A press that lands
     *   outside is not claimed at all, which is the old `pointerStartedInside === false` case: it can
     *   never scroll the list.
     * - **Follow** — the owned pointer is followed wherever it goes, out of the viewport included,
     *   and while it is owned no other finger exists for this container: a second finger landing in
     *   the list cannot add to the scroll or restart the threshold.
     * - **Terminal** — `'up'` is a normal release (the velocity it left behind becomes a fling);
     *   `'cancel'`, or the pointer vanishing with no terminal event at all, drops the velocity first,
     *   because an interrupted gesture must not fling the list.
     * - **Nothing owned** — one observer frame with `down` forced false, so wheel scrolling and the
     *   hover registration still work with no pointer down (the mouse case) without a stray finger
     *   outside the viewport being able to start a drag.
     */
    private resolveDrivingPointer;
    /**
     * Every pointer this container may consider this frame, in press order. Falls back to ONE
     * synthetic pointer at the shared `pointerPosition` when the addressed map is empty — see
     * {@link LEGACY_POINTER_ID}.
     */
    private collectCandidatePointers;
    /** Unproject a candidate into world units (also left in {@link candidateWorld} for hit tests). */
    private resolveCandidate;
    /** Close the gesture the way the owned pointer ended (see {@link resolveDrivingPointer}). */
    private finishOwnedPointer;
    /** The last `'up'` / `'cancel'` this frame carried for the given pointer, if any. */
    private static findTerminalEvent;
    private getScrollableChildren;
    private hasScrollableChildren;
    private applyScrollOffset;
    private syncChildBasePosition;
    private applyClippingPlanes;
    private clearClippingPlanes;
    private syncScrollbarVisuals;
    private getContentBounds;
    private getChildVerticalExtents;
    private isPointInThumbBounds;
    private static areClose;
    private static clampScroll;
    private static clampNormalizedAnchor;
}
