import { Mesh, MeshBasicMaterial, CircleGeometry, Vector2, Vector3 } from 'three';
import { Node2D, type Node2DProps } from '../../Node2D';
import type { InputService } from '../../../core/InputService';
import type { PropertySchema } from '../../../fw/property-schema';
import {
  readNumberArg,
  type InteractionDescriptor,
  type Interactive,
} from '../../../fw/interactive';
import { installReactiveSchemaProperties } from '../../../fw/reactive-schema-properties';

/**
 * The pseudo-pointer a semantic interaction (`setStick`) owns while it holds the stick — the same
 * id and the same meaning as `UIControl2D.SEMANTIC_POINTER_ID`, declared locally on purpose: a
 * *value* import from `UIControl2D` would drag that module (and the `ScrollContainer2D` it imports
 * for its scroll gate) into every export that ships a joystick, which the export-size table in
 * `strippable-runtime-modules.ts` exists to prevent.
 *
 * Negative so it can never collide with a DOM `pointerId`.
 */
const SEMANTIC_POINTER_ID = -1;

/**
 * The stand-in for the shared, un-addressed pointer (`isPointerDown` + `pointerPosition`), used
 * when the addressed pointer map is empty — a mouse, and the long-standing habit of tests and
 * harnesses driving nodes by assigning those two fields directly. Mirrors `UIControl2D`'s.
 */
const LEGACY_POINTER_ID = -2;

/** A pointer the joystick may consider this frame, in input/screen units. */
interface CandidatePointer {
  pointerId: number;
  x: number;
  y: number;
  down: boolean;
}

/** A {@link CandidatePointer} with its position unprojected into 2D world units. */
interface StickPointer {
  pointerId: number;
  worldX: number;
  worldY: number;
  down: boolean;
}

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

export class Joystick2D extends Node2D implements Interactive {
  private static readonly BASE_OPACITY = 0.3;
  private static readonly HANDLE_OPACITY = 0.8;
  private static readonly FADE_SPEED = 6;

  enabled: boolean;
  radius: number;
  handleRadius: number;
  axisHorizontal: string;
  axisVertical: string;
  baseColor: string;
  handleColor: string;
  floating: boolean;

  private baseMesh: Mesh;
  private handleMesh: Mesh;
  private baseMaterial: MeshBasicMaterial;
  private handleMaterial: MeshBasicMaterial;

  // State
  private isDragging: boolean = false;
  private inputVector = new Vector2();
  private authoredLocalPosition = new Vector3();
  private dragCenterWorld = new Vector2();
  private visibilityAlpha = 1;
  private visibilityTarget = 1;
  private tmpWorldPos = new Vector3();
  private pendingResetAfterHide = false;

  /**
   * The pointer this joystick follows, or null when it follows none.
   * {@link SEMANTIC_POINTER_ID} while `setStick` holds it — the latch IS ownership of a reserved
   * pseudo-pointer, which is why a real finger cannot quietly drive the stick alongside it.
   */
  private ownedPointerId: number | null = null;

  /**
   * Whether the un-addressed pointer was down on the previous tick. The addressed channel gets a
   * real `'down'` frame event; the legacy one has none, so its rising edge stands in for one.
   */
  private legacyPointerWasDown = false;

  /** Scratch for candidate unprojection; never handed out, only read within a call. */
  private readonly candidateWorld = new Vector2();

  constructor(props: Joystick2DProps) {
    super(props, 'Joystick2D');

    // `enabled` is carried by the raw properties bag rather than by a typed field in the
    // SceneLoader's `case 'Joystick2D'`: that loader and its SceneSaver counterpart spell every
    // joystick property by hand, and this is the one pair that can round-trip a new property from
    // inside this file alone (`SceneSaver` seeds its output with `{...node.properties}` — the same
    // route `ScrollContainer2D.scrollY` takes). The schema `setValue` below writes the bag back.
    const authoredEnabled = this.properties.enabled;
    this.enabled = props.enabled ?? (typeof authoredEnabled === 'boolean' ? authoredEnabled : true);
    this.radius = props.radius ?? 50;
    this.handleRadius = props.handleRadius ?? 20;
    this.axisHorizontal = props.axisHorizontal ?? 'Horizontal';
    this.axisVertical = props.axisVertical ?? 'Vertical';
    this.baseColor = props.baseColor ?? '#ffffff';
    this.handleColor = props.handleColor ?? '#cccccc';
    this.floating = props.floating ?? false;

    // Create Visuals
    const baseGeo = new CircleGeometry(this.radius, 32);
    this.baseMaterial = new MeshBasicMaterial({
      color: this.baseColor,
      transparent: true,
      opacity: Joystick2D.BASE_OPACITY,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.baseMaterial, Joystick2D.BASE_OPACITY);
    this.baseMesh = new Mesh(baseGeo, this.baseMaterial);
    this.baseMesh.renderOrder = 999;
    this.add(this.baseMesh);

    const handleGeo = new CircleGeometry(this.handleRadius, 32);
    this.handleMaterial = new MeshBasicMaterial({
      color: this.handleColor,
      transparent: true,
      opacity: Joystick2D.HANDLE_OPACITY,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.handleMaterial, Joystick2D.HANDLE_OPACITY);
    this.handleMesh = new Mesh(handleGeo, this.handleMaterial);
    // Render handle on top of base
    this.handleMesh.position.z = 1;
    this.handleMesh.renderOrder = 1000;
    this.add(this.handleMesh);

    this.authoredLocalPosition.copy(this.position);

    if (this.floating) {
      this.visibilityAlpha = 0;
      this.visibilityTarget = 0;
      this.applyVisibility();
    }

    // Last: `joystick.floating = true` from a script now hides/resets the visuals like the
    // Inspector does, instead of only flipping the flag.
    installReactiveSchemaProperties(this, Joystick2D.getPropertySchema);
  }

  override tick(dt: number): void {
    super.tick(dt);
    this.updateFromPointers();
    // Outside the drag machine on purpose: the fade has to keep running on the frames after the
    // finger is gone, and a floating stick spends most of its life with no pointer to resolve at
    // all. It used to hang off the pointer frame, so a released stick stopped mid-fade whenever the
    // pointer stopped resolving.
    if (this.floating) {
      this.updateVisibility(dt);
    }
  }

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
  private updateFromPointers(): void {
    if (!this.enabled) {
      this.abortDrag();
      return;
    }

    const input = this.input;
    // `input.width` is the screen rect the unprojection divides by; without it there is no pointer
    // to speak of (the pre-existing guard, kept).
    const candidates = input && input.width ? this.collectCandidatePointers(input) : [];
    const legacy =
      candidates.length === 1 && candidates[0].pointerId === LEGACY_POINTER_ID
        ? candidates[0]
        : null;
    const legacyDownEdge = legacy !== null && legacy.down && !this.legacyPointerWasDown;
    this.legacyPointerWasDown = legacy?.down ?? false;

    // A latched semantic hold has to be re-asserted every frame — the drag machine ends the drag the
    // moment it sees the pointer up. Only a finger that would claim THIS joystick evicts it; any
    // other finger (a thumb on a button, a second stick) leaves the hold alone.
    const latched = this.semanticPointer;
    if (latched) {
      const claimant = input ? this.findClaimingPointer(input, candidates, legacyDownEdge) : null;
      if (!claimant) {
        this.driveDragFrame(
          {
            pointerId: SEMANTIC_POINTER_ID,
            worldX: latched.x,
            worldY: latched.y,
            down: latched.down,
          },
          false
        );
        return;
      }
      this.semanticPointer = null;
      this.ownedPointerId = claimant.pointerId;
      this.driveDragFrame(claimant, true);
      return;
    }

    if (!input || candidates.length === 0) return;

    const owned = this.ownedPointerId;
    if (owned !== null) {
      const current = candidates.find(candidate => candidate.pointerId === owned);
      if (!current) {
        this.finishOwnedPointer();
        return;
      }
      const world = this.screenPointToWorld(current.x, current.y, this.candidateWorld);
      if (!world) return;
      this.driveDragFrame(
        { pointerId: owned, worldX: world.x, worldY: world.y, down: current.down },
        false
      );
      return;
    }

    const claimant = this.findClaimingPointer(input, candidates, legacyDownEdge);
    if (claimant) {
      this.ownedPointerId = claimant.pointerId;
      this.driveDragFrame(claimant, true);
    }
  }

  /**
   * Every pointer this joystick may consider this frame, in press order. Falls back to ONE synthetic
   * pointer at the shared `pointerPosition` when the addressed map is empty — see
   * {@link LEGACY_POINTER_ID}.
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

  /** The first pointer that may start a drag on this joystick this frame (see {@link updateFromPointers}). */
  private findClaimingPointer(
    input: InputService,
    candidates: readonly CandidatePointer[],
    legacyDownEdge: boolean
  ): StickPointer | null {
    for (const candidate of candidates) {
      if (!candidate.down) continue;
      const isLegacy = candidate.pointerId === LEGACY_POINTER_ID;
      if (this.floating) {
        // The un-addressed pointer carries no events and no id to ask about, so its rising edge and
        // the `isHoveringUI` aggregate stand in — the pre-multi-touch behaviour, unchanged.
        const startsNow = isLegacy
          ? legacyDownEdge
          : Joystick2D.hasDownEventThisFrame(input, candidate.pointerId);
        if (!startsNow) continue;
        const overUI = isLegacy ? input.isHoveringUI : input.isPointerOverUI(candidate.pointerId);
        if (overUI) continue;
      }
      const world = this.screenPointToWorld(candidate.x, candidate.y, this.candidateWorld);
      if (!world) return null;
      if (!this.floating && !this.isWithinBase(world.x, world.y)) continue;
      return { pointerId: candidate.pointerId, worldX: world.x, worldY: world.y, down: true };
    }
    return null;
  }

  private static hasDownEventThisFrame(input: InputService, pointerId: number): boolean {
    for (const event of input.pointerEvents) {
      if (event.type === 'down' && event.pointerId === pointerId) return true;
    }
    return false;
  }

  /** Whether a world point is inside the base circle — the fixed stick's claim area. */
  private isWithinBase(worldX: number, worldY: number): boolean {
    this.getWorldPosition(this.tmpWorldPos);
    const dx = worldX - this.tmpWorldPos.x;
    const dy = worldY - this.tmpWorldPos.y;
    return Math.sqrt(dx * dx + dy * dy) < this.radius;
  }

  /**
   * One frame of the drag machine with a pointer this joystick owns (or is claiming). The single
   * body both channels run: a real finger's tick, and the synthetic frames `setStick` pushes
   * through, take exactly the same path.
   */
  private driveDragFrame(pointer: StickPointer, claim: boolean): void {
    if (this.isDragging) {
      if (pointer.down) {
        this.continueDrag(pointer.worldX, pointer.worldY);
      } else {
        this.releaseDrag();
      }
      return;
    }
    if (!claim || !pointer.down) return;
    if (this.floating) {
      this.beginFloatingDrag(pointer.worldX, pointer.worldY);
      this.continueDrag(pointer.worldX, pointer.worldY);
      return;
    }
    // A fixed stick's claim frame only takes the pointer; the handle follows from the next frame on
    // (unchanged — the press that starts the drag does not itself deflect the stick).
    this.isDragging = true;
  }

  /** Summon a floating stick under the finger that just landed. */
  private beginFloatingDrag(worldX: number, worldY: number): void {
    this.isDragging = true;
    this.pendingResetAfterHide = false;
    this.handleMesh.position.set(0, 0, this.handleMesh.position.z);
    this.setCenterFromWorld(worldX, worldY);
    this.visibilityTarget = 1;
  }

  /** Deflect the stick towards the owned pointer: from the drag centre when floating, else from self. */
  private continueDrag(worldX: number, worldY: number): void {
    if (this.floating) {
      this.updateHandleAndAxes(worldX - this.dragCenterWorld.x, worldY - this.dragCenterWorld.y);
      return;
    }
    this.getWorldPosition(this.tmpWorldPos);
    this.updateHandleAndAxes(worldX - this.tmpWorldPos.x, worldY - this.tmpWorldPos.y);
  }

  /**
   * The owned pointer is gone from the map. `'up'` is a normal release, `'cancel'` — and a pointer
   * that vanished with no terminal event at all (input lock, detach, a lost frame) — is a
   * cancellation. A stick ends the same way for all three, and that identity is the invariant, not
   * an oversight: a finger dragged off the edge of the screen must return the axes to neutral, or
   * the character it was steering runs forever. (The distinction matters where a terminal can
   * *produce* something — a click — which a joystick has none of.)
   */
  private finishOwnedPointer(): void {
    this.releaseDrag();
  }

  /** Stop following anything and return the stick to rest. */
  private releaseDrag(): void {
    this.semanticPointer = null;
    this.ownedPointerId = null;
    if (this.isDragging) {
      this.endDrag();
    }
  }

  /** Drop a drag the joystick may no longer run at all (it was disabled mid-gesture). */
  private abortDrag(): void {
    if (!this.isDragging && this.ownedPointerId === null && this.semanticPointer === null) return;
    this.releaseDrag();
  }

  /** Direction names `setStick` accepts, mapped to unit vectors (+y is up, as in world space). */
  private static readonly DIRECTIONS: Record<string, [number, number]> = {
    right: [1, 0],
    left: [-1, 0],
    up: [0, 1],
    down: [0, -1],
    upright: [Math.SQRT1_2, Math.SQRT1_2],
    upleft: [-Math.SQRT1_2, Math.SQRT1_2],
    downright: [Math.SQRT1_2, -Math.SQRT1_2],
    downleft: [-Math.SQRT1_2, -Math.SQRT1_2],
  };

  /** The synthetic finger holding the stick, in world units, or null under real input. */
  private semanticPointer: { x: number; y: number; down: boolean } | null = null;

  getInteractions(): InteractionDescriptor[] {
    return [
      {
        name: 'setStick',
        description: 'Push the stick in a direction and hold it there',
        args: [
          {
            name: 'dir',
            type: 'string',
            ui: {
              label: 'Direction',
              description: 'up/down/left/right/upleft/… or an angle in degrees (0 = right, CCW)',
              options: Object.keys(Joystick2D.DIRECTIONS),
            },
          },
          {
            name: 'magnitude',
            type: 'number',
            defaultValue: 1,
            ui: { label: 'Magnitude', min: 0, max: 1, description: '0..1 of the stick radius' },
          },
        ],
      },
      { name: 'releaseStick', description: 'Let go of the stick (axes return to zero)' },
    ];
  }

  invokeInteraction(name: string, args?: Record<string, unknown>): boolean {
    // A disabled stick accepts nothing, so an invocation reports the refusal rather than pretending
    // it happened — the rule every `UIControl2D` already follows.
    if (!this.enabled) return false;
    switch (name) {
      case 'setStick': {
        const direction = this.resolveDirection(args?.dir);
        if (!direction) return false;
        const magnitude = Math.max(0, Math.min(1, readNumberArg(args, 'magnitude', 1) ?? 1));
        return this.pushStick(direction, magnitude);
      }
      case 'releaseStick':
        return this.releaseStick();
      default:
        return false;
    }
  }

  /** `dir` as a unit vector: a named direction, or an angle in degrees (0 = right, CCW). */
  private resolveDirection(raw: unknown): [number, number] | null {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const radians = (raw * Math.PI) / 180;
      return [Math.cos(radians), Math.sin(radians)];
    }
    if (typeof raw !== 'string') return null;
    const key = raw
      .trim()
      .toLowerCase()
      .replace(/[\s_-]/g, '');
    const named = Joystick2D.DIRECTIONS[key];
    if (named) return named;
    const degrees = Number(key);
    if (Number.isFinite(degrees) && key.length > 0) {
      const radians = (degrees * Math.PI) / 180;
      return [Math.cos(radians), Math.sin(radians)];
    }
    return null;
  }

  /**
   * Put a finger on the stick and move it — two synthetic frames through the same drag machine a
   * touch drives, because that is the gesture: the press has to land inside the base (that is what
   * starts the drag, and what a press outside the radius correctly fails to do) before the travel
   * can be clamped to the radius and turned into axis values.
   *
   * The hold is latched, so the axes stay pushed across the frames that follow — a stick is held,
   * not tapped — until `releaseStick`.
   */
  private pushStick(direction: [number, number], magnitude: number): boolean {
    this.getWorldPosition(this.tmpWorldPos);
    const centerX = this.tmpWorldPos.x;
    const centerY = this.tmpWorldPos.y;

    this.runSemanticStickFrame(centerX, centerY);

    const reach = this.radius * magnitude;
    const targetX = centerX + direction[0] * reach;
    const targetY = centerY + direction[1] * reach;
    this.runSemanticStickFrame(targetX, targetY);
    return true;
  }

  /**
   * One synthetic frame of the drag machine, owned by {@link SEMANTIC_POINTER_ID}. Latching IS
   * taking ownership of that pseudo-pointer, which is what keeps the stick pushed across the ticks
   * that follow, and what makes "only a finger that would claim this joystick evicts it" the single
   * rule covering both channels.
   */
  private runSemanticStickFrame(worldX: number, worldY: number): void {
    this.semanticPointer = { x: worldX, y: worldY, down: true };
    this.ownedPointerId = SEMANTIC_POINTER_ID;
    // The press still has to land inside the base — a press outside the radius correctly fails to
    // start a drag, exactly as a finger's does.
    const claim = this.floating || this.isWithinBase(worldX, worldY);
    this.driveDragFrame({ pointerId: SEMANTIC_POINTER_ID, worldX, worldY, down: true }, claim);
    if (!this.isDragging) {
      // The press was refused; a latch with no drag behind it would ignore real fingers for nothing.
      this.semanticPointer = null;
      this.ownedPointerId = null;
    }
  }

  /** Lift the finger off the stick through the machine's own release path. */
  private releaseStick(): boolean {
    this.releaseDrag();
    return true;
  }

  private updateHandleAndAxes(dx: number, dy: number): void {
    const angle = Math.atan2(dy, dx);
    const dist = Math.sqrt(dx * dx + dy * dy);
    const clampDist = Math.min(dist, this.radius);

    const stickX = Math.cos(angle) * clampDist;
    const stickY = Math.sin(angle) * clampDist;

    this.handleMesh.position.x = stickX;
    this.handleMesh.position.y = stickY;

    this.inputVector.set(stickX / this.radius, stickY / this.radius);

    this.input?.setAxis(this.axisHorizontal, this.inputVector.x);
    this.input?.setAxis(this.axisVertical, this.inputVector.y);
  }

  private endDrag(): void {
    this.isDragging = false;
    this.inputVector.set(0, 0);
    this.input?.setAxis(this.axisHorizontal, 0);
    this.input?.setAxis(this.axisVertical, 0);

    if (this.floating) {
      this.visibilityTarget = 0;
      this.pendingResetAfterHide = true;
      return;
    }

    this.handleMesh.position.x = 0;
    this.handleMesh.position.y = 0;
  }

  private updateVisibility(dt: number): void {
    const delta = this.visibilityTarget - this.visibilityAlpha;
    if (Math.abs(delta) <= Number.EPSILON) {
      this.visibilityAlpha = this.visibilityTarget;
      this.applyVisibility();
      return;
    }

    const safeDt = Math.min(dt, 1 / 30);
    const step = Joystick2D.FADE_SPEED * safeDt;
    if (Math.abs(delta) <= step) {
      this.visibilityAlpha = this.visibilityTarget;
    } else {
      this.visibilityAlpha += Math.sign(delta) * step;
    }

    this.applyVisibility();

    if (this.visibilityAlpha === 0 && this.pendingResetAfterHide) {
      this.pendingResetAfterHide = false;
      this.position.copy(this.authoredLocalPosition);
      this.handleMesh.position.x = 0;
      this.handleMesh.position.y = 0;
    }
  }

  private applyVisibility(): void {
    this.setOpacityMaterialBase(this.baseMaterial, Joystick2D.BASE_OPACITY * this.visibilityAlpha);
    this.setOpacityMaterialBase(
      this.handleMaterial,
      Joystick2D.HANDLE_OPACITY * this.visibilityAlpha
    );
  }

  private setCenterFromWorld(worldX: number, worldY: number): void {
    this.position.set(worldX, worldY, this.position.z);
    this.dragCenterWorld.set(worldX, worldY);
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Node2D.getPropertySchema();
    return {
      nodeType: 'Joystick2D',
      extends: 'Node2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'enabled',
          type: 'boolean',
          ui: { label: 'Enabled', group: 'Joystick' },
          getValue: n => (n as Joystick2D).enabled,
          setValue: (n, v) => {
            const joystick = n as Joystick2D;
            joystick.enabled = Boolean(v);
            // Persist through the properties bag — see the constructor for why that is the route.
            joystick.properties.enabled = joystick.enabled;
            if (!joystick.enabled) {
              // Same rule as a disabled UIControl2D: do not freeze a gesture the node can no longer
              // run — drop it, so the axes cannot stay pushed by a finger nobody is reading.
              joystick.abortDrag();
            }
          },
        },
        {
          name: 'radius',
          type: 'number',
          ui: { label: 'Radius', group: 'Joystick' },
          getValue: n => (n as Joystick2D).radius,
          setValue: (n, v) => {
            (n as Joystick2D).radius = Number(v);
          },
        },
        {
          name: 'floating',
          type: 'boolean',
          ui: { label: 'Floating Position', group: 'Joystick' },
          getValue: n => (n as Joystick2D).floating,
          setValue: (n, v) => {
            const joystick = n as Joystick2D;
            joystick.floating = Boolean(v);
            // The mode switch ends whatever gesture was running, ownership included: the drag rules
            // it was claimed under no longer apply.
            joystick.semanticPointer = null;
            joystick.ownedPointerId = null;
            joystick.endDrag();
            if (joystick.floating) {
              joystick.visibilityAlpha = 0;
              joystick.visibilityTarget = 0;
              joystick.pendingResetAfterHide = false;
              joystick.position.copy(joystick.authoredLocalPosition);
              joystick.handleMesh.position.set(0, 0, joystick.handleMesh.position.z);
            } else {
              joystick.pendingResetAfterHide = false;
              joystick.position.copy(joystick.authoredLocalPosition);
              joystick.handleMesh.position.set(0, 0, joystick.handleMesh.position.z);
              joystick.visibilityAlpha = 1;
              joystick.visibilityTarget = 1;
            }
            joystick.applyVisibility();
          },
        },
        {
          name: 'axisHorizontal',
          type: 'string',
          ui: { label: 'Horz Axis', group: 'Input' },
          getValue: n => (n as Joystick2D).axisHorizontal,
          setValue: (n, v) => {
            (n as Joystick2D).axisHorizontal = String(v);
          },
        },
        {
          name: 'axisVertical',
          type: 'string',
          ui: { label: 'Vert Axis', group: 'Input' },
          getValue: n => (n as Joystick2D).axisVertical,
          setValue: (n, v) => {
            (n as Joystick2D).axisVertical = String(v);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Joystick: { label: 'Joystick', expanded: true },
        Input: { label: 'Input Mapping', expanded: true },
      },
    };
  }
}
