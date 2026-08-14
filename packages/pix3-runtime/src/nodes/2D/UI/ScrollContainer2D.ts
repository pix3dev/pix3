import {
  Mesh,
  MeshBasicMaterial,
  Plane,
  PlaneGeometry,
  type Material,
  type Object3D,
  type Texture,
  Vector2,
  Vector3,
} from 'three';

import { Group2D, type Group2DProps } from '../Group2D';
import { Node2D } from '../../Node2D';
import type { InputService } from '../../../core/InputService';
import { OVERLAY_2D_FLAG } from '../../../core/render-order-2d';
import { coerceTextureResource, type TextureResourceRef } from '../../../core/TextureResource';
import { configure2DTexture } from '../../../core/configure-2d-texture';
import type { PropertySchema } from '../../../fw/property-schema';
import {
  readNumberArg,
  type InteractionDescriptor,
  type Interactive,
} from '../../../fw/interactive';
import { installReactiveSchemaProperties } from '../../../fw/reactive-schema-properties';

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

type PointerDragMode = 'content' | 'thumb' | null;

/**
 * The pseudo-pointer a semantic scroll interaction (`scrollBy` / `scrollTo` / `fling`) owns while it
 * runs — same id and same meaning as `UIControl2D.SEMANTIC_POINTER_ID`, declared locally to keep
 * this module from value-importing `UIControl2D` (which imports this one back, and which the
 * export-size table would then pin into every build that ships a scroll container).
 */
const SEMANTIC_POINTER_ID = -1;

/**
 * The stand-in for the shared, un-addressed pointer (`isPointerDown` + `pointerPosition`), used
 * when the addressed pointer map is empty — a mouse (wheel scrolling has no pointer down at all),
 * and harnesses/tests that drive those two fields directly. Mirrors `UIControl2D`'s.
 */
const LEGACY_POINTER_ID = -2;

/** A pointer the container may consider this frame, in input/screen units. */
interface CandidatePointer {
  pointerId: number;
  x: number;
  y: number;
  down: boolean;
}

/** The pointer the drag machine runs on this frame, in 2D world units. */
interface DrivingPointer {
  pointerId: number;
  worldX: number;
  worldY: number;
  down: boolean;
}

export class ScrollContainer2D extends Group2D implements Interactive {
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

  private _scrollY: number;
  private readonly tmpWorldPos = new Vector3();
  private readonly tmpWorldScale = new Vector3();
  private readonly pointerWorld = new Vector2();
  private readonly candidateWorld = new Vector2();
  /**
   * The pointer this container follows, or null when it follows none.
   * {@link SEMANTIC_POINTER_ID} while a scripted gesture is running.
   */
  private ownedPointerId: number | null = null;
  private readonly clippingPlanes = [
    new Plane(new Vector3(1, 0, 0), 0),
    new Plane(new Vector3(-1, 0, 0), 0),
    new Plane(new Vector3(0, 1, 0), 0),
    new Plane(new Vector3(0, -1, 0), 0),
  ];
  private readonly appliedClippingMaterials = new Set<Material>();
  private readonly childBasePositions = new Map<string, Vector3>();
  private dragMode: PointerDragMode = null;
  private pointerStartedInside = false;
  private pointerWasDown = false;
  private lastAppliedScrollY = 0;
  private lastPointerWorldY = 0;
  private pointerDownWorldY = 0;
  private pointerDownScrollY = 0;
  private scrollVelocity = 0;
  private thumbHeight = 0;
  private thumbCenterY = 0;
  private trackCenterX = 0;
  private trackGeometry: PlaneGeometry;
  private thumbGeometry: PlaneGeometry;
  private readonly trackMaterial: MeshBasicMaterial;
  private readonly thumbMaterial: MeshBasicMaterial;
  private readonly trackMesh: Mesh;
  private readonly thumbMesh: Mesh;

  constructor(props: ScrollContainer2DProps) {
    super(props, 'ScrollContainer2D');

    this.dragScrollEnabled = props.dragScrollEnabled ?? true;
    this.wheelScrollEnabled = props.wheelScrollEnabled ?? true;
    this.inertiaEnabled = props.inertiaEnabled ?? true;
    this.showScrollbar = props.showScrollbar ?? true;
    this.wheelSensitivity = props.wheelSensitivity ?? 1;
    this.dragThreshold = Math.max(0, props.dragThreshold ?? 6);
    this.inertiaDamping = Math.max(0.01, props.inertiaDamping ?? 14);
    this.scrollbarWidth = Math.max(2, props.scrollbarWidth ?? 8);
    this.scrollbarMinHeight = Math.max(8, props.scrollbarMinHeight ?? 24);
    this.scrollbarInset = Math.max(0, props.scrollbarInset ?? 8);
    this.scrollbarColor = props.scrollbarColor ?? '#f5f7ff';
    this.scrollbarTrackColor = props.scrollbarTrackColor ?? '#ffffff';
    this.scrollbarThumbTexture = coerceTextureResource(props.scrollbarThumbTexture ?? null);
    this.scrollbarTrackTexture = coerceTextureResource(props.scrollbarTrackTexture ?? null);
    this._scrollY = Math.max(0, props.scrollY ?? 0);

    this.trackGeometry = new PlaneGeometry(this.scrollbarWidth, Math.max(1, this.height));
    this.thumbGeometry = new PlaneGeometry(this.scrollbarWidth, Math.max(1, this.height));

    this.trackMaterial = new MeshBasicMaterial({
      color: this.scrollbarTrackColor,
      transparent: true,
      opacity: 0.18,
      depthTest: false,
    });
    this.thumbMaterial = new MeshBasicMaterial({
      color: this.scrollbarColor,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
    });

    this.registerOpacityMaterial(this.trackMaterial, 0.18);
    this.registerOpacityMaterial(this.thumbMaterial, 0.92);

    // The scrollbar must float above the scrolled content (which is added as
    // child nodes), so mark it as an overlay for the 2D render-order pass.
    // The renderOrder values order the track below the thumb within the overlay.
    this.trackMesh = new Mesh(this.trackGeometry, this.trackMaterial);
    this.trackMesh.renderOrder = 1000;
    this.trackMesh.userData[OVERLAY_2D_FLAG] = true;
    this.trackMesh.position.z = 0.25;
    this.trackMesh.visible = false;
    this.trackMesh.name = `${this.name}-ScrollbarTrack`;
    this.add(this.trackMesh);

    this.thumbMesh = new Mesh(this.thumbGeometry, this.thumbMaterial);
    this.thumbMesh.renderOrder = 1001;
    this.thumbMesh.userData[OVERLAY_2D_FLAG] = true;
    this.thumbMesh.position.z = 0.3;
    this.thumbMesh.visible = false;
    this.thumbMesh.name = `${this.name}-ScrollbarThumb`;
    this.add(this.thumbMesh);

    // Last: most scrollbar props self-heal via the per-tick syncScrollbarVisuals(), but that only
    // runs inside the game loop — this makes script writes apply the schema's clamps and repaint
    // the materials immediately (and outside play mode at all).
    installReactiveSchemaProperties(this, ScrollContainer2D.getPropertySchema);
  }

  get scrollY(): number {
    return this._scrollY;
  }

  set scrollY(value: number) {
    const maxScrollY = this.hasScrollableChildren()
      ? this.getMaxScrollY()
      : Number.POSITIVE_INFINITY;
    const nextValue = ScrollContainer2D.clampScroll(value, maxScrollY);
    if (this._scrollY === nextValue) {
      return;
    }

    // Store only — the child offset is applied by tick(), i.e. exclusively
    // inside the game loop. Assignments outside it (inspector edits, prefab
    // instance overrides during load) must never mutate the authored child
    // transforms: those writes leaked into saved scenes / prefab override
    // diffs and compounded the offset on every load.
    this._scrollY = nextValue;
    this.properties.scrollY = nextValue;
    this.syncScrollbarVisuals();
  }

  /** Assign the loaded thumb Texture (called by SceneLoader after loading). */
  setScrollbarThumbTexture(texture: Texture | null): void {
    if (texture) {
      // sRGB + mipmaps disabled (see configure2DTexture for the why).
      configure2DTexture(texture);
    }
    this.thumbMaterial.map = texture;
    // The flat-color thumb rides at 0.92 base opacity; a texture wants to show
    // its own alpha, so force full opacity while textured and restore on clear.
    this.setOpacityMaterialBase(this.thumbMaterial, texture ? 1 : 0.92);
    this.thumbMaterial.needsUpdate = true;
  }

  /** Assign the loaded track Texture (called by SceneLoader after loading). */
  setScrollbarTrackTexture(texture: Texture | null): void {
    if (texture) {
      configure2DTexture(texture);
    }
    this.trackMaterial.map = texture;
    // The flat-color track sits at 0.18 base opacity, which would render a
    // texture nearly invisible; force full opacity while textured.
    this.setOpacityMaterialBase(this.trackMaterial, texture ? 1 : 0.18);
    this.trackMaterial.needsUpdate = true;
  }

  private setScrollbarThumbTextureRef(value: unknown): void {
    const ref = coerceTextureResource(value);
    const changed = this.scrollbarThumbTexture?.url !== ref?.url;
    this.scrollbarThumbTexture = ref;
    // The node has no asset loader; a new ref is loaded by SceneLoader on the
    // next scene load / play. Only clearing can be reflected immediately.
    if (changed && !ref) {
      this.setScrollbarThumbTexture(null);
    }
  }

  private setScrollbarTrackTextureRef(value: unknown): void {
    const ref = coerceTextureResource(value);
    const changed = this.scrollbarTrackTexture?.url !== ref?.url;
    this.scrollbarTrackTexture = ref;
    if (changed && !ref) {
      this.setScrollbarTrackTexture(null);
    }
  }

  /**
   * True while this container is running a drag (content or thumb) — and therefore while every
   * descendant control is gated off, **for every finger, not just the one doing the scrolling**
   * (`UIControl2D.isPointerAllowedByAncestorScrollContainers` asks this without naming a pointer).
   * That is deliberate and matches every native scroller: while a list is being flicked, a second
   * finger landing on a row inside it must not activate the row.
   */
  hasActivePointerCapture(): boolean {
    return this.dragMode !== null;
  }

  isPointInViewportBounds(worldPoint: Vector2): boolean {
    this.getWorldPosition(this.tmpWorldPos);
    this.getWorldScale(this.tmpWorldScale);
    const halfWidth = (this.width * Math.abs(this.tmpWorldScale.x)) / 2;
    const halfHeight = (this.height * Math.abs(this.tmpWorldScale.y)) / 2;
    const dx = Math.abs(worldPoint.x - this.tmpWorldPos.x);
    const dy = Math.abs(worldPoint.y - this.tmpWorldPos.y);
    return dx <= halfWidth && dy <= halfHeight;
  }

  getContentNode(): Node2D | null {
    const scrollableChildren = this.getScrollableChildren();
    return scrollableChildren.length === 1 ? scrollableChildren[0] : null;
  }

  getContentHeight(): number {
    const contentBounds = this.getContentBounds();
    if (!contentBounds) {
      return 0;
    }

    return Math.max(0, contentBounds.maxY - contentBounds.minY);
  }

  getMaxScrollY(): number {
    const contentBounds = this.getContentBounds();
    if (!contentBounds) {
      return 0;
    }

    const viewportBottom = -this.height / 2;
    return Math.max(0, viewportBottom - contentBounds.minY);
  }

  override tick(dt: number): void {
    this.updatePointerAndScroll(dt);
    this.applyScrollOffset();
    this.applyClippingPlanes();
    this.syncScrollbarVisuals();
    super.tick(dt);
  }

  /** The synthetic finger a semantic scroll interaction is currently driving, in world units. */
  private semanticPointer: { x: number; y: number; down: boolean } | null = null;

  /** Frame length the synthetic drag frames are timed with (velocity and inertia read it). */
  private static readonly SEMANTIC_FRAME_DT = 1 / 60;

  getInteractions(): InteractionDescriptor[] {
    const offsetArg = {
      name: 'delta',
      type: 'number' as const,
      ui: { label: 'Delta', description: 'Change in scroll offset, in scene units' },
    };
    return [
      { name: 'scrollBy', description: 'Drag the content by an offset', args: [offsetArg] },
      {
        name: 'scrollTo',
        description: 'Drag the content to an absolute scroll offset',
        args: [
          {
            name: 'offset',
            type: 'number',
            ui: { label: 'Offset', min: 0, description: 'Target scrollY' },
          },
        ],
      },
      {
        name: 'fling',
        description: 'Flick the content and let inertia carry it',
        args: [
          {
            name: 'velocity',
            type: 'number',
            ui: { label: 'Velocity', description: 'Scene units per second at release' },
          },
        ],
      },
    ];
  }

  invokeInteraction(name: string, args?: Record<string, unknown>): boolean {
    switch (name) {
      case 'scrollBy': {
        const delta = readNumberArg(args, 'delta');
        return delta === null ? false : this.dragScrollBy(delta, 0);
      }
      case 'scrollTo': {
        const offset = readNumberArg(args, 'offset');
        return offset === null ? false : this.dragScrollBy(offset - this.scrollY, 0);
      }
      case 'fling': {
        const velocity = readNumberArg(args, 'velocity');
        return velocity === null ? false : this.dragScrollBy(0, velocity);
      }
      default:
        return false;
    }
  }

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
  private dragScrollBy(delta: number, releaseVelocity: number): boolean {
    if (!this.dragScrollEnabled) {
      return false;
    }

    const dt = ScrollContainer2D.SEMANTIC_FRAME_DT;
    this.getWorldPosition(this.tmpWorldPos);
    const centerX = this.tmpWorldPos.x;
    let y = this.tmpWorldPos.y;
    const direction = Math.sign(delta || releaseVelocity || 1);

    // A gesture starts with a press, so start from "no finger down" — otherwise a real finger that
    // happens to be down right now would swallow the press frame and the drag would never begin.
    // Taking the pseudo-pointer's ownership with it is the same rule the controls follow: the latch
    // IS ownership, so a real finger that was driving the list loses it and has to claim again
    // (which it does on the very next tick, since the gesture below is over by then).
    this.pointerWasDown = false;
    this.dragMode = null;
    this.ownedPointerId = SEMANTIC_POINTER_ID;

    try {
      // Press. With a zero drag threshold this frame already claims the gesture.
      this.runSemanticScrollFrame(centerX, y, true, dt);
      if (this.dragMode !== 'content') {
        // The frame that crosses the threshold is consumed by the threshold itself — it must not
        // count towards the requested travel, so it is measured and then left behind.
        y += direction * (this.dragThreshold + 1);
        this.runSemanticScrollFrame(centerX, y, true, dt);
      }
      // In content mode each frame scrolls by exactly its own pointer delta.
      if (delta !== 0) {
        y += delta;
        this.runSemanticScrollFrame(centerX, y, true, dt);
      }
      if (releaseVelocity !== 0) {
        // Still moving at release: velocity is measured as travel/dt, so hand it the travel that
        // produces the velocity asked for and let the release frame keep it.
        y += releaseVelocity * dt;
        this.runSemanticScrollFrame(centerX, y, true, dt);
      } else {
        // A settle frame with no travel zeroes the measured velocity, so a plain scrollBy does not
        // silently turn into a fling that keeps drifting for another second.
        this.runSemanticScrollFrame(centerX, y, true, dt);
      }
      this.runSemanticScrollFrame(centerX, y, false, dt);
    } finally {
      this.semanticPointer = null;
      this.ownedPointerId = null;
    }

    return true;
  }

  /**
   * One synthetic frame of the scroll machine — the tick body minus advancing children and minus
   * the clipping planes, which follow the container's own transform and cannot change during a
   * gesture.
   */
  private runSemanticScrollFrame(x: number, y: number, down: boolean, dt: number): void {
    this.semanticPointer = { x, y, down };
    this.updatePointerAndScroll(dt);
    this.applyScrollOffset();
    this.syncScrollbarVisuals();
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Group2D.getPropertySchema();
    return {
      nodeType: 'ScrollContainer2D',
      extends: 'Group2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'scrollY',
          type: 'number',
          ui: { label: 'Scroll Y', group: 'Scroll', min: 0, step: 1, precision: 0 },
          getValue: (node: unknown) => (node as ScrollContainer2D).scrollY,
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).scrollY = Number(value);
          },
        },
        {
          name: 'dragScrollEnabled',
          type: 'boolean',
          ui: { label: 'Drag Scroll', group: 'Scroll' },
          getValue: (node: unknown) => (node as ScrollContainer2D).dragScrollEnabled,
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).dragScrollEnabled = Boolean(value);
          },
        },
        {
          name: 'wheelScrollEnabled',
          type: 'boolean',
          ui: { label: 'Wheel Scroll', group: 'Scroll' },
          getValue: (node: unknown) => (node as ScrollContainer2D).wheelScrollEnabled,
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).wheelScrollEnabled = Boolean(value);
          },
        },
        {
          name: 'inertiaEnabled',
          type: 'boolean',
          ui: { label: 'Inertia', group: 'Scroll' },
          getValue: (node: unknown) => (node as ScrollContainer2D).inertiaEnabled,
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).inertiaEnabled = Boolean(value);
          },
        },
        {
          name: 'showScrollbar',
          type: 'boolean',
          ui: { label: 'Show Scrollbar', group: 'Scrollbar' },
          getValue: (node: unknown) => (node as ScrollContainer2D).showScrollbar,
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).showScrollbar = Boolean(value);
          },
        },
        {
          name: 'wheelSensitivity',
          type: 'number',
          ui: { label: 'Wheel Sensitivity', group: 'Scroll', min: 0.1, step: 0.1, precision: 2 },
          getValue: (node: unknown) => (node as ScrollContainer2D).wheelSensitivity,
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).wheelSensitivity = Math.max(0.1, Number(value));
          },
        },
        {
          name: 'dragThreshold',
          type: 'number',
          ui: { label: 'Drag Threshold', group: 'Scroll', min: 0, step: 1, precision: 0 },
          getValue: (node: unknown) => (node as ScrollContainer2D).dragThreshold,
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).dragThreshold = Math.max(0, Number(value));
          },
        },
        {
          name: 'inertiaDamping',
          type: 'number',
          ui: { label: 'Inertia Damping', group: 'Scroll', min: 0.01, step: 0.1, precision: 2 },
          getValue: (node: unknown) => (node as ScrollContainer2D).inertiaDamping,
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).inertiaDamping = Math.max(0.01, Number(value));
          },
        },
        {
          name: 'scrollbarWidth',
          type: 'number',
          ui: { label: 'Width', group: 'Scrollbar', min: 2, step: 1, precision: 0 },
          getValue: (node: unknown) => (node as ScrollContainer2D).scrollbarWidth,
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).scrollbarWidth = Math.max(2, Number(value));
          },
        },
        {
          name: 'scrollbarMinHeight',
          type: 'number',
          ui: { label: 'Min Height', group: 'Scrollbar', min: 8, step: 1, precision: 0 },
          getValue: (node: unknown) => (node as ScrollContainer2D).scrollbarMinHeight,
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).scrollbarMinHeight = Math.max(8, Number(value));
          },
        },
        {
          name: 'scrollbarInset',
          type: 'number',
          ui: { label: 'Inset', group: 'Scrollbar', min: 0, step: 1, precision: 0 },
          getValue: (node: unknown) => (node as ScrollContainer2D).scrollbarInset,
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).scrollbarInset = Math.max(0, Number(value));
          },
        },
        {
          name: 'scrollbarColor',
          type: 'color',
          ui: { label: 'Thumb Color', group: 'Scrollbar' },
          getValue: (node: unknown) => (node as ScrollContainer2D).scrollbarColor,
          setValue: (node: unknown, value: unknown) => {
            const target = node as ScrollContainer2D;
            target.scrollbarColor = String(value);
            target.thumbMaterial.color.setStyle(target.scrollbarColor);
          },
        },
        {
          name: 'scrollbarTrackColor',
          type: 'color',
          ui: { label: 'Track Color', group: 'Scrollbar' },
          getValue: (node: unknown) => (node as ScrollContainer2D).scrollbarTrackColor,
          setValue: (node: unknown, value: unknown) => {
            const target = node as ScrollContainer2D;
            target.scrollbarTrackColor = String(value);
            target.trackMaterial.color.setStyle(target.scrollbarTrackColor);
          },
        },
        {
          name: 'scrollbarThumbTexture',
          type: 'object',
          ui: {
            label: 'Thumb Sprite',
            group: 'Scrollbar',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: (node: unknown) =>
            (node as ScrollContainer2D).scrollbarThumbTexture ?? { type: 'texture', url: '' },
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).setScrollbarThumbTextureRef(value);
          },
        },
        {
          name: 'scrollbarTrackTexture',
          type: 'object',
          ui: {
            label: 'Track Sprite',
            group: 'Scrollbar',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: (node: unknown) =>
            (node as ScrollContainer2D).scrollbarTrackTexture ?? { type: 'texture', url: '' },
          setValue: (node: unknown, value: unknown) => {
            (node as ScrollContainer2D).setScrollbarTrackTextureRef(value);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Scroll: { label: 'Scroll', expanded: true },
        Scrollbar: { label: 'Scrollbar', expanded: true },
      },
    };
  }

  protected override disposeResources(): void {
    this.clearClippingPlanes();
    this.trackGeometry.dispose();
    this.thumbGeometry.dispose();
    this.trackMaterial.dispose();
    this.thumbMaterial.dispose();
  }

  private updatePointerAndScroll(dt: number): void {
    const input = this.input;
    // A semantic interaction stands in for the finger; everything below is the untouched drag
    // machine, so a scripted scroll goes through the same threshold, capture, clamp and inertia a
    // real drag does.
    const semantic = this.semanticPointer;
    let isPointerDown: boolean;
    let pointerId: number;
    if (semantic) {
      this.pointerWorld.set(semantic.x, semantic.y);
      isPointerDown = semantic.down;
      pointerId = SEMANTIC_POINTER_ID;
    } else {
      if (!input) {
        this.pointerWasDown = false;
        this.ownedPointerId = null;
        return;
      }
      const driving = this.resolveDrivingPointer(input);
      if (!driving) {
        this.pointerWasDown = false;
        return;
      }
      this.pointerWorld.set(driving.worldX, driving.worldY);
      isPointerDown = driving.down;
      pointerId = driving.pointerId;
    }

    const pointerWorld = this.pointerWorld;
    const pointerInBounds = this.isPointInViewportBounds(pointerWorld);
    if (pointerInBounds || this.dragMode !== null) {
      // Attribute the hover to the finger that produced it, so a *different* finger elsewhere is not
      // reported as "over UI" (that is what lets a floating joystick start next to a scrolling list).
      // Pseudo-pointers carry no real id and fall back to the aggregate.
      if (pointerId >= 0) {
        input?.registerHover(this.nodeId, pointerId);
      } else {
        input?.registerHover(this.nodeId);
      }
    }

    if (!this.pointerWasDown && isPointerDown) {
      this.pointerStartedInside = pointerInBounds;
      this.pointerDownWorldY = pointerWorld.y;
      this.lastPointerWorldY = pointerWorld.y;
      this.pointerDownScrollY = this.scrollY;
      this.scrollVelocity = 0;

      if (pointerInBounds && this.isPointInThumbBounds(pointerWorld)) {
        this.dragMode = 'thumb';
      }
    } else if (this.pointerWasDown && !isPointerDown) {
      this.pointerStartedInside = false;
      this.dragMode = null;
      // The gesture is over: stop following that pointer, so the container is free to claim the next
      // one (including a finger that is already down elsewhere on screen).
      this.ownedPointerId = null;
    }

    if (this.wheelScrollEnabled && input && pointerInBounds && input.wheelDelta.y !== 0) {
      this.scrollY += input.wheelDelta.y * this.wheelSensitivity;
      this.scrollVelocity = 0;
    }

    if (isPointerDown && this.dragMode === 'thumb') {
      const travel = Math.max(1, this.height - this.thumbHeight);
      const scrollRange = Math.max(0, this.getMaxScrollY());
      if (scrollRange > 0) {
        const deltaY = this.pointerWorld.y - this.pointerDownWorldY;
        this.scrollY = this.pointerDownScrollY - (deltaY * scrollRange) / travel;
      }
    } else if (this.dragScrollEnabled && isPointerDown && this.pointerStartedInside) {
      const deltaFromStart = this.pointerWorld.y - this.pointerDownWorldY;
      if (this.dragMode === 'content') {
        const deltaY = this.pointerWorld.y - this.lastPointerWorldY;
        this.scrollY += deltaY;
        const safeDt = Math.max(1 / 240, dt);
        this.scrollVelocity = deltaY / safeDt;
      } else if (Math.abs(deltaFromStart) >= this.dragThreshold && this.getMaxScrollY() > 0) {
        this.dragMode = 'content';
        this.lastPointerWorldY = this.pointerWorld.y;
      }
    } else if (
      !isPointerDown &&
      this.dragMode === null &&
      this.inertiaEnabled &&
      Math.abs(this.scrollVelocity) > 0.5
    ) {
      const decay = Math.exp(-this.inertiaDamping * Math.max(0, dt));
      const averageVelocity = this.scrollVelocity * (1 + decay) * 0.5;
      this.scrollY += averageVelocity * Math.max(0, dt);
      this.scrollVelocity *= decay;
      if (Math.abs(this.scrollVelocity) < 0.5) {
        this.scrollVelocity = 0;
      }
    }

    if (!isPointerDown && (this.scrollY <= 0 || this.scrollY >= this.getMaxScrollY())) {
      this.scrollVelocity = 0;
    }

    this.lastPointerWorldY = this.pointerWorld.y;
    this.pointerWasDown = isPointerDown;
    this.scrollY = this._scrollY;
  }

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
  private resolveDrivingPointer(input: InputService): DrivingPointer | null {
    const candidates = this.collectCandidatePointers(input);

    const owned = this.ownedPointerId;
    if (owned !== null) {
      const current = candidates.find(candidate => candidate.pointerId === owned);
      if (current) {
        return this.resolveCandidate(current);
      }
      return this.finishOwnedPointer(input, owned);
    }

    let observed: DrivingPointer | null = null;
    for (const candidate of candidates) {
      const resolved = this.resolveCandidate(candidate);
      if (!resolved) continue;
      const inBounds = this.isPointInViewportBounds(this.candidateWorld);
      if (candidate.down && inBounds) {
        this.ownedPointerId = candidate.pointerId;
        return resolved;
      }
      if (inBounds || observed === null) {
        observed = { ...resolved, down: false };
      }
      if (inBounds) break;
    }
    return observed;
  }

  /**
   * Every pointer this container may consider this frame, in press order. Falls back to ONE
   * synthetic pointer at the shared `pointerPosition` when the addressed map is empty — see
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

  /** Unproject a candidate into world units (also left in {@link candidateWorld} for hit tests). */
  private resolveCandidate(candidate: CandidatePointer): DrivingPointer | null {
    const world = this.screenPointToWorld(candidate.x, candidate.y, this.candidateWorld);
    if (!world) return null;
    return {
      pointerId: candidate.pointerId,
      worldX: world.x,
      worldY: world.y,
      down: candidate.down,
    };
  }

  /** Close the gesture the way the owned pointer ended (see {@link resolveDrivingPointer}). */
  private finishOwnedPointer(input: InputService, ownedPointerId: number): DrivingPointer {
    const terminal = ScrollContainer2D.findTerminalEvent(input, ownedPointerId);
    if (terminal?.type === 'up') {
      const world = this.screenPointToWorld(terminal.x, terminal.y, this.candidateWorld);
      if (world) {
        return { pointerId: ownedPointerId, worldX: world.x, worldY: world.y, down: false };
      }
    } else {
      this.scrollVelocity = 0;
    }
    // No usable terminal coordinates: end the gesture where the pointer was last seen.
    return {
      pointerId: ownedPointerId,
      worldX: this.pointerWorld.x,
      worldY: this.pointerWorld.y,
      down: false,
    };
  }

  /** The last `'up'` / `'cancel'` this frame carried for the given pointer, if any. */
  private static findTerminalEvent(
    input: InputService,
    pointerId: number
  ): { type: string; x: number; y: number } | null {
    const events = input.pointerEvents;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.pointerId !== pointerId) continue;
      if (event.type === 'up' || event.type === 'cancel') return event;
    }
    return null;
  }

  private getScrollableChildren(): Node2D[] {
    const scrollableChildren: Node2D[] = [];
    for (const child of this.children) {
      if (child instanceof Node2D) {
        scrollableChildren.push(child);
      }
    }
    return scrollableChildren;
  }

  private hasScrollableChildren(): boolean {
    return this.getScrollableChildren().length > 0;
  }

  private applyScrollOffset(): void {
    const scrollableChildren = this.getScrollableChildren();
    if (scrollableChildren.length === 0) {
      this.lastAppliedScrollY = 0;
      return;
    }

    const clampedScrollY = ScrollContainer2D.clampScroll(this._scrollY, this.getMaxScrollY());
    if (!ScrollContainer2D.areClose(this._scrollY, clampedScrollY)) {
      this._scrollY = clampedScrollY;
    }

    for (const child of scrollableChildren) {
      const basePosition = this.syncChildBasePosition(child);
      child.position.set(basePosition.x, basePosition.y + clampedScrollY, basePosition.z);
    }

    this.lastAppliedScrollY = clampedScrollY;
  }

  private syncChildBasePosition(child: Node2D): Vector3 {
    const existingPosition = this.childBasePositions.get(child.nodeId);
    if (!existingPosition) {
      const nextBasePosition = child.position.clone();
      this.childBasePositions.set(child.nodeId, nextBasePosition);
      return nextBasePosition;
    }

    const expectedY = existingPosition.y + this.lastAppliedScrollY;
    if (
      !ScrollContainer2D.areClose(child.position.x, existingPosition.x) ||
      !ScrollContainer2D.areClose(child.position.z, existingPosition.z) ||
      !ScrollContainer2D.areClose(child.position.y, expectedY)
    ) {
      existingPosition.set(
        child.position.x,
        child.position.y - this.lastAppliedScrollY,
        child.position.z
      );
    }

    return existingPosition;
  }

  private applyClippingPlanes(): void {
    const scrollableChildren = this.getScrollableChildren();
    if (scrollableChildren.length === 0) {
      this.clearClippingPlanes();
      return;
    }

    this.getWorldPosition(this.tmpWorldPos);
    this.getWorldScale(this.tmpWorldScale);

    const halfWidth = (this.width * Math.abs(this.tmpWorldScale.x)) / 2;
    const halfHeight = (this.height * Math.abs(this.tmpWorldScale.y)) / 2;
    const left = this.tmpWorldPos.x - halfWidth;
    const right = this.tmpWorldPos.x + halfWidth;
    const bottom = this.tmpWorldPos.y - halfHeight;
    const top = this.tmpWorldPos.y + halfHeight;

    this.clippingPlanes[0].constant = -left;
    this.clippingPlanes[1].constant = right;
    this.clippingPlanes[2].constant = -bottom;
    this.clippingPlanes[3].constant = top;

    const nextMaterials = new Set<Material>();
    for (const scrollableChild of scrollableChildren) {
      scrollableChild.traverse((child: Object3D) => {
        const meshLike = child as Object3D & { material?: Material | Material[] };
        if (!meshLike.material) {
          return;
        }

        const materials = Array.isArray(meshLike.material)
          ? meshLike.material
          : [meshLike.material];
        for (const material of materials) {
          material.clippingPlanes = this.clippingPlanes;
          material.clipIntersection = false;
          material.needsUpdate = true;
          nextMaterials.add(material);
        }
      });
    }

    for (const material of this.appliedClippingMaterials) {
      if (!nextMaterials.has(material)) {
        material.clippingPlanes = null;
        material.needsUpdate = true;
      }
    }

    this.appliedClippingMaterials.clear();
    for (const material of nextMaterials) {
      this.appliedClippingMaterials.add(material);
    }
  }

  private clearClippingPlanes(): void {
    for (const material of this.appliedClippingMaterials) {
      material.clippingPlanes = null;
      material.needsUpdate = true;
    }
    this.appliedClippingMaterials.clear();
  }

  private syncScrollbarVisuals(): void {
    const contentHeight = this.getContentHeight();
    const maxScrollY = this.getMaxScrollY();
    const shouldShowScrollbar = this.showScrollbar && contentHeight > this.height + 0.001;

    this.trackMesh.visible = shouldShowScrollbar;
    this.thumbMesh.visible = shouldShowScrollbar;
    if (!shouldShowScrollbar) {
      return;
    }

    this.trackCenterX = this.width / 2 - this.scrollbarInset - this.scrollbarWidth / 2;

    const safeTrackHeight = Math.max(1, this.height);
    const thumbRatio = safeTrackHeight / Math.max(safeTrackHeight, contentHeight);
    this.thumbHeight = Math.max(
      this.scrollbarMinHeight,
      Math.min(safeTrackHeight, safeTrackHeight * thumbRatio)
    );
    const trackTravel = Math.max(0, safeTrackHeight - this.thumbHeight);
    const progress = maxScrollY > 0 ? Math.min(1, this.scrollY / maxScrollY) : 0;

    this.thumbCenterY = safeTrackHeight / 2 - this.thumbHeight / 2 - progress * trackTravel;
    this.trackMesh.position.set(this.trackCenterX, 0, 0.25);
    this.thumbMesh.position.set(this.trackCenterX, this.thumbCenterY, 0.3);

    if (
      !ScrollContainer2D.areClose(this.trackGeometry.parameters.width, this.scrollbarWidth) ||
      !ScrollContainer2D.areClose(this.trackGeometry.parameters.height, safeTrackHeight)
    ) {
      this.trackGeometry.dispose();
      this.trackGeometry = new PlaneGeometry(this.scrollbarWidth, safeTrackHeight);
      this.trackMesh.geometry = this.trackGeometry;
    }

    if (
      !ScrollContainer2D.areClose(this.thumbGeometry.parameters.width, this.scrollbarWidth) ||
      !ScrollContainer2D.areClose(this.thumbGeometry.parameters.height, this.thumbHeight)
    ) {
      this.thumbGeometry.dispose();
      this.thumbGeometry = new PlaneGeometry(this.scrollbarWidth, this.thumbHeight);
      this.thumbMesh.geometry = this.thumbGeometry;
    }

    this.trackMaterial.color.setStyle(this.scrollbarTrackColor);
    this.thumbMaterial.color.setStyle(this.scrollbarColor);
  }

  private getContentBounds(): { minY: number; maxY: number } | null {
    const scrollableChildren = this.getScrollableChildren();
    if (scrollableChildren.length === 0) {
      return null;
    }

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const child of scrollableChildren) {
      const basePosition = this.syncChildBasePosition(child);
      const extents = this.getChildVerticalExtents(child);
      minY = Math.min(minY, basePosition.y + extents.minY);
      maxY = Math.max(maxY, basePosition.y + extents.maxY);
    }

    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
      return null;
    }

    return { minY, maxY };
  }

  private getChildVerticalExtents(child: Node2D): { minY: number; maxY: number } {
    const size = child.getCurrentLayoutSize();
    const height = Math.max(0, size.height);
    const childWithOptionalAnchor = child as Node2D & { anchor?: { y?: number } };
    const anchorY = ScrollContainer2D.clampNormalizedAnchor(
      childWithOptionalAnchor.anchor?.y ?? 0.5
    );
    return {
      minY: -anchorY * height,
      maxY: (1 - anchorY) * height,
    };
  }

  private isPointInThumbBounds(worldPoint: Vector2): boolean {
    if (!this.showScrollbar || !this.thumbMesh.visible) {
      return false;
    }

    this.getWorldPosition(this.tmpWorldPos);
    this.getWorldScale(this.tmpWorldScale);

    const centerX = this.tmpWorldPos.x + this.trackCenterX * this.tmpWorldScale.x;
    const centerY = this.tmpWorldPos.y + this.thumbCenterY * this.tmpWorldScale.y;
    const halfWidth = (this.scrollbarWidth * Math.abs(this.tmpWorldScale.x)) / 2;
    const halfHeight = (this.thumbHeight * Math.abs(this.tmpWorldScale.y)) / 2;

    return (
      worldPoint.x >= centerX - halfWidth &&
      worldPoint.x <= centerX + halfWidth &&
      worldPoint.y >= centerY - halfHeight &&
      worldPoint.y <= centerY + halfHeight
    );
  }

  private static areClose(left: number, right: number): boolean {
    return Math.abs(left - right) <= 0.001;
  }

  private static clampScroll(value: number, maxScrollY: number): number {
    const safeValue = Number.isFinite(value) ? value : 0;
    const safeMax = Number.isFinite(maxScrollY) ? Math.max(0, maxScrollY) : safeValue;
    return Math.max(0, Math.min(safeValue, safeMax));
  }

  private static clampNormalizedAnchor(value: number): number {
    if (!Number.isFinite(value)) {
      return 0.5;
    }
    return Math.max(0, Math.min(1, value));
  }
}
