import { Mesh, MeshBasicMaterial, CanvasTexture, Texture, Vector2, Vector3 } from 'three';
import { Node2D, type Node2DProps } from '../../Node2D';
import type { PropertySchema } from '../../../fw/property-schema';
import type { InteractionDescriptor, Interactive } from '../../../fw/interactive';
/**
 * The pseudo-pointer a semantic interaction (agent/script `press`, `hover`, `click`) owns while it
 * holds a control. It is deliberately NOT in `InputService`'s pointer map: nothing physical is on
 * screen, `pointerDownCount` must not count it, and no other control may see it. Modelling the
 * latch as ownership of a reserved id is what lets one rule cover both channels — a control follows
 * one pointer, and this is simply which one.
 *
 * Negative so it can never collide with a DOM `pointerId`.
 */
export declare const SEMANTIC_POINTER_ID = -1;
export interface UIControl2DProps extends Node2DProps {
    enabled?: boolean;
    label?: string;
    labelKey?: string;
    labelFontFamily?: string;
    labelFontSize?: number;
    /** Numeric (400/700/900) or a CSS keyword; default `normal`. */
    labelFontWeight?: number | string;
    labelColor?: string;
    /** Caption outline half-width in px (the stroke is drawn at twice it); 0 = none. */
    labelOutlineWidth?: number;
    labelOutlineColor?: string;
    /** Drop-shadow colour; `null`/empty = no shadow. */
    labelShadowColor?: string | null;
    labelShadowOffsetX?: number;
    labelShadowOffsetY?: number;
    /** Extra px between glyphs. */
    labelLetterSpacing?: number;
    labelAlign?: 'left' | 'center' | 'right';
    texturePath?: string | null;
}
/**
 * Base class for 2D UI controls providing common functionality like:
 * - Hit testing and pointer tracking
 * - Enabled/disabled state
 * - Hover and pressed visual states
 * - Text label rendering via canvas texture
 * - Event callbacks for scripts
 *
 * ## Two kinds of signal (Godot's split)
 *
 * The signals emitted here — `pointerdown`, `pressed`, `pointerup`, `released`, `click` — are
 * POINTER signals: they report the gesture, and they are emitted *before* the control reacts to it
 * ({@link onClick} runs after `click`). So inside one of these listeners the control's own state is
 * still the pre-gesture state.
 *
 * A control whose state changes on activation therefore also emits a STATE signal of its own, after
 * the change has been applied and with the new value as its payload (`Checkbox2D` and
 * `InventorySlot2D` emit `toggled`). Game code that *applies* a control's state connects to the
 * state signal; `click` is for "the user clicked this", nothing more. Subclasses that add a state
 * signal must emit it after every write path, not just the pointer one.
 */
export declare abstract class UIControl2D extends Node2D implements Interactive {
    private _enabled;
    private _label;
    private _labelKey;
    private _labelFontFamily;
    private _labelFontSize;
    private _labelColor;
    private _labelAlign;
    private _labelFontWeight;
    private _labelOutlineWidth;
    private _labelOutlineColor;
    private _labelShadowColor;
    private _labelShadowOffsetX;
    private _labelShadowOffsetY;
    private _labelLetterSpacing;
    /**
     * True once the constructor has finished, so setters know whether a re-render is safe: during
     * construction subclass fields (`size`, skin meshes) are not in place yet, and the base
     * constructor already ends with one deliberate `updateLabel()`.
     */
    private labelReactive;
    texturePath: string | null;
    get label(): string;
    set label(value: string);
    /** Localization key; when non-empty and localization is active, its translation replaces `label`. */
    get labelKey(): string;
    set labelKey(value: string);
    get labelFontFamily(): string;
    set labelFontFamily(value: string);
    get labelFontSize(): number;
    set labelFontSize(value: number);
    get labelColor(): string;
    set labelColor(value: string);
    get labelFontWeight(): number | string;
    set labelFontWeight(value: number | string);
    get labelOutlineWidth(): number;
    set labelOutlineWidth(value: number);
    get labelOutlineColor(): string;
    set labelOutlineColor(value: string);
    get labelShadowColor(): string | null;
    set labelShadowColor(value: string | null);
    get labelShadowOffsetX(): number;
    set labelShadowOffsetX(value: number);
    get labelShadowOffsetY(): number;
    set labelShadowOffsetY(value: number);
    get labelLetterSpacing(): number;
    set labelLetterSpacing(value: number);
    get labelAlign(): 'left' | 'center' | 'right';
    set labelAlign(value: 'left' | 'center' | 'right');
    /**
     * Re-render the label unless we are still inside a constructor. The equality guards on each setter
     * mean a script assigning the same text every frame costs nothing; a real change rebuilds the
     * canvas texture once.
     */
    private refreshLabelIfReactive;
    protected isHovering: boolean;
    protected isPressed: boolean;
    protected tmpWorldPos: Vector3;
    onHoverEnter?: () => void;
    onHoverExit?: () => void;
    onPressed?: () => void;
    onReleased?: () => void;
    protected labelMesh: Mesh | null;
    protected labelTexture: CanvasTexture | null;
    protected skinTexture: Texture | null;
    private readonly skinMaterials;
    constructor(props: UIControl2DProps, nodeType: string);
    protected disposeResources(): void;
    get enabled(): boolean;
    set enabled(value: boolean);
    /**
     * Called when the enabled state changes after construction.
     * Subclasses override to update their visuals (e.g. a disabled skin).
     */
    protected onEnabledChanged(_enabled: boolean): void;
    protected registerSkinMaterial(material: MeshBasicMaterial): void;
    protected applySkinTexture(texture: Texture | null): void;
    private tryLoadTextureFromPath;
    /**
     * Check if a world position is within the control bounds.
     * Subclasses should override for custom hit shapes.
     */
    protected isPointInBounds(_worldPoint: Vector2): boolean;
    /**
     * Poll the pointer this control owns and feed {@link updatePointerState}. This is the ONE entry
     * point every interactive control uses from its `tick` — `Checkbox2D`, `Slider2D` and
     * `InventorySlot2D` used to poll `input.isPointerDown` themselves with their own
     * `isPointInBounds` call, which meant no lifecycle signals, no hover tracking and, worst, no
     * ancestor-scroll gate (a scroll drag passing over a checkbox toggled it). Concentrating the poll
     * here is what made pointer *ownership* a two-file change instead of a seven-file one.
     *
     * ## Ownership, in one place
     *
     * A control follows **at most one pointer** ({@link ownedPointerId}) and, while it owns one, the
     * others do not exist for it — a second finger inside a held button is ignored, and can only be
     * claimed once the first one is gone. That is what makes "hold the stick with one thumb, tap fire
     * with the other" work; reading a single global `isPointerDown` made every control on screen
     * react to every finger anywhere.
     *
     * - **Claim** — free control + a pointer that is *down* + its world point inside
     *   {@link isPointInBounds}. Deliberately the down **state**, not a down **event**: that is what
     *   preserves the slide-in press (a finger that wanders onto a button presses it).
     * - **Follow** — the owned pointer is followed wherever it goes; whether leaving the bounds
     *   cancels the press is {@link capturesPointer}'s call, exactly as before.
     * - **Terminal** — `'up'` releases (and clicks, if it ended in bounds); `'cancel'`, or the
     *   pointer vanishing with no terminal event at all, cancels and can never click.
     *
     * Returns false when there is no input service or no resolvable pointer position.
     */
    protected updatePointerStateFromInput(): boolean;
    /**
     * Every pointer this control may consider this frame, in press order.
     *
     * When the addressed map is empty the control falls back to ONE synthetic pointer at the shared
     * `pointerPosition` carrying `isPointerDown`. Two things need that: a mouse hovering with nothing
     * down (which the map, by construction, never holds), and the long-standing habit of tests and
     * harnesses driving controls by assigning `isPointerDown` / `pointerPosition` directly. It is
     * given a reserved negative id so it can be owned and followed like any other pointer without
     * ever colliding with a real `pointerId`.
     */
    private collectCandidatePointers;
    /** Unproject a candidate's screen coordinates into world units. */
    private resolveCandidate;
    /** The first pointer that satisfies the claim rule: down, and inside this control's bounds. */
    private findClaimingPointer;
    /**
     * Take (or keep) ownership of a pointer and run one frame of the funnel with it.
     *
     * Ownership lasts exactly as long as the press: once {@link isPressed} is false the control has
     * stopped following anything, so it lets the pointer go and is free to claim again next tick.
     * That is what keeps two long-standing behaviours intact — a non-capturing control loses the
     * gesture when the finger slides off (and re-presses if it slides back on), and a cancelled
     * interaction does not silently keep a claim alive.
     */
    private driveWithPointer;
    /**
     * The owned pointer is no longer down. Close the interaction the way the pointer ended:
     *
     * - `'up'` → a real release, at the coordinates the release happened (so `click` fires only when
     *   it ended inside the bounds);
     * - `'cancel'` → {@link cancelPointerInteraction}, never a click;
     * - **no terminal event at all** → also a cancel. A pointer that evaporates (input lock, a
     *   detach, a lost frame) is exactly the case where treating silence as a release invents a click
     *   the user never made.
     */
    private finishOwnedPointer;
    /** The last `'up'` / `'cancel'` this frame carried for the given pointer, if any. */
    private findTerminalEvent;
    /**
     * No pointer was claimed, so run one frame with `down` forced false: hover still has to enter and
     * leave, but nothing may press. Prefers a pointer over the control (that is what hover is about)
     * and otherwise takes the first, so a hover that walked away is cleared.
     */
    private observeWithoutOwnership;
    /**
     * The pointer this control follows, or null when it follows none. {@link SEMANTIC_POINTER_ID}
     * while a semantic interaction holds it — the latch IS ownership of a reserved pseudo-pointer,
     * which is why a real finger cannot quietly drive the control alongside it.
     */
    private ownedPointerId;
    /** Which pointer the frame currently being fed belongs to (for hover attribution). */
    private currentPointerId;
    /** Scratch for candidate unprojection; never handed out, only read within a call. */
    private readonly candidateWorld;
    /**
     * A synthetic pointer held on this control by a semantic interaction, in world units. Null while
     * the control is driven by real input (the normal case).
     */
    private semanticPointer;
    /** True while a semantic interaction is holding this control (press/hover, until released). */
    protected get hasSemanticPointerHold(): boolean;
    /**
     * The world point a semantic interaction pretends the finger is at: the control's own origin.
     * Subclasses that address a position *within* themselves (a slider addressing a value) compute
     * their own point instead — always from their transform, never from a real pointer.
     */
    protected getSemanticPointerPoint(target?: Vector2): Vector2;
    /**
     * Feed ONE frame of a synthetic pointer through {@link updatePointerState} — the same funnel a
     * real finger drives, with the same `enabled` check, ancestor-scroll gate, skin state changes and
     * signal order. This is the only way a semantic interaction is allowed to reach a control.
     *
     * `latch` keeps the synthetic pointer alive for subsequent frames (a hold); without it the
     * control returns to real input immediately after this frame.
     *
     * Returns false when the funnel would reject the frame outright — disabled, or an ancestor scroll
     * container has claimed the gesture — so an interaction can report the refusal instead of
     * pretending it happened.
     */
    protected runSemanticPointerFrame(point: Vector2, down: boolean, latch: boolean): boolean;
    /**
     * Whether the funnel would accept a synthetic frame at `point` — the gates that make a semantic
     * invocation fail honestly rather than silently do nothing.
     *
     * Visibility belongs here and not in the "bypassed" column: the semantic channel exists to skip
     * ONE premise, that a finger can physically reach the control on screen. Whether the control is
     * on screen *at all* is a different claim, and a `click` that reports success on a control inside
     * a hidden panel would let an agent walk through a menu the player cannot open.
     */
    protected canAcceptSemanticPointer(point?: Vector2): boolean;
    /** Drop any semantic hold and return the control to real input. */
    protected clearSemanticPointer(): void;
    /**
     * The interactions every UI control offers. Subclasses append their own
     * (`super.getInteractions()` first, so the base set keeps its order).
     */
    getInteractions(): InteractionDescriptor[];
    invokeInteraction(name: string, args?: Record<string, unknown>): boolean;
    /**
     * Interaction dispatch. Subclasses override, handle their own names and delegate the rest here —
     * an unknown name returns false rather than throwing, because a listing is a promise about this
     * frame and an agent may hold a stale one.
     */
    protected performInteraction(name: string, _args?: Record<string, unknown>): boolean;
    /**
     * A complete activation: press frame then release frame, both through the funnel. Emits exactly
     * `pointerdown` → `pressed` → `pointerup` → `released` → `click` and runs {@link onClick},
     * because it IS the same code path a tap runs, one frame after the other.
     */
    protected runSemanticClick(point?: Vector2): boolean;
    /**
     * Update hover and pressed states based on pointer input, emit the lifecycle signals
     * (`pointerdown` / `pressed` / `pointerup` / `released` / `click`) and call the subclass hooks
     * ({@link onHover}, {@link onPress}, {@link onClick}, {@link onPointerDrag}).
     */
    protected updatePointerState(pointerWorldX: number, pointerWorldY: number, isDown: boolean): void;
    /**
     * Drop hover and press because the control stopped accepting input mid-way: it was disabled, or
     * an ancestor scroll container took the gesture. A cancellation is not a completed interaction,
     * so it emits no signals at all (not even `released`) — same as sliding a press off a button has
     * always done. The `onReleased` callback still runs so visuals can return to rest.
     */
    protected cancelPointerInteraction(): void;
    /**
     * Called when hover state changes. Override in subclasses.
     */
    protected onHover(_isHovering: boolean): void;
    /**
     * Called when pressed state changes. Override in subclasses.
     */
    protected onPress(_isPressed: boolean): void;
    /**
     * Called on a completed activation: released inside the bounds, immediately after the `click`
     * signal was emitted. Controls that DO something on activation (checkbox toggle, inventory slot
     * select) override this instead of re-running their own hit test, so the action can never
     * disagree with the signal listeners saw.
     *
     * The order is deliberate and is the reason for the state-signal rule in the class docs: `click`
     * is dispatched first, so a `click` listener observes the state as it was BEFORE this hook runs.
     */
    protected onClick(): void;
    /**
     * Called every frame the control is held down, with the current pointer position — including
     * frames where the pointer is outside the bounds if {@link capturesPointer} is true.
     */
    protected onPointerDrag(_pointerWorld: Vector2): void;
    /**
     * Whether a press owns the pointer until it is released. Value-dragging controls return true;
     * click-style controls (buttons, checkboxes, slots) leave it false so sliding off cancels.
     */
    protected capturesPointer(): boolean;
    private isPointerAllowedByAncestorScrollContainers;
    /**
     * Create a canvas-based texture for a text label
     */
    protected createLabelTexture(text: string, width?: number, height?: number): CanvasTexture;
    /**
     * The text actually rendered: the translation of `labelKey` (falling back to the literal `label`)
     * when a key is set and localization is active, otherwise the literal `label`. Public so the
     * editor's viewport label proxies paint the same resolved text as the runtime (no drift).
     */
    getDisplayText(): string;
    /** Re-render the label after a locale switch (used by the localization tree walk). */
    refreshLocalizedLabel(): void;
    /**
     * Update the label display
     */
    protected updateLabel(): void;
    /**
     * Default property schema for UI controls
     */
    static getPropertySchema(): PropertySchema;
}
