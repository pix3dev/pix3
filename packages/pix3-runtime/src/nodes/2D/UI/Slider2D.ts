import {
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Texture,
  Vector2,
} from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';
import { readNumberArg, type InteractionDescriptor } from '../../../fw/interactive';
import { installReactiveSchemaProperties } from '../../../fw/reactive-schema-properties';
import { coerceTextureResource, type TextureResourceRef } from '../../../core/TextureResource';
import { configure2DTexture } from '../../../core/configure-2d-texture';
import { getNaturalTextureSize } from '../../../core/texture-natural-size';
import {
  buildSkinGeometry,
  normalizeSliceBorder,
  type SliceBorder2D,
} from '../../../core/nine-slice-skin';

/** The three skin slots a slider can be given a sprite for. */
export type Slider2DTextureSlot = 'track' | 'fill' | 'thumb';

export interface Slider2DProps extends UIControl2DProps {
  width?: number;
  height?: number;
  handleSize?: number;
  trackBackgroundColor?: string;
  trackFilledColor?: string;
  handleColor?: string;
  minValue?: number;
  maxValue?: number;
  value?: number;
  axisName?: string;
  /** Sprite for the track background. */
  textureTrack?: TextureResourceRef | string | null;
  /** Sprite for the filled portion of the track (left of the handle). */
  textureFill?: TextureResourceRef | string | null;
  /** Sprite for the draggable handle. Never nine-sliced. */
  textureThumb?: TextureResourceRef | string | null;
  /** 9-slice insets (source px) applied to the track and the fill. */
  sliceBorder?: Partial<SliceBorder2D> | null;
}

/**
 * A horizontal slider control for 2D UI.
 * Emits axis values and supports value change callbacks.
 *
 * Pointer handling runs through the shared `UIControl2D` funnel, which means: the control emits the
 * lifecycle signals (`pointerdown`/`pressed`/`pointerup`/`released`/`click`), tracks hover and
 * honours the ancestor-scroll gate (a scroll drag passing over the track no longer grabs the
 * handle). The drag itself is unchanged: the press must start inside the track, and it keeps
 * tracking the pointer outside the bounds until release (see {@link capturesPointer}).
 *
 * Unlike `Checkbox2D` / `InventorySlot2D` this control has no state signal, because it has no
 * activation that flips a state behind the pointer signals: the value is written from
 * {@link onPointerDrag}, i.e. during the drag, so by the time `released` / `click` are emitted
 * `value` is already the value the gesture produced. Scripts either read `value` in those listeners
 * or poll it (`slider.value`); the live value during a drag is `input.getAxis(axisName)`.
 */
export class Slider2D extends UIControl2D {
  width: number;
  height: number;
  handleSize: number;
  trackBackgroundColor: string;
  trackFilledColor: string;
  handleColor: string;
  minValue: number;
  maxValue: number;
  value: number;
  axisName: string;
  /**
   * Skin slots. A set slot replaces the corresponding flat colour with the sprite
   * (material colour goes white, like `Button2D` does for its state skins). The
   * actual `Texture` objects arrive post-construction from the SceneLoader.
   */
  textureTrack: TextureResourceRef | null;
  textureFill: TextureResourceRef | null;
  textureThumb: TextureResourceRef | null;
  /**
   * 9-slice insets in *source-texture pixels*, applied to the track and the fill.
   * All-zero (the default) keeps the historical plain `PlaneGeometry` stretch. The
   * thumb is never sliced - it is drawn at its authored size, not stretched.
   */
  sliceBorder: SliceBorder2D;

  private trackMesh: Mesh;
  private filledTrackMesh: Mesh;
  private handleMesh: Mesh;
  private trackMaterial: MeshBasicMaterial;
  private filledTrackMaterial: MeshBasicMaterial;
  private handleMaterial: MeshBasicMaterial;
  private trackGeometry: BufferGeometry;
  private filledTrackGeometry: BufferGeometry;
  private handleGeometry: PlaneGeometry;

  private readonly slotTextures: Record<Slider2DTextureSlot, Texture | null> = {
    track: null,
    fill: null,
    thumb: null,
  };
  /** Natural size of each slot's texture (0 = unknown), needed to cut 9-slice UVs. */
  private readonly slotTextureSizes: Record<
    Slider2DTextureSlot,
    { width: number; height: number }
  > = {
    track: { width: 0, height: 0 },
    fill: { width: 0, height: 0 },
    thumb: { width: 0, height: 0 },
  };

  constructor(props: Slider2DProps) {
    super(props, 'Slider2D');

    this.width = props.width ?? 200;
    this.height = props.height ?? 20;
    this.handleSize = props.handleSize ?? 20;
    this.trackBackgroundColor = props.trackBackgroundColor ?? '#333333';
    this.trackFilledColor = props.trackFilledColor ?? '#4a9eff';
    this.handleColor = props.handleColor ?? '#ffffff';
    this.minValue = props.minValue ?? 0;
    this.maxValue = props.maxValue ?? 100;
    this.value = Math.max(this.minValue, Math.min(this.maxValue, props.value ?? 50));
    this.axisName = props.axisName ?? 'Slider';
    this.textureTrack = coerceTextureResource(props.textureTrack ?? null);
    this.textureFill = coerceTextureResource(props.textureFill ?? null);
    this.textureThumb = coerceTextureResource(props.textureThumb ?? null);
    this.sliceBorder = normalizeSliceBorder(props.sliceBorder);

    // Create track background. Built through the slot helper so an authored
    // sliceBorder cuts a patch from the first frame, not only after a texture lands.
    this.trackGeometry = this.buildSlotGeometry('track', this.width, this.height);
    this.trackMaterial = new MeshBasicMaterial({
      color: this.trackBackgroundColor,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
    });
    this.registerSkinMaterial(this.trackMaterial);
    this.trackMesh = new Mesh(this.trackGeometry, this.trackMaterial);
    this.trackMesh.renderOrder = 999;
    this.add(this.trackMesh);

    // Create filled track (progress indicator)
    this.filledTrackGeometry = new PlaneGeometry(0, this.height);
    this.filledTrackMaterial = new MeshBasicMaterial({
      color: this.trackFilledColor,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.filledTrackMaterial, 1);
    this.filledTrackMesh = new Mesh(this.filledTrackGeometry, this.filledTrackMaterial);
    this.filledTrackMesh.renderOrder = 1000;
    this.filledTrackMesh.position.z = 0.1;
    this.add(this.filledTrackMesh);

    // Create handle
    this.handleGeometry = new PlaneGeometry(this.handleSize, this.height);
    this.handleMaterial = new MeshBasicMaterial({
      color: this.handleColor,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.handleMaterial, 1);
    this.handleMesh = new Mesh(this.handleGeometry, this.handleMaterial);
    this.handleMesh.renderOrder = 1001;
    this.handleMesh.position.z = 0.2;
    this.add(this.handleMesh);

    this.updateSliderVisuals();

    // Last: setValue() is private, so `slider.value = 30` was the only spelling scripts had — and it
    // moved nothing. From here it runs the same clamp + redraw + axis emit the Inspector does.
    installReactiveSchemaProperties(this, Slider2D.getPropertySchema);
  }

  override isPointInBounds(worldPoint: Vector2): boolean {
    this.getWorldPosition(this.tmpWorldPos);
    const dx = Math.abs(worldPoint.x - this.tmpWorldPos.x);
    const dy = Math.abs(worldPoint.y - this.tmpWorldPos.y);
    return dx <= this.width / 2 && dy <= this.height / 2;
  }

  override tick(dt: number): void {
    super.tick(dt);
    // Hover/press/drag all come from the shared UIControl2D funnel: it applies `enabled`, the
    // ancestor-scroll gate and emits the lifecycle signals. The value tracking hangs off
    // onPointerDrag(), which fires on the press frame too, so a tap still jumps the handle.
    this.updatePointerStateFromInput();
  }

  /** A slider owns the pointer once grabbed: the drag keeps tracking past the track's edges. */
  protected override capturesPointer(): boolean {
    return true;
  }

  protected override onPointerDrag(pointerWorld: Vector2): void {
    this.updateSliderFromPointer(pointerWorld.x);
  }

  /** True while the handle is being dragged (the press that owns the pointer). */
  get isDragging(): boolean {
    return this.isPressed;
  }

  override getInteractions(): InteractionDescriptor[] {
    const valueArg = {
      name: 'value',
      type: 'number' as const,
      ui: { label: 'Value', min: this.minValue, max: this.maxValue },
    };
    return [
      ...super.getInteractions(),
      {
        name: 'setValue',
        description: 'Set the value programmatically (tests the reaction to a value change)',
        args: [valueArg],
      },
      {
        name: 'dragTo',
        description: 'Grab the handle and drag it to a value (tests the drag itself)',
        args: [valueArg],
      },
    ];
  }

  /**
   * `setValue` and `dragTo` are deliberately two interactions, not one. The first answers "does
   * anything react to the value changing", the second "does the drag machinery work at all" — a
   * slider can pass either one while failing the other, and collapsing them loses that half of the
   * check.
   */
  protected override performInteraction(name: string, args?: Record<string, unknown>): boolean {
    switch (name) {
      case 'setValue': {
        const value = readNumberArg(args, 'value');
        if (value === null) return false;
        // Not a gesture — but the same gates decide whether the control is accepting anything at
        // all right now.
        if (!this.canAcceptSemanticPointer()) return false;
        this.setValue(value);
        return true;
      }
      case 'dragTo': {
        const value = readNumberArg(args, 'value');
        if (value === null) return false;
        return this.dragHandleTo(value);
      }
      default:
        return super.performInteraction(name, args);
    }
  }

  /**
   * Run a real drag: press on the handle where it currently sits, travel to the target value and
   * release there. Every frame goes through the pointer funnel, so the value moves only because
   * {@link onPointerDrag} moved it — the same reason a finger moves it.
   */
  private dragHandleTo(targetValue: number): boolean {
    const clamped = Math.max(this.minValue, Math.min(this.maxValue, targetValue));
    const point = this.getSemanticPointerPoint();
    const startX = this.worldXForValue(this.value);
    const endX = this.worldXForValue(clamped);
    const midX = (startX + endX) / 2;

    if (!this.runSemanticPointerFrame(point.set(startX, point.y), true, true)) {
      return false;
    }
    // An intermediate frame keeps this a drag rather than a teleport: anything watching
    // onPointerDrag (juice, live previews, a script scrubbing audio) sees motion.
    if (!this.runSemanticPointerFrame(point.set(midX, point.y), true, true)) {
      return false;
    }
    if (!this.runSemanticPointerFrame(point.set(endX, point.y), true, true)) {
      return false;
    }
    return this.runSemanticPointerFrame(point.set(endX, point.y), false, false);
  }

  /** World X of a value on this track — the mirror of {@link updateSliderFromPointer}. */
  private worldXForValue(value: number): number {
    this.getWorldPosition(this.tmpWorldPos);
    const range = this.maxValue - this.minValue;
    const normalized = range === 0 ? 0 : (value - this.minValue) / range;
    return this.tmpWorldPos.x + (normalized - 0.5) * this.width;
  }

  private updateSliderFromPointer(pointerWorldX: number): void {
    this.getWorldPosition(this.tmpWorldPos);
    const relativeX = pointerWorldX - this.tmpWorldPos.x;
    const normalized = Math.max(0, Math.min(1, (relativeX + this.width / 2) / this.width));
    const newValue = this.minValue + normalized * (this.maxValue - this.minValue);
    this.setValue(newValue);
  }

  private setValue(newValue: number): void {
    const oldValue = this.value;
    this.value = Math.max(this.minValue, Math.min(this.maxValue, newValue));

    if (this.value !== oldValue) {
      this.updateSliderVisuals();
      const normalized = (this.value - this.minValue) / (this.maxValue - this.minValue);
      this.input?.setAxis(this.axisName, normalized);
    }
  }

  private updateSliderVisuals(): void {
    const normalized = (this.value - this.minValue) / (this.maxValue - this.minValue);
    const filledWidth = this.width * normalized;

    // Update filled track. The geometry is centred on the origin, so offset the
    // mesh to anchor the fill to the track's left edge (grows rightward). With a
    // 9-slice border the fill is re-CUT at the new width instead of squashed, so
    // its caps keep their pixel size all the way down to `value = min`.
    this.filledTrackGeometry.dispose();
    this.filledTrackGeometry = this.buildSlotGeometry('fill', filledWidth, this.height);
    this.filledTrackMesh.geometry = this.filledTrackGeometry;
    this.filledTrackMesh.position.x = -this.width / 2 + filledWidth / 2;

    // Update handle position
    const handleX = -this.width / 2 + filledWidth;
    this.handleMesh.position.x = handleX;
  }

  /** Geometry for one slot: a plain quad, or a 9-slice patch when sliced. */
  private buildSlotGeometry(
    slot: Slider2DTextureSlot,
    width: number,
    height: number
  ): BufferGeometry {
    const size = this.slotTextureSizes[slot];
    return buildSkinGeometry({
      width,
      height,
      textureWidth: size.width,
      textureHeight: size.height,
      // The thumb is drawn at its authored size; slicing it would be meaningless.
      border: slot === 'thumb' ? null : this.sliceBorder,
    });
  }

  /** Re-cut the track (and the fill, via updateSliderVisuals) after a size/border change. */
  private rebuildTrackGeometry(): void {
    this.trackGeometry.dispose();
    this.trackGeometry = this.buildSlotGeometry('track', this.width, this.height);
    this.trackMesh.geometry = this.trackGeometry;
    this.updateSliderVisuals();
  }

  /** Set the 9-slice insets (source px) for the track and fill. All-zero = stretch. */
  setSliceBorder(border: Partial<SliceBorder2D>): void {
    this.sliceBorder = normalizeSliceBorder({ ...this.sliceBorder, ...border });
    this.rebuildTrackGeometry();
  }

  /**
   * Assign the loaded `Texture` for one skin slot (called by the SceneLoader after
   * loading, mirroring `Button2D.setStateTexture`). Passing null clears the slot
   * and the control falls back to its flat colour.
   */
  setSlotTexture(slot: Slider2DTextureSlot, texture: Texture | null): void {
    if (texture) {
      // sRGB + mipmaps disabled (see configure2DTexture for the why).
      configure2DTexture(texture);
    }
    this.slotTextures[slot] = texture;

    const natural =
      texture?.image !== undefined && texture.image !== null
        ? getNaturalTextureSize(
            texture.image as {
              naturalWidth?: number;
              naturalHeight?: number;
              width?: number;
              height?: number;
            }
          )
        : {};
    this.slotTextureSizes[slot] = { width: natural.width ?? 0, height: natural.height ?? 0 };

    const material = this.materialForSlot(slot);
    if (texture) {
      material.map = texture;
      material.color.set('#ffffff');
      material.transparent = true;
    } else {
      material.map = null;
      material.color.setStyle(this.colorForSlot(slot));
    }
    material.needsUpdate = true;

    // 9-slice UVs are anchored in source pixels, so the natural size has to be in
    // place before the patch is cut.
    if (slot === 'thumb') {
      this.handleGeometry.dispose();
      this.handleGeometry = new PlaneGeometry(this.handleSize, this.height);
      this.handleMesh.geometry = this.handleGeometry;
    } else {
      this.rebuildTrackGeometry();
    }
  }

  /** The authored path that should be loaded for a slot, or null. */
  getSlotTexturePath(slot: Slider2DTextureSlot): string | null {
    switch (slot) {
      case 'track':
        return this.textureTrack?.url ?? null;
      case 'fill':
        return this.textureFill?.url ?? null;
      case 'thumb':
        return this.textureThumb?.url ?? null;
    }
  }

  private materialForSlot(slot: Slider2DTextureSlot): MeshBasicMaterial {
    switch (slot) {
      case 'track':
        return this.trackMaterial;
      case 'fill':
        return this.filledTrackMaterial;
      case 'thumb':
        return this.handleMaterial;
    }
  }

  private colorForSlot(slot: Slider2DTextureSlot): string {
    switch (slot) {
      case 'track':
        return this.trackBackgroundColor;
      case 'fill':
        return this.trackFilledColor;
      case 'thumb':
        return this.handleColor;
    }
  }

  private setSlotTextureRef(slot: Slider2DTextureSlot, value: unknown): void {
    const ref = coerceTextureResource(value);
    const previous = this.getSlotTexturePath(slot);
    switch (slot) {
      case 'track':
        this.textureTrack = ref;
        break;
      case 'fill':
        this.textureFill = ref;
        break;
      case 'thumb':
        this.textureThumb = ref;
        break;
    }
    if (previous !== (ref?.url ?? null)) {
      // The loaded Texture no longer matches the ref; drop it. The SceneLoader
      // reloads from the ref on the next scene load / play.
      this.setSlotTexture(slot, null);
    }
  }

  /** Repaint one slot's flat colour, unless a sprite currently covers it. */
  private refreshSlotColor(slot: Slider2DTextureSlot): void {
    if (this.slotTextures[slot]) {
      return;
    }
    this.materialForSlot(slot).color.setStyle(this.colorForSlot(slot));
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = UIControl2D.getPropertySchema();
    return {
      nodeType: 'Slider2D',
      extends: 'UIControl2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'width',
          type: 'number',
          ui: { label: 'Width', group: 'Slider', min: 50, max: 500, step: 1 },
          getValue: n => (n as Slider2D).width,
          setValue: (n, v) => {
            const slider = n as Slider2D;
            slider.width = Number(v);
            slider.rebuildTrackGeometry();
          },
        },
        {
          name: 'height',
          type: 'number',
          ui: { label: 'Height', group: 'Slider', min: 5, max: 100, step: 1 },
          getValue: n => (n as Slider2D).height,
          setValue: (n, v) => {
            const slider = n as Slider2D;
            slider.height = Number(v);
            slider.handleGeometry.dispose();
            slider.handleGeometry = new PlaneGeometry(slider.handleSize, slider.height);
            slider.handleMesh.geometry = slider.handleGeometry;
            slider.rebuildTrackGeometry();
          },
        },
        {
          name: 'handleSize',
          type: 'number',
          ui: { label: 'Handle Size', group: 'Slider', min: 5, max: 100, step: 1 },
          getValue: n => (n as Slider2D).handleSize,
          setValue: (n, v) => {
            const slider = n as Slider2D;
            slider.handleSize = Number(v);
            slider.handleGeometry.dispose();
            slider.handleGeometry = new PlaneGeometry(slider.handleSize, slider.height);
            slider.handleMesh.geometry = slider.handleGeometry;
            slider.updateSliderVisuals();
          },
        },
        {
          name: 'value',
          type: 'number',
          ui: { label: 'Value', group: 'Slider', step: 0.1 },
          getValue: n => (n as Slider2D).value,
          setValue: (n, v) => {
            (n as Slider2D).setValue(Number(v));
          },
        },
        {
          name: 'minValue',
          type: 'number',
          ui: { label: 'Min Value', group: 'Slider', step: 0.1 },
          getValue: n => (n as Slider2D).minValue,
          setValue: (n, v) => {
            const slider = n as Slider2D;
            slider.minValue = Number(v);
            if (slider.value < slider.minValue) {
              slider.setValue(slider.minValue);
            }
            slider.updateSliderVisuals();
          },
        },
        {
          name: 'maxValue',
          type: 'number',
          ui: { label: 'Max Value', group: 'Slider', step: 0.1 },
          getValue: n => (n as Slider2D).maxValue,
          setValue: (n, v) => {
            const slider = n as Slider2D;
            slider.maxValue = Number(v);
            if (slider.value > slider.maxValue) {
              slider.setValue(slider.maxValue);
            }
            slider.updateSliderVisuals();
          },
        },
        {
          name: 'trackBackgroundColor',
          type: 'color',
          ui: { label: 'Background Color', group: 'Slider' },
          getValue: n => (n as Slider2D).trackBackgroundColor,
          setValue: (n, v) => {
            const slider = n as Slider2D;
            slider.trackBackgroundColor = String(v);
            slider.refreshSlotColor('track');
          },
        },
        {
          name: 'trackFilledColor',
          type: 'color',
          ui: { label: 'Filled Color', group: 'Slider' },
          getValue: n => (n as Slider2D).trackFilledColor,
          setValue: (n, v) => {
            const slider = n as Slider2D;
            slider.trackFilledColor = String(v);
            slider.refreshSlotColor('fill');
          },
        },
        {
          name: 'handleColor',
          type: 'color',
          ui: { label: 'Handle Color', group: 'Slider' },
          getValue: n => (n as Slider2D).handleColor,
          setValue: (n, v) => {
            const slider = n as Slider2D;
            slider.handleColor = String(v);
            slider.refreshSlotColor('thumb');
          },
        },
        {
          name: 'textureTrack',
          type: 'object',
          ui: {
            label: 'Track Sprite',
            group: 'Skin',
            description: 'Sprite for the track background',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: n => (n as Slider2D).textureTrack ?? { type: 'texture', url: '' },
          setValue: (n, v) => {
            (n as Slider2D).setSlotTextureRef('track', v);
          },
        },
        {
          name: 'textureFill',
          type: 'object',
          ui: {
            label: 'Fill Sprite',
            group: 'Skin',
            description: 'Sprite for the filled portion of the track',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: n => (n as Slider2D).textureFill ?? { type: 'texture', url: '' },
          setValue: (n, v) => {
            (n as Slider2D).setSlotTextureRef('fill', v);
          },
        },
        {
          name: 'textureThumb',
          type: 'object',
          ui: {
            label: 'Thumb Sprite',
            group: 'Skin',
            description: 'Sprite for the draggable handle (never sliced)',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: n => (n as Slider2D).textureThumb ?? { type: 'texture', url: '' },
          setValue: (n, v) => {
            (n as Slider2D).setSlotTextureRef('thumb', v);
          },
        },
        {
          name: 'sliceBorderLeft',
          type: 'number',
          ui: {
            label: 'Slice Left',
            group: 'Skin',
            description: 'Left 9-slice inset of the track/fill sprites (source px); 0 = stretch',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: n => (n as Slider2D).sliceBorder.left,
          setValue: (n, v) => {
            (n as Slider2D).setSliceBorder({ left: Number(v) });
          },
        },
        {
          name: 'sliceBorderRight',
          type: 'number',
          ui: {
            label: 'Slice Right',
            group: 'Skin',
            description: 'Right 9-slice inset of the track/fill sprites (source px); 0 = stretch',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: n => (n as Slider2D).sliceBorder.right,
          setValue: (n, v) => {
            (n as Slider2D).setSliceBorder({ right: Number(v) });
          },
        },
        {
          name: 'sliceBorderTop',
          type: 'number',
          ui: {
            label: 'Slice Top',
            group: 'Skin',
            description: 'Top 9-slice inset of the track/fill sprites (source px); 0 = stretch',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: n => (n as Slider2D).sliceBorder.top,
          setValue: (n, v) => {
            (n as Slider2D).setSliceBorder({ top: Number(v) });
          },
        },
        {
          name: 'sliceBorderBottom',
          type: 'number',
          ui: {
            label: 'Slice Bottom',
            group: 'Skin',
            description: 'Bottom 9-slice inset of the track/fill sprites (source px); 0 = stretch',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: n => (n as Slider2D).sliceBorder.bottom,
          setValue: (n, v) => {
            (n as Slider2D).setSliceBorder({ bottom: Number(v) });
          },
        },
        {
          name: 'axisName',
          type: 'string',
          ui: { label: 'Axis Name', group: 'Input', description: 'Virtual axis name' },
          getValue: n => (n as Slider2D).axisName,
          setValue: (n, v) => {
            (n as Slider2D).axisName = String(v);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Slider: { label: 'Slider', expanded: true },
        Skin: { label: 'Skin', description: 'Sprites replacing the flat colours', expanded: true },
      },
    };
  }
}
