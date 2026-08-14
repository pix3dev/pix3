import { MathUtils, type Material, Vector2, Vector3 } from 'three';

import { NodeBase, type NodeBaseProps } from './NodeBase';
import type { PropertySchema } from '../fw/property-schema';
import {
  getNodePropertySchema,
  getPropertyDefinition,
  setNodePropertyValue,
} from '../fw/property-schema-utils';
import { LAYER_2D } from '../constants';

export type Node2DHorizontalAlign = 'left' | 'center' | 'right' | 'stretch';
export type Node2DVerticalAlign = 'top' | 'center' | 'bottom' | 'stretch';

export interface Node2DLayoutConfig {
  enabled?: boolean;
  horizontalAlign?: Node2DHorizontalAlign;
  verticalAlign?: Node2DVerticalAlign;
}

export interface Node2DLayoutSize {
  width: number;
  height: number;
}

export interface Node2DLayoutPosition {
  x: number;
  y: number;
}

export interface Node2DProps extends Omit<NodeBaseProps, 'type'> {
  position?: Vector2;
  scale?: Vector2;
  rotation?: number; // degrees
  opacity?: number;
  layout?: Node2DLayoutConfig;
  zIndex?: number;
  zAsRelative?: boolean;
}

/** Godot-compatible bound for {@link Node2D.zIndex}. */
export const Z_INDEX_LIMIT = 4096;

export class Node2D extends NodeBase {
  /** Shared scratch for pointer unprojection (single-threaded, reused per call). */
  private static readonly scratchUnproject = new Vector3();
  /**
   * Marks this node as a CanvasLayer2D boundary — its subtree renders in the
   * fixed overlay band (LAYER_2D_OVERLAY) through the identity overlay camera,
   * unaffected by an active Camera2D. Set by the CanvasLayer2D constructor.
   */
  isCanvasLayer = false;
  private _opacity: number;
  private _computedOpacity: number;
  private _zIndex: number;
  private _zAsRelative: boolean;
  private _layoutEnabled: boolean;
  private _horizontalAlign: Node2DHorizontalAlign;
  private _verticalAlign: Node2DVerticalAlign;
  private readonly authoredLayoutPosition = new Vector2();
  private readonly authoredLayoutSize = new Vector2();
  protected readonly tmpPointerWorld = new Vector2();
  private hasAuthoredLayoutSize = false;
  private readonly opacityMaterials: Set<Material> = new Set();
  private visibleOpacity: number;
  private visibilityFade: {
    from: number;
    to: number;
    duration: number;
    elapsed: number;
    hideAfterComplete: boolean;
    onComplete?: () => void;
  } | null = null;

  constructor(props: Node2DProps, nodeType: string = 'Node2D') {
    super({ ...props, type: nodeType });

    this.layers.set(LAYER_2D);

    const position = props.position ?? new Vector2(0, 0);
    this.position.set(position.x, position.y, 0);

    const scale = props.scale ?? new Vector2(1, 1);
    this.scale.set(scale.x, scale.y, 1);

    const rotationDegrees = props.rotation ?? 0;
    const rotationRadians = MathUtils.degToRad(rotationDegrees);
    this.rotation.set(0, 0, rotationRadians);

    const layout = Node2D.normalizeLayout(props.layout);
    this._layoutEnabled = layout.enabled;
    this._horizontalAlign = layout.horizontalAlign;
    this._verticalAlign = layout.verticalAlign;
    this.authoredLayoutPosition.set(position.x, position.y);

    const initialLayoutSize = Node2D.readInitialLayoutSize(props);
    if (initialLayoutSize) {
      this.authoredLayoutSize.copy(initialLayoutSize);
      this.hasAuthoredLayoutSize = true;
    }

    this._opacity = Node2D.clampOpacity(props.opacity ?? 1);
    this._computedOpacity = this._opacity;
    this.visibleOpacity = this._opacity > 0 ? this._opacity : 1;
    if (props.opacity !== undefined || typeof this.properties.opacity === 'number') {
      this.properties.opacity = this._opacity;
    }

    // Draw-order override. Authored values arrive in `properties` (the loader
    // hands the raw YAML bag to every node type), so reading them here covers
    // every Node2D subclass without touching SceneLoader.
    this._zIndex = Node2D.clampZIndex(props.zIndex ?? this.properties.zIndex);
    this._zAsRelative =
      typeof props.zAsRelative === 'boolean'
        ? props.zAsRelative
        : typeof this.properties.zAsRelative === 'boolean'
          ? this.properties.zAsRelative
          : true;
    this.syncZOrderProperties();

    this.syncLayoutProperties();
  }

  get opacity(): number {
    return this._opacity;
  }

  set opacity(value: number) {
    const nextOpacity = Node2D.clampOpacity(value);
    if (this._opacity === nextOpacity) {
      return;
    }

    this._opacity = nextOpacity;
    this.properties.opacity = nextOpacity;
    if (!this.visibilityFade && nextOpacity > 0) {
      this.visibleOpacity = nextOpacity;
    }
    this.refreshComputedOpacityRecursive();
  }

  get computedOpacity(): number {
    return this._computedOpacity;
  }

  /**
   * Draw-order override for the 2D pass (Godot `z_index`). Higher draws on top.
   *
   * The 2D pass has no depth test, so paint order is normally the scene-tree DFS
   * order (see `assign2DRenderOrder`). `zIndex` lifts a node out of that order
   * without moving it in the tree: nodes are bucketed by effective z first, and
   * tree order only breaks ties inside a bucket.
   */
  get zIndex(): number {
    return this._zIndex;
  }

  set zIndex(value: number) {
    const next = Node2D.clampZIndex(value);
    if (this._zIndex === next) {
      return;
    }
    this._zIndex = next;
    this.syncZOrderProperties();
  }

  /**
   * When `true` (the default, as in Godot) {@link zIndex} is added to the parent's
   * effective z, so a subtree keeps its internal layering wherever it is reparented.
   * When `false` the node's `zIndex` is absolute — use it for "always on top"
   * overlays that must not inherit an ancestor's offset.
   */
  get zAsRelative(): boolean {
    return this._zAsRelative;
  }

  set zAsRelative(value: boolean) {
    const next = Boolean(value);
    if (this._zAsRelative === next) {
      return;
    }
    this._zAsRelative = next;
    this.syncZOrderProperties();
  }

  /** Effective (inherited) z used by the render-order walk. */
  get effectiveZIndex(): number {
    if (!this._zAsRelative) {
      return this._zIndex;
    }
    const parent = this.parent;
    return parent instanceof Node2D ? parent.effectiveZIndex + this._zIndex : this._zIndex;
  }

  get layoutEnabled(): boolean {
    return this._layoutEnabled;
  }

  set layoutEnabled(value: boolean) {
    const nextValue = Boolean(value);
    if (this._layoutEnabled === nextValue) {
      return;
    }

    this.captureAuthoredLayoutRectFromCurrent();
    this._layoutEnabled = nextValue;
    this.syncLayoutProperties();
  }

  get horizontalAlign(): Node2DHorizontalAlign {
    return this._horizontalAlign;
  }

  set horizontalAlign(value: Node2DHorizontalAlign) {
    const nextValue = Node2D.normalizeHorizontalAlign(value);
    if (this._horizontalAlign === nextValue) {
      return;
    }

    this._horizontalAlign = nextValue;
    this.syncLayoutProperties();
  }

  get verticalAlign(): Node2DVerticalAlign {
    return this._verticalAlign;
  }

  set verticalAlign(value: Node2DVerticalAlign) {
    const nextValue = Node2D.normalizeVerticalAlign(value);
    if (this._verticalAlign === nextValue) {
      return;
    }

    this._verticalAlign = nextValue;
    this.syncLayoutProperties();
  }

  getLayoutConfig(): Node2DLayoutConfig {
    return {
      enabled: this._layoutEnabled,
      horizontalAlign: this._horizontalAlign,
      verticalAlign: this._verticalAlign,
    };
  }

  setLayoutConfig(layout: Node2DLayoutConfig | null | undefined): void {
    const normalized = Node2D.normalizeLayout(layout);
    this.captureAuthoredLayoutRectFromCurrent();
    this._layoutEnabled = normalized.enabled;
    this._horizontalAlign = normalized.horizontalAlign;
    this._verticalAlign = normalized.verticalAlign;
    this.syncLayoutProperties();
  }

  captureAuthoredLayoutRectFromCurrent(): void {
    this.authoredLayoutPosition.set(this.position.x, this.position.y);
    const currentSize = this.getCurrentLayoutSize();
    if (currentSize.width > 0 && currentSize.height > 0) {
      this.authoredLayoutSize.set(currentSize.width, currentSize.height);
      this.hasAuthoredLayoutSize = true;
    }
  }

  getAuthoredLayoutPosition(): Node2DLayoutPosition {
    return { x: this.authoredLayoutPosition.x, y: this.authoredLayoutPosition.y };
  }

  setAuthoredLayoutPosition(x: number, y: number): void {
    this.authoredLayoutPosition.set(x, y);
  }

  getAuthoredLayoutSize(): Node2DLayoutSize {
    this.ensureAuthoredLayoutSize();
    return {
      width: this.authoredLayoutSize.x,
      height: this.authoredLayoutSize.y,
    };
  }

  setAuthoredLayoutSize(width: number, height: number): void {
    this.authoredLayoutSize.set(Math.max(0, width), Math.max(0, height));
    this.hasAuthoredLayoutSize = true;
  }

  /**
   * The world position of the **primary** pointer (the oldest one still down; with nothing down,
   * the last hover position), or null without an input service.
   *
   * Deliberately left primary-derived when the rest of the engine switched to addressed pointers:
   * it has **no caller inside this repository** and exists purely as compatibility for user scripts
   * and consumer projects written against the single-pointer engine, where "the pointer" was
   * unambiguous. Nothing that has to follow *its own* finger may use it — resolve that finger's
   * coordinates with {@link screenPointToWorld} (see `UIControl2D`'s pointer ownership), or ask
   * `scene.getPointer2DWorldPosition(pointerId)` from a script.
   */
  protected getPointerWorldPosition(target: Vector2 = this.tmpPointerWorld): Vector2 | null {
    const input = this.input;
    if (!input) {
      return null;
    }
    return this.screenPointToWorld(input.pointerPosition.x, input.pointerPosition.y, target);
  }

  /**
   * Convert a point in **input/screen units** (the units of `InputService.pointerPosition` and of
   * every `PointerSnapshot`) into 2D world units, through the same projection
   * {@link getPointerWorldPosition} uses. Returns null without an input service, whose `width` /
   * `height` define the screen rect.
   *
   * This exists because multi-touch made "the pointer position" ambiguous: a control owning finger
   * #2 has to unproject #2's coordinates, not whatever the shared primary position happens to hold.
   */
  protected screenPointToWorld(
    screenX: number,
    screenY: number,
    target: Vector2 = this.tmpPointerWorld
  ): Vector2 | null {
    const input = this.input;
    if (!input) {
      return null;
    }

    const inputWidth = Math.max(1, input.width);
    const inputHeight = Math.max(1, input.height);

    // Unproject through the live 2D ortho camera so pointer→world stays correct
    // when a Camera2D pans / zooms the 2D pass (Joystick2D, drag hit-tests, etc.).
    // The camera's matrices reflect the previous frame's applied framing — a
    // sub-frame lag that is imperceptible for input. Falls back to the fixed
    // logical-size mapping when no UI camera is available (editor / no scene).
    //
    // Overlay-band nodes (under a CanvasLayer2D) are pinned by the identity
    // overlay camera, NOT the Camera2D-driven main camera — so they must use the
    // logical-size mapping (mathematically identical to the identity view) or
    // their hit-tests would drift by the camera pan. Skip the uiCamera branch.
    const uiCamera = this.scene?.getUICamera();
    if (uiCamera && !this.isInOverlayBand()) {
      const ndcX = (screenX / inputWidth) * 2 - 1;
      const ndcY = -((screenY / inputHeight) * 2 - 1);
      Node2D.scratchUnproject.set(ndcX, ndcY, 0).unproject(uiCamera);
      target.set(Node2D.scratchUnproject.x, Node2D.scratchUnproject.y);
      return target;
    }

    const logicalCameraSize = this.scene?.getLogicalCameraSize();
    const worldWidth =
      logicalCameraSize && Number.isFinite(logicalCameraSize.width) && logicalCameraSize.width > 0
        ? logicalCameraSize.width
        : inputWidth;
    const worldHeight =
      logicalCameraSize && Number.isFinite(logicalCameraSize.height) && logicalCameraSize.height > 0
        ? logicalCameraSize.height
        : inputHeight;

    target.set(
      (screenX / inputWidth) * worldWidth - worldWidth / 2,
      worldHeight / 2 - (screenY / inputHeight) * worldHeight
    );
    return target;
  }

  /** True when this node or an ancestor is a CanvasLayer2D (fixed overlay band). */
  protected isInOverlayBand(): boolean {
    let current: Node2D | null = this;
    while (current) {
      if (current.isCanvasLayer) {
        return true;
      }
      current = current.parent instanceof Node2D ? current.parent : null;
    }
    return false;
  }

  applyAnchoredLayoutRecursive(
    referenceCurrentSize: Node2DLayoutSize,
    referenceAuthoredSize?: Node2DLayoutSize
  ): void {
    if (this._layoutEnabled) {
      this.applyAnchoredLayout(referenceCurrentSize, referenceAuthoredSize);
    }

    const nextCurrentSize = this.getCurrentLayoutSize();
    const nextAuthoredSize = this.getAuthoredLayoutSize();
    for (const child of this.children) {
      if (child instanceof Node2D) {
        child.applyAnchoredLayoutRecursive(nextCurrentSize, nextAuthoredSize);
      }
    }
  }

  reflowAnchoredChildren(): void {
    const currentSize = this.getCurrentLayoutSize();
    const authoredSize = this.getAuthoredLayoutSize();
    for (const child of this.children) {
      if (child instanceof Node2D) {
        child.applyAnchoredLayoutRecursive(currentSize, authoredSize);
      }
    }
  }

  getCurrentLayoutSize(): Node2DLayoutSize {
    const currentSize = this.readCurrentLayoutSize();
    if (currentSize) {
      return currentSize;
    }

    if (this.hasAuthoredLayoutSize) {
      return { width: this.authoredLayoutSize.x, height: this.authoredLayoutSize.y };
    }

    return { width: 0, height: 0 };
  }

  serializeLayout(): Record<string, unknown> | undefined {
    if (!this._layoutEnabled) {
      return undefined;
    }

    return {
      enabled: true,
      horizontalAlign: this._horizontalAlign,
      verticalAlign: this._verticalAlign,
    };
  }

  /**
   * Hides this node with optional fade-out time in seconds.
   * When fade completes, the node visibility is set to false.
   */
  hide(fadeTime: number = 0, onComplete?: () => void): void {
    const duration = Node2D.toNonNegativeSeconds(fadeTime);
    if (this.opacity > 0) {
      this.visibleOpacity = this.opacity;
    }

    if (duration === 0) {
      this.visibilityFade = null;
      this.opacity = 0;
      this.setVisibleState(false);
      onComplete?.();
      return;
    }

    this.setVisibleState(true);
    this.visibilityFade = {
      from: this.opacity,
      to: 0,
      duration,
      elapsed: 0,
      hideAfterComplete: true,
      onComplete,
    };
  }

  /**
   * Shows this node with optional fade-in time in seconds.
   */
  show(fadeTime: number = 0, onComplete?: () => void): void {
    const duration = Node2D.toNonNegativeSeconds(fadeTime);
    const targetOpacity = this.visibleOpacity > 0 ? this.visibleOpacity : 1;

    this.setVisibleState(true);

    if (duration === 0) {
      this.visibilityFade = null;
      this.opacity = targetOpacity;
      onComplete?.();
      return;
    }

    this.visibilityFade = {
      from: this.opacity,
      to: targetOpacity,
      duration,
      elapsed: 0,
      hideAfterComplete: false,
      onComplete,
    };
  }

  override tick(dt: number): void {
    super.tick(dt);

    if (!this.visibilityFade) {
      return;
    }

    const fade = this.visibilityFade;
    fade.elapsed = Math.min(fade.duration, fade.elapsed + Math.max(0, dt));
    const t = fade.duration > 0 ? fade.elapsed / fade.duration : 1;
    const nextOpacity = fade.from + (fade.to - fade.from) * t;
    this.opacity = nextOpacity;

    if (fade.elapsed < fade.duration) {
      return;
    }

    this.opacity = fade.to;
    this.visibilityFade = null;
    if (fade.hideAfterComplete) {
      this.setVisibleState(false);
      fade.onComplete?.();
      return;
    }

    this.setVisibleState(true);
    fade.onComplete?.();
  }

  protected registerOpacityMaterial(material: Material, baseOpacity?: number): void {
    if (baseOpacity !== undefined) {
      material.userData.__pix3BaseOpacity = Node2D.clampOpacity(baseOpacity);
    } else if (typeof material.userData.__pix3BaseOpacity !== 'number') {
      material.userData.__pix3BaseOpacity = Node2D.clampOpacity(material.opacity);
    }

    if (material.userData.__pix3OriginalTransparent === undefined) {
      material.userData.__pix3OriginalTransparent = material.transparent;
    }

    this.opacityMaterials.add(material);
    this.applyOpacityToMaterial(material);
  }

  protected setOpacityMaterialBase(material: Material, baseOpacity: number): void {
    material.userData.__pix3BaseOpacity = Node2D.clampOpacity(baseOpacity);

    if (material.userData.__pix3OriginalTransparent === undefined) {
      material.userData.__pix3OriginalTransparent = material.transparent;
    }

    this.opacityMaterials.add(material);
    this.applyOpacityToMaterial(material);
  }

  private applyOpacityToMaterial(material: Material): void {
    const baseOpacityRaw = material.userData.__pix3BaseOpacity;
    const baseOpacity =
      typeof baseOpacityRaw === 'number'
        ? Node2D.clampOpacity(baseOpacityRaw)
        : Node2D.clampOpacity(material.opacity);
    material.opacity = baseOpacity * this._computedOpacity;

    const originalTransparent = material.userData.__pix3OriginalTransparent;
    material.transparent = originalTransparent || material.opacity < 1;
    material.needsUpdate = true;
  }

  public refreshOpacity(): void {
    this.refreshComputedOpacityRecursive();
  }

  private getParentComputedOpacity(): number {
    return this.parent instanceof Node2D ? this.parent.computedOpacity : 1;
  }

  private refreshComputedOpacityRecursive(): void {
    this._computedOpacity = this._opacity * this.getParentComputedOpacity();

    for (const material of this.opacityMaterials) {
      this.applyOpacityToMaterial(material);
    }

    for (const child of this.children) {
      if (child instanceof Node2D) {
        child.refreshComputedOpacityRecursive();
      }
    }
  }

  private static clampOpacity(value: number): number {
    const safe = Number.isFinite(value) ? value : 1;
    return Math.max(0, Math.min(1, safe));
  }

  private static normalizeLayout(layout: Node2DLayoutConfig | null | undefined): {
    enabled: boolean;
    horizontalAlign: Node2DHorizontalAlign;
    verticalAlign: Node2DVerticalAlign;
  } {
    return {
      enabled: Boolean(layout?.enabled),
      horizontalAlign: Node2D.normalizeHorizontalAlign(layout?.horizontalAlign),
      verticalAlign: Node2D.normalizeVerticalAlign(layout?.verticalAlign),
    };
  }

  private static normalizeHorizontalAlign(value: unknown): Node2DHorizontalAlign {
    switch (value) {
      case 'left':
      case 'right':
      case 'stretch':
        return value;
      default:
        return 'center';
    }
  }

  private static normalizeVerticalAlign(value: unknown): Node2DVerticalAlign {
    switch (value) {
      case 'top':
      case 'bottom':
      case 'stretch':
        return value;
      default:
        return 'center';
    }
  }

  private static readInitialLayoutSize(props: Node2DProps): Vector2 | null {
    const record = props as unknown as Record<string, unknown>;
    const width = Node2D.toFiniteNumber(record.width);
    const height = Node2D.toFiniteNumber(record.height);
    if (width !== undefined && height !== undefined) {
      return new Vector2(Math.max(0, width), Math.max(0, height));
    }

    const size = Node2D.toFiniteNumber(record.size);
    if (size !== undefined) {
      return new Vector2(Math.max(0, size), Math.max(0, size));
    }

    const radius = Node2D.toFiniteNumber(record.radius);
    if (radius !== undefined) {
      return new Vector2(Math.max(0, radius * 2), Math.max(0, radius * 2));
    }

    return null;
  }

  private static toFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private static toNonNegativeSeconds(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, value);
  }

  private setVisibleState(value: boolean): void {
    this.visible = value;
    this.properties.visible = value;
  }

  private ensureAuthoredLayoutSize(): void {
    if (this.hasAuthoredLayoutSize) {
      return;
    }

    const currentSize = this.readCurrentLayoutSize();
    if (!currentSize) {
      return;
    }

    this.authoredLayoutSize.set(currentSize.width, currentSize.height);
    this.hasAuthoredLayoutSize = true;
  }

  private readCurrentLayoutSize(): Node2DLayoutSize | null {
    const record = this as unknown as Record<string, unknown>;
    const width = Node2D.toFiniteNumber(record.width);
    const height = Node2D.toFiniteNumber(record.height);
    if (width !== undefined && height !== undefined) {
      return { width: Math.max(0, width), height: Math.max(0, height) };
    }

    const size = Node2D.toFiniteNumber(record.size);
    if (size !== undefined) {
      const normalizedSize = Math.max(0, size);
      return { width: normalizedSize, height: normalizedSize };
    }

    const radius = Node2D.toFiniteNumber(record.radius);
    if (radius !== undefined) {
      const diameter = Math.max(0, radius * 2);
      return { width: diameter, height: diameter };
    }

    return null;
  }

  private applyAnchoredLayout(
    referenceCurrentSize: Node2DLayoutSize,
    referenceAuthoredSize?: Node2DLayoutSize
  ): void {
    this.ensureAuthoredLayoutSize();

    const authoredSize = this.getAuthoredLayoutSize();
    const authoredReference = this.normalizeReferenceSize(
      referenceAuthoredSize ?? referenceCurrentSize
    );
    const currentReference = this.normalizeReferenceSize(referenceCurrentSize);

    const resolvedHorizontal = this.resolveHorizontalLayout(
      currentReference.width,
      authoredReference.width,
      this.authoredLayoutPosition.x,
      authoredSize.width
    );
    const resolvedVertical = this.resolveVerticalLayout(
      currentReference.height,
      authoredReference.height,
      this.authoredLayoutPosition.y,
      authoredSize.height
    );

    this.position.set(resolvedHorizontal.center, resolvedVertical.center, this.position.z);
    this.applyCurrentLayoutSize(resolvedHorizontal.size, resolvedVertical.size);
  }

  private normalizeReferenceSize(size: Node2DLayoutSize): Node2DLayoutSize {
    return {
      width: Math.max(1, size.width || 0),
      height: Math.max(1, size.height || 0),
    };
  }

  private resolveHorizontalLayout(
    currentReferenceWidth: number,
    authoredReferenceWidth: number,
    authoredCenterX: number,
    authoredWidth: number
  ): { center: number; size: number } {
    const safeAuthoredWidth = Math.max(0, authoredWidth);
    const authoredLeft = authoredCenterX - safeAuthoredWidth / 2;
    const authoredRight = authoredCenterX + safeAuthoredWidth / 2;
    const leftMargin = authoredLeft + authoredReferenceWidth / 2;
    const rightMargin = authoredReferenceWidth / 2 - authoredRight;

    switch (this._horizontalAlign) {
      case 'left': {
        const left = -currentReferenceWidth / 2 + leftMargin;
        return { center: left + safeAuthoredWidth / 2, size: safeAuthoredWidth };
      }
      case 'right': {
        const right = currentReferenceWidth / 2 - rightMargin;
        return { center: right - safeAuthoredWidth / 2, size: safeAuthoredWidth };
      }
      case 'stretch': {
        const left = -currentReferenceWidth / 2 + leftMargin;
        const right = currentReferenceWidth / 2 - rightMargin;
        const size = Math.max(1, right - left);
        return { center: (left + right) / 2, size };
      }
      default:
        return { center: authoredCenterX, size: safeAuthoredWidth };
    }
  }

  private resolveVerticalLayout(
    currentReferenceHeight: number,
    authoredReferenceHeight: number,
    authoredCenterY: number,
    authoredHeight: number
  ): { center: number; size: number } {
    const safeAuthoredHeight = Math.max(0, authoredHeight);
    const authoredBottom = authoredCenterY - safeAuthoredHeight / 2;
    const authoredTop = authoredCenterY + safeAuthoredHeight / 2;
    const bottomMargin = authoredBottom + authoredReferenceHeight / 2;
    const topMargin = authoredReferenceHeight / 2 - authoredTop;

    switch (this._verticalAlign) {
      case 'bottom': {
        const bottom = -currentReferenceHeight / 2 + bottomMargin;
        return { center: bottom + safeAuthoredHeight / 2, size: safeAuthoredHeight };
      }
      case 'top': {
        const top = currentReferenceHeight / 2 - topMargin;
        return { center: top - safeAuthoredHeight / 2, size: safeAuthoredHeight };
      }
      case 'stretch': {
        const bottom = -currentReferenceHeight / 2 + bottomMargin;
        const top = currentReferenceHeight / 2 - topMargin;
        const size = Math.max(1, top - bottom);
        return { center: (top + bottom) / 2, size };
      }
      default:
        return { center: authoredCenterY, size: safeAuthoredHeight };
    }
  }

  private applyCurrentLayoutSize(width: number, height: number): void {
    const schema = getNodePropertySchema(this);
    const widthProp = getPropertyDefinition(schema, 'width');
    const heightProp = getPropertyDefinition(schema, 'height');

    if (widthProp && heightProp) {
      setNodePropertyValue(this, widthProp, width);
      setNodePropertyValue(this, heightProp, height);
      return;
    }

    const sizeProp = getPropertyDefinition(schema, 'size');
    if (sizeProp) {
      setNodePropertyValue(this, sizeProp, Math.max(width, height));
      return;
    }

    const radiusProp = getPropertyDefinition(schema, 'radius');
    if (radiusProp) {
      setNodePropertyValue(this, radiusProp, Math.min(width, height) / 2);
    }
  }

  private static clampZIndex(value: unknown): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return Math.max(-Z_INDEX_LIMIT, Math.min(Z_INDEX_LIMIT, Math.round(numeric)));
  }

  /**
   * Mirrors the z-order fields into `properties` so SceneSaver persists them for
   * free (it spreads `node.properties`). Defaults are deleted rather than written,
   * so scenes that never touch z-order serialize exactly as before.
   */
  private syncZOrderProperties(): void {
    if (this._zIndex !== 0) {
      this.properties.zIndex = this._zIndex;
    } else {
      delete this.properties.zIndex;
    }

    if (!this._zAsRelative) {
      this.properties.zAsRelative = false;
    } else {
      delete this.properties.zAsRelative;
    }
  }

  private syncLayoutProperties(): void {
    if (!this._layoutEnabled) {
      delete this.properties.layout;
      return;
    }

    this.properties.layout = {
      enabled: true,
      horizontalAlign: this._horizontalAlign,
      verticalAlign: this._verticalAlign,
    };
  }

  /**
   * Override add to ensure all children of a Node2D inherit the 2D layer.
   */
  add(...object: import('three').Object3D[]): this {
    super.add(...object);

    // Enforce layer on all added objects and their descendants
    for (const obj of object) {
      obj.traverse(child => {
        child.layers.set(LAYER_2D);
      });

      if (obj instanceof Node2D) {
        obj.refreshComputedOpacityRecursive();
      }
    }

    return this;
  }

  /**
   * Get the property schema for Node2D.
   * Extends NodeBase schema with 2D-specific transform properties.
   */
  static getPropertySchema(): PropertySchema {
    const baseSchema = NodeBase.getPropertySchema();

    return {
      nodeType: 'Node2D',
      extends: 'NodeBase',
      properties: [
        ...baseSchema.properties,
        {
          name: 'position',
          type: 'vector2',
          ui: {
            label: 'Position',
            group: 'Transform',
            step: 0.01,
            precision: 2,
          },
          getValue: (node: unknown) => {
            const n = node as Node2D;
            return { x: n.position.x, y: n.position.y };
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as Node2D;
            const v = value as { x: number; y: number };
            n.position.x = v.x;
            n.position.y = v.y;
            n.setAuthoredLayoutPosition(v.x, v.y);
          },
        },
        {
          name: 'rotation',
          type: 'number',
          ui: {
            label: 'Rotation',
            description: 'Z-axis rotation',
            group: 'Transform',
            step: 0.1,
            precision: 1,
            unit: '°',
          },
          getValue: (node: unknown) => {
            const n = node as Node2D;
            return n.rotation.z * (180 / Math.PI); // Convert radians to degrees
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as Node2D;
            n.rotation.z = Number(value) * (Math.PI / 180); // Convert degrees to radians
          },
        },
        {
          name: 'scale',
          type: 'vector2',
          ui: {
            label: 'Scale',
            group: 'Transform',
            step: 0.01,
            precision: 2,
            min: 0,
          },
          getValue: (node: unknown) => {
            const n = node as Node2D;
            return { x: n.scale.x, y: n.scale.y };
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as Node2D;
            const v = value as { x: number; y: number };
            n.scale.x = v.x;
            n.scale.y = v.y;
          },
        },
        {
          name: 'opacity',
          type: 'number',
          ui: {
            label: 'Opacity',
            description: 'Local opacity multiplier inherited by child 2D nodes',
            group: 'Style',
            step: 0.01,
            precision: 2,
            min: 0,
            max: 1,
          },
          getValue: (node: unknown) => (node as Node2D).opacity,
          setValue: (node: unknown, value: unknown) => {
            (node as Node2D).opacity = Number(value);
          },
        },
        {
          name: 'zIndex',
          type: 'number',
          ui: {
            label: 'Z Index',
            description:
              'Draw-order override for the 2D pass. Higher draws on top; ties keep scene-tree order',
            group: 'Ordering',
            step: 1,
            precision: 0,
            min: -Z_INDEX_LIMIT,
            max: Z_INDEX_LIMIT,
          },
          getValue: (node: unknown) => (node as Node2D).zIndex,
          setValue: (node: unknown, value: unknown) => {
            (node as Node2D).zIndex = Number(value);
          },
        },
        {
          name: 'zAsRelative',
          type: 'boolean',
          ui: {
            label: 'Z Relative',
            description: "Add Z Index to the parent's effective z instead of using it as absolute",
            group: 'Ordering',
          },
          getValue: (node: unknown) => (node as Node2D).zAsRelative,
          setValue: (node: unknown, value: unknown) => {
            (node as Node2D).zAsRelative = Boolean(value);
          },
        },
        {
          name: 'layoutEnabled',
          type: 'boolean',
          ui: {
            label: 'Anchor',
            description: 'Enable anchor-based layout for this 2D node',
            group: 'Anchor',
          },
          getValue: (node: unknown) => (node as Node2D).layoutEnabled,
          setValue: (node: unknown, value: unknown) => {
            (node as Node2D).layoutEnabled = Boolean(value);
          },
        },
        {
          name: 'horizontalAlign',
          type: 'select',
          ui: {
            label: 'Horizontal',
            description: 'Horizontal anchor mode',
            group: 'Anchor',
            options: ['left', 'center', 'right', 'stretch'],
            readOnly: target => !(target instanceof Node2D) || !target.layoutEnabled,
          },
          getValue: (node: unknown) => (node as Node2D).horizontalAlign,
          setValue: (node: unknown, value: unknown) => {
            (node as Node2D).horizontalAlign = value as Node2DHorizontalAlign;
          },
        },
        {
          name: 'verticalAlign',
          type: 'select',
          ui: {
            label: 'Vertical',
            description: 'Vertical anchor mode',
            group: 'Anchor',
            options: ['top', 'center', 'bottom', 'stretch'],
            readOnly: target => !(target instanceof Node2D) || !target.layoutEnabled,
          },
          getValue: (node: unknown) => (node as Node2D).verticalAlign,
          setValue: (node: unknown, value: unknown) => {
            (node as Node2D).verticalAlign = value as Node2DVerticalAlign;
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Transform: {
          label: 'Transform',
          description: '2D position, rotation, and scale',
          expanded: true,
        },
        Style: {
          label: 'Style',
          description: '2D visual styling properties',
          expanded: false,
        },
        Ordering: {
          label: 'Ordering',
          description: 'Draw order within the 2D pass',
          expanded: false,
        },
        Anchor: {
          label: 'Anchor',
          description: 'Anchor-based layout relative to the containing frame',
          expanded: false,
        },
      },
    };
  }
}
