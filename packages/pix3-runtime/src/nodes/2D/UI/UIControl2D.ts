import {
  Mesh,
  MeshBasicMaterial,
  CanvasTexture,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  PlaneGeometry,
} from 'three';
import { Node2D, type Node2DProps } from '../../Node2D';
import { configure2DTexture } from '../../../core/configure-2d-texture';
import { resolveLocalizedText } from '../../../core/localization/active-localization';
import type { PropertySchema } from '../../../fw/property-schema';
import type { InteractionDescriptor, Interactive } from '../../../fw/interactive';
import type { InputPointerFrameEvent, InputService } from '../../../core/InputService';
import { ScrollContainer2D } from './ScrollContainer2D';

/**
 * The pseudo-pointer a semantic interaction (agent/script `press`, `hover`, `click`) owns while it
 * holds a control. It is deliberately NOT in `InputService`'s pointer map: nothing physical is on
 * screen, `pointerDownCount` must not count it, and no other control may see it. Modelling the
 * latch as ownership of a reserved id is what lets one rule cover both channels — a control follows
 * one pointer, and this is simply which one.
 *
 * Negative so it can never collide with a DOM `pointerId`.
 */
export const SEMANTIC_POINTER_ID = -1;

/**
 * The stand-in for the shared, un-addressed pointer (`isPointerDown` + `pointerPosition`) used when
 * the addressed map is empty. See {@link UIControl2D.collectCandidatePointers}.
 */
const LEGACY_POINTER_ID = -2;

/** A pointer a control may consider this frame, in input/screen units. */
interface CandidatePointer {
  pointerId: number;
  x: number;
  y: number;
  down: boolean;
}

/** A {@link CandidatePointer} with its position unprojected into 2D world units. */
interface ResolvedPointer {
  pointerId: number;
  down: boolean;
  worldX: number;
  worldY: number;
}

export interface UIControl2DProps extends Node2DProps {
  enabled?: boolean;
  label?: string;
  labelKey?: string;
  labelFontFamily?: string;
  labelFontSize?: number;
  labelColor?: string;
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
export abstract class UIControl2D extends Node2D implements Interactive {
  // Control state
  private _enabled: boolean = true;
  // Label state is exposed through accessors that re-render on change. As plain fields these were a
  // trap: the inspector wrote them through a schema `setValue` that called `updateLabel()` by hand,
  // so authoring worked, while a script's `btn.label = 'X'` changed the field and drew nothing —
  // `getDisplayText()` (and therefore the agent's `game_observe.text`) reported the new text that
  // was never on screen. Setters keep the two paths from diverging.
  private _label: string;
  private _labelKey: string;
  private _labelFontFamily: string;
  private _labelFontSize: number;
  private _labelColor: string;
  private _labelAlign: 'left' | 'center' | 'right';
  /**
   * True once the constructor has finished, so setters know whether a re-render is safe: during
   * construction subclass fields (`size`, skin meshes) are not in place yet, and the base
   * constructor already ends with one deliberate `updateLabel()`.
   */
  private labelReactive = false;
  texturePath: string | null;

  get label(): string {
    return this._label;
  }

  set label(value: string) {
    if (this._label === value) return;
    this._label = value;
    this.refreshLabelIfReactive();
  }

  /** Localization key; when non-empty and localization is active, its translation replaces `label`. */
  get labelKey(): string {
    return this._labelKey;
  }

  set labelKey(value: string) {
    if (this._labelKey === value) return;
    this._labelKey = value;
    this.refreshLabelIfReactive();
  }

  get labelFontFamily(): string {
    return this._labelFontFamily;
  }

  set labelFontFamily(value: string) {
    if (this._labelFontFamily === value) return;
    this._labelFontFamily = value;
    this.refreshLabelIfReactive();
  }

  get labelFontSize(): number {
    return this._labelFontSize;
  }

  set labelFontSize(value: number) {
    if (this._labelFontSize === value) return;
    this._labelFontSize = value;
    this.refreshLabelIfReactive();
  }

  get labelColor(): string {
    return this._labelColor;
  }

  set labelColor(value: string) {
    if (this._labelColor === value) return;
    this._labelColor = value;
    this.refreshLabelIfReactive();
  }

  get labelAlign(): 'left' | 'center' | 'right' {
    return this._labelAlign;
  }

  set labelAlign(value: 'left' | 'center' | 'right') {
    if (this._labelAlign === value) return;
    this._labelAlign = value;
    this.refreshLabelIfReactive();
  }

  /**
   * Re-render the label unless we are still inside a constructor. The equality guards on each setter
   * mean a script assigning the same text every frame costs nothing; a real change rebuilds the
   * canvas texture once.
   */
  private refreshLabelIfReactive(): void {
    if (this.labelReactive) {
      this.updateLabel();
    }
  }

  // Pointer state
  protected isHovering: boolean = false;
  protected isPressed: boolean = false;
  protected tmpWorldPos = new Vector3();

  // Event callbacks (can be registered by scripts)
  onHoverEnter?: () => void;
  onHoverExit?: () => void;
  onPressed?: () => void;
  onReleased?: () => void;

  // Label mesh (created on demand)
  protected labelMesh: Mesh | null = null;
  protected labelTexture: CanvasTexture | null = null;
  protected skinTexture: Texture | null = null;
  private readonly skinMaterials: Set<MeshBasicMaterial> = new Set();

  constructor(props: UIControl2DProps, nodeType: string) {
    super(props, nodeType);

    this._enabled = props.enabled ?? true;
    // Backing fields, not the setters: nothing is renderable yet this early.
    this._label = props.label ?? '';
    this._labelKey = props.labelKey ?? '';
    this._labelFontFamily = props.labelFontFamily ?? 'Arial';
    this._labelFontSize = props.labelFontSize ?? 16;
    this._labelColor = props.labelColor ?? '#ffffff';
    this._labelAlign = props.labelAlign ?? 'center';
    this.texturePath = props.texturePath ?? null;

    if (this.texturePath) {
      this.tryLoadTextureFromPath(this.texturePath);
    }

    if (this._label.trim().length > 0 || this._labelKey.length > 0) {
      this.updateLabel();
    }
    // From here on, a label assignment re-renders — including from a subclass constructor, which
    // runs after this one and therefore has its own props in place.
    this.labelReactive = true;
  }

  protected override disposeResources(): void {
    // Generic pass frees geometry + per-instance skin materials on child meshes.
    super.disposeResources();
    // labelTexture is a canvas-backed texture owned by this node (material.dispose
    // does not free it). Skin textures are intentionally left alone: they may come
    // from the shared AssetLoader cache and are not safe to dispose here.
    this.labelTexture?.dispose();
    this.labelTexture = null;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    const next = Boolean(value);
    if (this._enabled === next) {
      return;
    }
    this._enabled = next;
    this.onEnabledChanged(next);
  }

  /**
   * Called when the enabled state changes after construction.
   * Subclasses override to update their visuals (e.g. a disabled skin).
   */
  protected onEnabledChanged(_enabled: boolean): void {
    // Default: no visual change
  }

  protected registerSkinMaterial(material: MeshBasicMaterial): void {
    this.registerOpacityMaterial(material);
    this.skinMaterials.add(material);
    if (this.skinTexture) {
      material.map = this.skinTexture;
      material.color.set('#ffffff');
      material.transparent = true;
      material.needsUpdate = true;
    }
  }

  protected applySkinTexture(texture: Texture | null): void {
    this.skinTexture = texture;
    for (const material of this.skinMaterials) {
      material.map = texture;
      if (texture) {
        material.color.set('#ffffff');
        material.transparent = true;
      }
      material.needsUpdate = true;
    }
  }

  private tryLoadTextureFromPath(path: string): void {
    const schemeMatch = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(path);
    const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
    if (!(scheme === '' || scheme === 'http' || scheme === 'https')) {
      return;
    }

    const loader = new TextureLoader();
    loader.load(
      path,
      texture => {
        configure2DTexture(texture);
        this.applySkinTexture(texture);
      },
      undefined,
      () => {
        // keep fallback flat color visuals
      }
    );
  }

  /**
   * Check if a world position is within the control bounds.
   * Subclasses should override for custom hit shapes.
   */
  protected isPointInBounds(_worldPoint: Vector2): boolean {
    // Default: check against bounding box
    // Subclasses override with custom shapes (circle, rectangle, etc.)
    return false;
  }

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
  protected updatePointerStateFromInput(): boolean {
    const input = this.input;

    // A latched semantic pointer stands in for a finger that is still on the control: a real hold
    // re-asserts itself every frame, so the latch has to as well, or the very next tick would read
    // an (up, elsewhere) physical pointer and cancel the press.
    const latched = this.semanticPointer;
    if (latched) {
      const candidates = input ? this.collectCandidatePointers(input) : null;
      // Under multi-touch, "any real finger wins" is wrong: a thumb on the joystick would drop a
      // button's semantic hold, i.e. the agent's press of *this* control would be cancelled by an
      // input aimed somewhere else entirely. Only a finger that would claim THIS control — a press
      // inside its own bounds — is a genuine conflict, so only that evicts the latch.
      const claimant = candidates ? this.findClaimingPointer(candidates) : null;
      if (!claimant) {
        this.currentPointerId = SEMANTIC_POINTER_ID;
        this.updatePointerState(latched.x, latched.y, latched.down);
        this.currentPointerId = null;
        return true;
      }
      this.semanticPointer = null;
      this.ownedPointerId = null;
      return this.driveWithPointer(claimant);
    }

    if (!input) return false;
    const candidates = this.collectCandidatePointers(input);

    const owned = this.ownedPointerId;
    if (owned !== null) {
      const current = candidates.find(candidate => candidate.pointerId === owned);
      if (current) {
        const resolved = this.resolveCandidate(current);
        return resolved ? this.driveWithPointer(resolved) : false;
      }
      return this.finishOwnedPointer(owned);
    }

    const claimant = this.findClaimingPointer(candidates);
    if (claimant) return this.driveWithPointer(claimant);

    return this.observeWithoutOwnership(candidates);
  }

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
  private collectCandidatePointers(input: InputService): CandidatePointer[] {
    const active = input.getActivePointers();
    if (active.length > 0) {
      return active.map(pointer => ({
        pointerId: pointer.pointerId,
        x: pointer.x,
        y: pointer.y,
        down: true,
      }));
    }
    return [
      {
        pointerId: LEGACY_POINTER_ID,
        x: input.pointerPosition.x,
        y: input.pointerPosition.y,
        down: input.isPointerDown,
      },
    ];
  }

  /** Unproject a candidate's screen coordinates into world units. */
  private resolveCandidate(candidate: CandidatePointer): ResolvedPointer | null {
    const world = this.screenPointToWorld(candidate.x, candidate.y, this.candidateWorld);
    if (!world) return null;
    return {
      pointerId: candidate.pointerId,
      down: candidate.down,
      worldX: world.x,
      worldY: world.y,
    };
  }

  /** The first pointer that satisfies the claim rule: down, and inside this control's bounds. */
  private findClaimingPointer(candidates: readonly CandidatePointer[]): ResolvedPointer | null {
    for (const candidate of candidates) {
      if (!candidate.down) continue;
      const resolved = this.resolveCandidate(candidate);
      if (!resolved) return null;
      if (this.isPointInBounds(this.candidateWorld)) return resolved;
    }
    return null;
  }

  /**
   * Take (or keep) ownership of a pointer and run one frame of the funnel with it.
   *
   * Ownership lasts exactly as long as the press: once {@link isPressed} is false the control has
   * stopped following anything, so it lets the pointer go and is free to claim again next tick.
   * That is what keeps two long-standing behaviours intact — a non-capturing control loses the
   * gesture when the finger slides off (and re-presses if it slides back on), and a cancelled
   * interaction does not silently keep a claim alive.
   */
  private driveWithPointer(pointer: ResolvedPointer): boolean {
    this.ownedPointerId = pointer.pointerId;
    this.currentPointerId = pointer.pointerId;
    this.updatePointerState(pointer.worldX, pointer.worldY, pointer.down);
    if (this.ownedPointerId !== SEMANTIC_POINTER_ID && !this.isPressed) {
      this.ownedPointerId = null;
    }
    return true;
  }

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
  private finishOwnedPointer(ownedPointerId: number): boolean {
    const terminal = this.findTerminalEvent(ownedPointerId);
    this.ownedPointerId = null;
    this.currentPointerId = null;
    if (terminal?.type === 'up') {
      const world = this.screenPointToWorld(terminal.x, terminal.y, this.candidateWorld);
      if (world) {
        this.currentPointerId = ownedPointerId;
        this.updatePointerState(world.x, world.y, false);
        this.currentPointerId = null;
        return true;
      }
    }
    this.cancelPointerInteraction();
    return true;
  }

  /** The last `'up'` / `'cancel'` this frame carried for the given pointer, if any. */
  private findTerminalEvent(pointerId: number): InputPointerFrameEvent | null {
    const events = this.input?.pointerEvents;
    if (!events) return null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.pointerId !== pointerId) continue;
      if (event.type === 'up' || event.type === 'cancel') return event;
    }
    return null;
  }

  /**
   * No pointer was claimed, so run one frame with `down` forced false: hover still has to enter and
   * leave, but nothing may press. Prefers a pointer over the control (that is what hover is about)
   * and otherwise takes the first, so a hover that walked away is cleared.
   */
  private observeWithoutOwnership(candidates: readonly CandidatePointer[]): boolean {
    let chosen: ResolvedPointer | null = null;
    for (const candidate of candidates) {
      const resolved = this.resolveCandidate(candidate);
      if (!resolved) continue;
      if (this.isPointInBounds(this.candidateWorld)) {
        chosen = resolved;
        break;
      }
      chosen ??= resolved;
    }
    if (!chosen) return false;
    this.currentPointerId = chosen.pointerId;
    this.updatePointerState(chosen.worldX, chosen.worldY, false);
    this.currentPointerId = null;
    return true;
  }

  /**
   * The pointer this control follows, or null when it follows none. {@link SEMANTIC_POINTER_ID}
   * while a semantic interaction holds it — the latch IS ownership of a reserved pseudo-pointer,
   * which is why a real finger cannot quietly drive the control alongside it.
   */
  private ownedPointerId: number | null = null;

  /** Which pointer the frame currently being fed belongs to (for hover attribution). */
  private currentPointerId: number | null = null;

  /** Scratch for candidate unprojection; never handed out, only read within a call. */
  private readonly candidateWorld = new Vector2();

  /**
   * A synthetic pointer held on this control by a semantic interaction, in world units. Null while
   * the control is driven by real input (the normal case).
   */
  private semanticPointer: { x: number; y: number; down: boolean } | null = null;

  /** True while a semantic interaction is holding this control (press/hover, until released). */
  protected get hasSemanticPointerHold(): boolean {
    return this.semanticPointer !== null;
  }

  /**
   * The world point a semantic interaction pretends the finger is at: the control's own origin.
   * Subclasses that address a position *within* themselves (a slider addressing a value) compute
   * their own point instead — always from their transform, never from a real pointer.
   */
  protected getSemanticPointerPoint(target: Vector2 = new Vector2()): Vector2 {
    this.getWorldPosition(this.tmpWorldPos);
    return target.set(this.tmpWorldPos.x, this.tmpWorldPos.y);
  }

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
  protected runSemanticPointerFrame(point: Vector2, down: boolean, latch: boolean): boolean {
    if (!this.canAcceptSemanticPointer(point)) {
      return false;
    }
    // Latching IS taking ownership of the semantic pseudo-pointer; an unlatched frame hands the
    // control straight back to real input, so it must not keep a claim of any kind.
    this.semanticPointer = latch ? { x: point.x, y: point.y, down } : null;
    this.ownedPointerId = latch ? SEMANTIC_POINTER_ID : null;
    this.currentPointerId = SEMANTIC_POINTER_ID;
    this.updatePointerState(point.x, point.y, down);
    this.currentPointerId = null;
    return true;
  }

  /**
   * Whether the funnel would accept a synthetic frame at `point` — the gates that make a semantic
   * invocation fail honestly rather than silently do nothing.
   *
   * Visibility belongs here and not in the "bypassed" column: the semantic channel exists to skip
   * ONE premise, that a finger can physically reach the control on screen. Whether the control is
   * on screen *at all* is a different claim, and a `click` that reports success on a control inside
   * a hidden panel would let an agent walk through a menu the player cannot open.
   */
  protected canAcceptSemanticPointer(point: Vector2 = this.getSemanticPointerPoint()): boolean {
    return (
      this.enabled &&
      this.isVisibleInTree() &&
      this.isPointerAllowedByAncestorScrollContainers(point)
    );
  }

  /** Drop any semantic hold and return the control to real input. */
  protected clearSemanticPointer(): void {
    this.semanticPointer = null;
    if (this.ownedPointerId === SEMANTIC_POINTER_ID) {
      this.ownedPointerId = null;
    }
  }

  /**
   * The interactions every UI control offers. Subclasses append their own
   * (`super.getInteractions()` first, so the base set keeps its order).
   */
  getInteractions(): InteractionDescriptor[] {
    return [
      { name: 'hover', description: 'Rest the pointer on the control (stays hovered)' },
      { name: 'press', description: 'Press and hold the control' },
      { name: 'release', description: 'Release a held press' },
      { name: 'click', description: 'Press and release inside the control' },
    ];
  }

  invokeInteraction(name: string, args?: Record<string, unknown>): boolean {
    return this.performInteraction(name, args);
  }

  /**
   * Interaction dispatch. Subclasses override, handle their own names and delegate the rest here —
   * an unknown name returns false rather than throwing, because a listing is a promise about this
   * frame and an agent may hold a stale one.
   */
  protected performInteraction(name: string, _args?: Record<string, unknown>): boolean {
    switch (name) {
      case 'hover':
        // Latched, no button: a mouse parked on the control, which is what makes a hover visual
        // observable at all (it would otherwise be gone by the next tick).
        return this.runSemanticPointerFrame(this.getSemanticPointerPoint(), false, true);
      case 'press':
        return this.runSemanticPointerFrame(this.getSemanticPointerPoint(), true, true);
      case 'release':
        return this.runSemanticPointerFrame(this.getSemanticPointerPoint(), false, false);
      case 'click':
        return this.runSemanticClick();
      default:
        return false;
    }
  }

  /**
   * A complete activation: press frame then release frame, both through the funnel. Emits exactly
   * `pointerdown` → `pressed` → `pointerup` → `released` → `click` and runs {@link onClick},
   * because it IS the same code path a tap runs, one frame after the other.
   */
  protected runSemanticClick(point: Vector2 = this.getSemanticPointerPoint()): boolean {
    if (!this.runSemanticPointerFrame(point, true, true)) {
      return false;
    }
    return this.runSemanticPointerFrame(point, false, false);
  }

  /**
   * Update hover and pressed states based on pointer input, emit the lifecycle signals
   * (`pointerdown` / `pressed` / `pointerup` / `released` / `click`) and call the subclass hooks
   * ({@link onHover}, {@link onPress}, {@link onClick}, {@link onPointerDrag}).
   */
  protected updatePointerState(
    pointerWorldX: number,
    pointerWorldY: number,
    isDown: boolean
  ): void {
    // A disabled control accepts nothing and must not stay stuck in a state it can no longer
    // leave, so drop hover/press instead of freezing them mid-interaction.
    if (!this.enabled) {
      this.cancelPointerInteraction();
      return;
    }

    // Hiding a panel has to make its controls inert, and nothing upstream does that for us:
    // `NodeBase.tick` recurses into invisible children on purpose (components on a hidden node keep
    // running), and three.js only skips the subtree when it RENDERS. Without this gate a button
    // under a hidden overlay still hovers, presses and clicks — and registers a hover, so
    // `isPointerOverUI` reports the finger as being over UI that nobody can see. That is not
    // hypothetical: a hidden end-screen sits over the middle of the playfield in every scene built
    // from the game recipes, and a drag across it opened its menu button mid-run.
    if (!this.isVisibleInTree()) {
      this.cancelPointerInteraction();
      return;
    }

    const pointerPos = new Vector2(pointerWorldX, pointerWorldY);
    // An ancestor scroll container that has claimed the gesture (or that clipped us out of its
    // viewport) takes the pointer away unconditionally — a list scroll beats the control under the
    // finger, including a capturing one, the way every native scroller behaves.
    if (!this.isPointerAllowedByAncestorScrollContainers(pointerPos)) {
      this.cancelPointerInteraction();
      return;
    }

    const isInBounds = this.isPointInBounds(pointerPos);
    // While a capturing control is held (a slider being dragged), leaving the bounds must not
    // cancel the press — the drag follows the finger past the track's edge, like every native
    // slider. Non-capturing controls keep the old "slide off to cancel" behaviour.
    const captured = this.isPressed && this.capturesPointer();

    // Handle hover state
    if (isInBounds && !this.isHovering) {
      this.isHovering = true;
      this.onHoverEnter?.();
      this.onHover(true);
    } else if (!isInBounds && this.isHovering) {
      this.isHovering = false;
      this.onHoverExit?.();
      this.onHover(false);
      if (this.isPressed && !captured) {
        this.isPressed = false;
        this.onReleased?.();
        this.onPress(false);
      }
    }

    if (this.isHovering && this.input) {
      // Attribute the hover to the finger that produced it, so `isPointerOverUI(id)` can answer
      // per-pointer — the whole point being that a thumb on a joystick is not "over UI" just
      // because another finger rests on a button. Pseudo-pointers (semantic latch, the legacy
      // un-addressed pointer) carry no real id, so they fall back to the aggregate.
      const pointerId = this.currentPointerId;
      if (pointerId !== null && pointerId >= 0) {
        this.input.registerHover(this.nodeId, pointerId);
      } else {
        this.input.registerHover(this.nodeId);
      }
    }

    // Handle pressed state
    if (isInBounds && isDown && !this.isPressed) {
      this.isPressed = true;
      this.emit('pointerdown');
      this.emit('pressed');
      this.onPressed?.();
      this.onPress(true);
    } else if (!isDown && this.isPressed) {
      this.isPressed = false;
      this.emit('pointerup');
      this.emit('released');
      if (isInBounds) {
        this.emit('click');
      }
      this.onReleased?.();
      this.onPress(false);
      if (isInBounds) {
        this.onClick();
      }
    }

    if (this.isPressed && isDown) {
      this.onPointerDrag(pointerPos);
    }
  }

  /**
   * Drop hover and press because the control stopped accepting input mid-way: it was disabled, or
   * an ancestor scroll container took the gesture. A cancellation is not a completed interaction,
   * so it emits no signals at all (not even `released`) — same as sliding a press off a button has
   * always done. The `onReleased` callback still runs so visuals can return to rest.
   */
  protected cancelPointerInteraction(): void {
    // A cancelled interaction also ends a semantic hold — a finger taken off the control by a
    // scroll gate does not come back when the gate lifts, and neither should this. Ownership goes
    // with it: the control is following nothing, and may claim a pointer again next tick.
    this.semanticPointer = null;
    this.ownedPointerId = null;
    if (this.isHovering) {
      this.isHovering = false;
      this.onHoverExit?.();
      this.onHover(false);
    }
    if (this.isPressed) {
      this.isPressed = false;
      this.onReleased?.();
      this.onPress(false);
    }
  }

  /**
   * Called when hover state changes. Override in subclasses.
   */
  protected onHover(_isHovering: boolean): void {
    // Default: no visual change
  }

  /**
   * Called when pressed state changes. Override in subclasses.
   */
  protected onPress(_isPressed: boolean): void {
    // Default: no visual change
  }

  /**
   * Called on a completed activation: released inside the bounds, immediately after the `click`
   * signal was emitted. Controls that DO something on activation (checkbox toggle, inventory slot
   * select) override this instead of re-running their own hit test, so the action can never
   * disagree with the signal listeners saw.
   *
   * The order is deliberate and is the reason for the state-signal rule in the class docs: `click`
   * is dispatched first, so a `click` listener observes the state as it was BEFORE this hook runs.
   */
  protected onClick(): void {
    // Default: nothing beyond the click signal
  }

  /**
   * Called every frame the control is held down, with the current pointer position — including
   * frames where the pointer is outside the bounds if {@link capturesPointer} is true.
   */
  protected onPointerDrag(_pointerWorld: Vector2): void {
    // Default: presses carry no continuous value
  }

  /**
   * Whether a press owns the pointer until it is released. Value-dragging controls return true;
   * click-style controls (buttons, checkboxes, slots) leave it false so sliding off cancels.
   */
  protected capturesPointer(): boolean {
    return false;
  }

  private isPointerAllowedByAncestorScrollContainers(pointerPos: Vector2): boolean {
    let currentParent = this.parent;
    while (currentParent) {
      if (currentParent instanceof ScrollContainer2D) {
        if (
          !currentParent.isPointInViewportBounds(pointerPos) ||
          currentParent.hasActivePointerCapture()
        ) {
          return false;
        }
      }
      currentParent = currentParent.parent;
    }

    return true;
  }

  /**
   * Create a canvas-based texture for a text label
   */
  protected createLabelTexture(
    text: string,
    width: number = 256,
    height: number = 64
  ): CanvasTexture {
    const dprRaw = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const dpr = Math.max(1, Math.min(3, dprRaw));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas 2D context');

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, width, height);

    // Draw text
    ctx.fillStyle = this.labelColor;
    ctx.font = `${this.labelFontSize}px ${this.labelFontFamily}`;
    ctx.textBaseline = 'middle';

    let x = width / 2;
    if (this.labelAlign === 'left') {
      ctx.textAlign = 'left';
      x = 10;
    } else if (this.labelAlign === 'right') {
      ctx.textAlign = 'right';
      x = width - 10;
    } else {
      ctx.textAlign = 'center';
    }

    ctx.fillText(text, x, height / 2);

    const texture = new CanvasTexture(canvas);
    texture.userData = {
      ...(texture.userData ?? {}),
      logicalWidth: width,
      logicalHeight: height,
      dpr,
    };
    // sRGB + mipmaps disabled (see configure2DTexture for the why).
    configure2DTexture(texture);
    return texture;
  }

  /**
   * The text actually rendered: the translation of `labelKey` (falling back to the literal `label`)
   * when a key is set and localization is active, otherwise the literal `label`. Public so the
   * editor's viewport label proxies paint the same resolved text as the runtime (no drift).
   */
  getDisplayText(): string {
    return this.labelKey ? resolveLocalizedText(this.labelKey, this.label) : this.label;
  }

  /** Re-render the label after a locale switch (used by the localization tree walk). */
  refreshLocalizedLabel(): void {
    this.updateLabel();
  }

  /**
   * Update the label display
   */
  protected updateLabel(): void {
    const text = this.getDisplayText();
    if (!text) {
      if (this.labelMesh) {
        this.remove(this.labelMesh);
        this.labelMesh = null;
        if (this.labelTexture) {
          this.labelTexture.dispose();
          this.labelTexture = null;
        }
      }
      return;
    }

    // Always recreate texture to reflect label text changes
    if (this.labelTexture) {
      this.labelTexture.dispose();
      this.labelTexture = null;
    }
    const textureWidth = Math.max(128, Math.ceil(text.length * this.labelFontSize * 0.75) + 24);
    const textureHeight = Math.max(32, Math.ceil(this.labelFontSize * 2));
    this.labelTexture = this.createLabelTexture(text, textureWidth, textureHeight);

    if (!this.labelMesh) {
      const material = new MeshBasicMaterial({
        map: this.labelTexture,
        transparent: true,
        depthTest: false,
      });
      this.registerOpacityMaterial(material, 1);
      // Create a plane for label
      const geometry = new PlaneGeometry(1, 1);
      this.labelMesh = new Mesh(geometry, material);
      this.labelMesh.renderOrder = 1001;
      this.labelMesh.position.z = 2;
      this.add(this.labelMesh);
    } else {
      (this.labelMesh.material as MeshBasicMaterial).map = this.labelTexture;
      (this.labelMesh.material as MeshBasicMaterial).needsUpdate = true;
    }

    // Scale mesh to match texture aspect ratio or fixed size
    if (this.labelMesh && this.labelTexture) {
      const canvas = this.labelTexture.image as HTMLCanvasElement;
      const userData = (this.labelTexture.userData ?? {}) as {
        logicalWidth?: number;
        logicalHeight?: number;
        dpr?: number;
      };
      const dpr = userData.dpr ?? 1;
      const logicalWidth = userData.logicalWidth ?? canvas.width / dpr;
      const logicalHeight = userData.logicalHeight ?? canvas.height / dpr;
      this.labelMesh.scale.set(logicalWidth, logicalHeight, 1);
    }
  }

  /**
   * Default property schema for UI controls
   */
  static getPropertySchema(): PropertySchema {
    const baseSchema = Node2D.getPropertySchema();
    return {
      nodeType: 'UIControl2D',
      extends: 'Node2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'enabled',
          type: 'boolean',
          ui: { label: 'Enabled', group: 'Control' },
          getValue: n => (n as UIControl2D).enabled,
          setValue: (n, v) => {
            (n as UIControl2D).enabled = Boolean(v);
          },
        },
        {
          name: 'label',
          type: 'string',
          ui: { label: 'Label', group: 'Label', description: 'Text displayed on the control' },
          // The setters re-render (and dispose the old texture) on change, so every label
          // setValue here is a plain assignment.
          getValue: n => (n as UIControl2D).label,
          setValue: (n, v) => {
            (n as UIControl2D).label = String(v);
          },
        },
        {
          name: 'labelKey',
          type: 'string',
          ui: {
            label: 'Label Key',
            group: 'Label',
            editor: 'localization-key',
            description:
              'Localization key; when set, its translation is shown instead of the literal label',
          },
          getValue: n => (n as UIControl2D).labelKey,
          setValue: (n, v) => {
            (n as UIControl2D).labelKey = String(v);
          },
        },
        {
          name: 'labelFontSize',
          type: 'number',
          ui: { label: 'Font Size', group: 'Label', min: 8, max: 64, step: 1 },
          getValue: n => (n as UIControl2D).labelFontSize,
          setValue: (n, v) => {
            (n as UIControl2D).labelFontSize = Number(v);
          },
        },
        {
          name: 'labelColor',
          type: 'color',
          ui: { label: 'Font Color', group: 'Label' },
          getValue: n => (n as UIControl2D).labelColor,
          setValue: (n, v) => {
            (n as UIControl2D).labelColor = String(v);
          },
        },
        {
          name: 'labelAlign',
          type: 'select',
          ui: {
            label: 'Alignment',
            group: 'Label',
            options: ['left', 'center', 'right'],
          },
          getValue: n => (n as UIControl2D).labelAlign,
          setValue: (n, v) => {
            const val = String(v);
            if (val === 'left' || val === 'center' || val === 'right') {
              (n as UIControl2D).labelAlign = val;
            }
          },
        },
        {
          name: 'texturePath',
          type: 'string',
          ui: {
            label: 'Texture',
            group: 'Skin',
            description: 'Optional skin texture path (png/webp with transparency)',
          },
          getValue: n => (n as UIControl2D).texturePath ?? '',
          setValue: (n, v) => {
            const control = n as UIControl2D;
            const nextPath = String(v).trim();
            control.texturePath = nextPath.length > 0 ? nextPath : null;
            if (control.texturePath) {
              control.tryLoadTextureFromPath(control.texturePath);
            } else {
              control.applySkinTexture(null);
            }
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Control: { label: 'Control', expanded: true },
        Label: { label: 'Label', expanded: false },
        Skin: { label: 'Skin', expanded: false },
      },
    };
  }
}
