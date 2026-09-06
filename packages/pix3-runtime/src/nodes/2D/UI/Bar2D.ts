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
import { installReactiveSchemaProperties } from '../../../fw/reactive-schema-properties';
import { coerceTextureResource, type TextureResourceRef } from '../../../core/TextureResource';
import { configure2DTexture } from '../../../core/configure-2d-texture';
import { getNaturalTextureSize } from '../../../core/texture-natural-size';
import {
  buildSkinGeometry,
  normalizeSliceBorder,
  type SliceBorder2D,
} from '../../../core/nine-slice-skin';

/** The two skin slots a bar can be given a sprite for. */
export type Bar2DTextureSlot = 'trough' | 'fill';

export interface Bar2DProps extends UIControl2DProps {
  width?: number;
  height?: number;
  backBackgroundColor?: string;
  barColor?: string;
  minValue?: number;
  maxValue?: number;
  value?: number;
  showBorder?: boolean;
  borderColor?: string;
  borderWidth?: number;
  /** Sprite for the empty trough behind the fill. */
  textureTrough?: TextureResourceRef | string | null;
  /** Sprite for the filled portion, re-cut (not squashed) as `value` moves. */
  textureFill?: TextureResourceRef | string | null;
  /** 9-slice insets (source px) applied to both the trough and the fill. */
  sliceBorder?: Partial<SliceBorder2D> | null;
}

/**
 * A progress/status bar for 2D UI (HP, energy, progress, etc).
 * Visual only - no interaction. Value is typically set by scripts.
 */
export class Bar2D extends UIControl2D {
  width: number;
  height: number;
  backBackgroundColor: string;
  barColor: string;
  minValue: number;
  maxValue: number;
  value: number;
  showBorder: boolean;
  borderColor: string;
  borderWidth: number;
  /**
   * Skin slots. A set slot replaces the corresponding flat colour with the sprite
   * (material colour goes white, like `Button2D` does for its state skins). The
   * actual `Texture` objects arrive post-construction from the SceneLoader.
   */
  textureTrough: TextureResourceRef | null;
  textureFill: TextureResourceRef | null;
  /**
   * 9-slice insets in *source-texture pixels*, applied to the trough and the fill.
   * All-zero (the default) keeps the historical plain `PlaneGeometry` stretch.
   */
  sliceBorder: SliceBorder2D;

  private backgroundMesh: Mesh;
  private barMesh: Mesh;
  private borderMesh: Mesh | null = null;
  private backgroundMaterial: MeshBasicMaterial;
  private barMaterial: MeshBasicMaterial;
  private borderMaterial: MeshBasicMaterial | null = null;
  private backgroundGeometry: BufferGeometry;
  private barGeometry: BufferGeometry;
  private borderGeometry: PlaneGeometry | null = null;

  private readonly slotTextures: Record<Bar2DTextureSlot, Texture | null> = {
    trough: null,
    fill: null,
  };
  /** Natural size of each slot's texture (0 = unknown), needed to cut 9-slice UVs. */
  private readonly slotTextureSizes: Record<Bar2DTextureSlot, { width: number; height: number }> = {
    trough: { width: 0, height: 0 },
    fill: { width: 0, height: 0 },
  };

  constructor(props: Bar2DProps) {
    super(props, 'Bar2D');

    this.width = props.width ?? 150;
    this.height = props.height ?? 20;
    this.backBackgroundColor = props.backBackgroundColor ?? '#333333';
    this.barColor = props.barColor ?? '#ff4444';
    this.minValue = props.minValue ?? 0;
    this.maxValue = props.maxValue ?? 100;
    this.value = Math.max(this.minValue, Math.min(this.maxValue, props.value ?? 100));
    this.showBorder = props.showBorder ?? true;
    this.borderColor = props.borderColor ?? '#000000';
    this.borderWidth = props.borderWidth ?? 2;
    this.textureTrough = coerceTextureResource(props.textureTrough ?? null);
    this.textureFill = coerceTextureResource(props.textureFill ?? null);
    this.sliceBorder = normalizeSliceBorder(props.sliceBorder);

    // Create background (trough). Built through the slot helper so an authored
    // sliceBorder cuts a patch from the first frame, not only after a texture lands.
    this.backgroundGeometry = this.buildSlotGeometry('trough', this.width, this.height);
    this.backgroundMaterial = new MeshBasicMaterial({
      color: this.backBackgroundColor,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
    });
    this.registerSkinMaterial(this.backgroundMaterial);
    this.backgroundMesh = new Mesh(this.backgroundGeometry, this.backgroundMaterial);
    this.backgroundMesh.renderOrder = 999;
    this.add(this.backgroundMesh);

    // Create bar (filled portion)
    this.barGeometry = new PlaneGeometry(0, this.height);
    this.barMaterial = new MeshBasicMaterial({
      color: this.barColor,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.barMaterial, 1);
    this.barMesh = new Mesh(this.barGeometry, this.barMaterial);
    this.barMesh.renderOrder = 1000;
    this.barMesh.position.z = 0.1;
    this.add(this.barMesh);

    // Create border if enabled
    if (this.showBorder) {
      this.createBorder();
    }

    this.updateBarVisuals();

    // Last: from here a script's `bar.value = 30` runs the same clamp + redraw the Inspector does.
    installReactiveSchemaProperties(this, Bar2D.getPropertySchema);
  }

  private createBorder(): void {
    // The border is a solid quad drawn BEHIND the background, expanded by
    // borderWidth on every side, so its outer edge peeks out as a frame while
    // the background/bar cover the interior. Drawing it on top (as before)
    // would paint a solid rect over the whole bar and hide the fill entirely.
    this.borderGeometry = this.buildBorderGeometry();
    this.borderMaterial = new MeshBasicMaterial({
      color: this.borderColor,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
      wireframe: false,
    });
    this.registerOpacityMaterial(this.borderMaterial, 1);
    this.borderMesh = new Mesh(this.borderGeometry, this.borderMaterial);
    this.borderMesh.renderOrder = 998;
    this.borderMesh.position.z = -0.1;
    this.add(this.borderMesh);
  }

  private buildBorderGeometry(): PlaneGeometry {
    return new PlaneGeometry(this.width + this.borderWidth * 2, this.height + this.borderWidth * 2);
  }

  private rebuildBorderGeometry(): void {
    if (!this.borderMesh) return;
    this.borderGeometry?.dispose();
    this.borderGeometry = this.buildBorderGeometry();
    this.borderMesh.geometry = this.borderGeometry;
  }

  override isPointInBounds(_worldPoint: Vector2): boolean {
    // Bar is visual only, no interaction
    return false;
  }

  /**
   * Set the bar's value (clamped to min/max range)
   */
  setValue(newValue: number): void {
    const oldValue = this.value;
    this.value = Math.max(this.minValue, Math.min(this.maxValue, newValue));

    if (this.value !== oldValue) {
      this.updateBarVisuals();
    }
  }

  private updateBarVisuals(): void {
    const normalized = (this.value - this.minValue) / (this.maxValue - this.minValue);
    const filledWidth = Math.max(0, this.width * normalized);

    // Update bar geometry. With a 9-slice border the fill is re-CUT at the new
    // width rather than squashed, so its caps keep their source-pixel size all the
    // way down to an empty bar.
    this.barGeometry.dispose();
    this.barGeometry = this.buildSlotGeometry('fill', filledWidth, this.height);
    this.barMesh.geometry = this.barGeometry;

    // Position bar to fill from left
    this.barMesh.position.x = -this.width / 2 + filledWidth / 2;
  }

  /** Geometry for one slot: a plain quad, or a 9-slice patch when sliced. */
  private buildSlotGeometry(slot: Bar2DTextureSlot, width: number, height: number): BufferGeometry {
    const size = this.slotTextureSizes[slot];
    return buildSkinGeometry({
      width,
      height,
      textureWidth: size.width,
      textureHeight: size.height,
      border: this.sliceBorder,
    });
  }

  /** Re-cut the trough (and the fill, via updateBarVisuals) after a size/border change. */
  private rebuildTroughGeometry(): void {
    this.backgroundGeometry.dispose();
    this.backgroundGeometry = this.buildSlotGeometry('trough', this.width, this.height);
    this.backgroundMesh.geometry = this.backgroundGeometry;
    this.rebuildBorderGeometry();
    this.updateBarVisuals();
  }

  /** Set the 9-slice insets (source px) for the trough and fill. All-zero = stretch. */
  setSliceBorder(border: Partial<SliceBorder2D>): void {
    this.sliceBorder = normalizeSliceBorder({ ...this.sliceBorder, ...border });
    this.rebuildTroughGeometry();
  }

  /**
   * Assign the loaded `Texture` for one skin slot (called by the SceneLoader after
   * loading, mirroring `Button2D.setStateTexture`). Passing null clears the slot
   * and the control falls back to its flat colour.
   */
  setSlotTexture(slot: Bar2DTextureSlot, texture: Texture | null): void {
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

    const material = slot === 'trough' ? this.backgroundMaterial : this.barMaterial;
    if (texture) {
      material.map = texture;
      material.color.set('#ffffff');
      material.transparent = true;
    } else {
      material.map = null;
      material.color.setStyle(slot === 'trough' ? this.backBackgroundColor : this.barColor);
    }
    material.needsUpdate = true;

    // 9-slice UVs are anchored in source pixels, so the natural size has to be in
    // place before the patch is cut.
    this.rebuildTroughGeometry();
  }

  /** The authored path that should be loaded for a slot, or null. */
  getSlotTexturePath(slot: Bar2DTextureSlot): string | null {
    return slot === 'trough' ? (this.textureTrough?.url ?? null) : (this.textureFill?.url ?? null);
  }

  private setSlotTextureRef(slot: Bar2DTextureSlot, value: unknown): void {
    const ref = coerceTextureResource(value);
    const previous = this.getSlotTexturePath(slot);
    if (slot === 'trough') {
      this.textureTrough = ref;
    } else {
      this.textureFill = ref;
    }
    if (previous !== (ref?.url ?? null)) {
      // The loaded Texture no longer matches the ref; drop it. The SceneLoader
      // reloads from the ref on the next scene load / play.
      this.setSlotTexture(slot, null);
    }
  }

  /** Repaint one slot's flat colour, unless a sprite currently covers it. */
  private refreshSlotColor(slot: Bar2DTextureSlot): void {
    if (this.slotTextures[slot]) {
      return;
    }
    const material = slot === 'trough' ? this.backgroundMaterial : this.barMaterial;
    material.color.setStyle(slot === 'trough' ? this.backBackgroundColor : this.barColor);
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = UIControl2D.getPropertySchema();
    return {
      nodeType: 'Bar2D',
      extends: 'UIControl2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'width',
          type: 'number',
          ui: { label: 'Width', group: 'Bar', min: 20, max: 500, step: 1 },
          getValue: n => (n as Bar2D).width,
          setValue: (n, v) => {
            const bar = n as Bar2D;
            bar.width = Number(v);
            bar.rebuildTroughGeometry();
          },
        },
        {
          name: 'height',
          type: 'number',
          ui: { label: 'Height', group: 'Bar', min: 5, max: 200, step: 1 },
          getValue: n => (n as Bar2D).height,
          setValue: (n, v) => {
            const bar = n as Bar2D;
            bar.height = Number(v);
            bar.rebuildTroughGeometry();
          },
        },
        {
          name: 'value',
          type: 'number',
          ui: { label: 'Value', group: 'Bar', step: 0.1 },
          getValue: n => (n as Bar2D).value,
          setValue: (n, v) => {
            (n as Bar2D).setValue(Number(v));
          },
        },
        {
          name: 'minValue',
          type: 'number',
          ui: { label: 'Min Value', group: 'Bar', step: 0.1 },
          getValue: n => (n as Bar2D).minValue,
          setValue: (n, v) => {
            const bar = n as Bar2D;
            bar.minValue = Number(v);
            if (bar.value < bar.minValue) {
              bar.setValue(bar.minValue);
            }
            bar.updateBarVisuals();
          },
        },
        {
          name: 'maxValue',
          type: 'number',
          ui: { label: 'Max Value', group: 'Bar', step: 0.1 },
          getValue: n => (n as Bar2D).maxValue,
          setValue: (n, v) => {
            const bar = n as Bar2D;
            bar.maxValue = Number(v);
            if (bar.value > bar.maxValue) {
              bar.setValue(bar.maxValue);
            }
            bar.updateBarVisuals();
          },
        },
        {
          name: 'backBackgroundColor',
          type: 'color',
          ui: { label: 'Background Color', group: 'Bar' },
          getValue: n => (n as Bar2D).backBackgroundColor,
          setValue: (n, v) => {
            const bar = n as Bar2D;
            bar.backBackgroundColor = String(v);
            bar.refreshSlotColor('trough');
          },
        },
        {
          name: 'barColor',
          type: 'color',
          ui: { label: 'Bar Color', group: 'Bar' },
          getValue: n => (n as Bar2D).barColor,
          setValue: (n, v) => {
            const bar = n as Bar2D;
            bar.barColor = String(v);
            bar.refreshSlotColor('fill');
          },
        },
        {
          name: 'textureTrough',
          type: 'object',
          ui: {
            label: 'Trough Sprite',
            group: 'Skin',
            description: 'Sprite for the empty trough behind the fill',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: n => (n as Bar2D).textureTrough ?? { type: 'texture', url: '' },
          setValue: (n, v) => {
            (n as Bar2D).setSlotTextureRef('trough', v);
          },
        },
        {
          name: 'textureFill',
          type: 'object',
          ui: {
            label: 'Fill Sprite',
            group: 'Skin',
            description: 'Sprite for the filled portion',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: n => (n as Bar2D).textureFill ?? { type: 'texture', url: '' },
          setValue: (n, v) => {
            (n as Bar2D).setSlotTextureRef('fill', v);
          },
        },
        {
          name: 'sliceBorderLeft',
          type: 'number',
          ui: {
            label: 'Slice Left',
            group: 'Skin',
            description: 'Left 9-slice inset of the trough/fill sprites (source px); 0 = stretch',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: n => (n as Bar2D).sliceBorder.left,
          setValue: (n, v) => {
            (n as Bar2D).setSliceBorder({ left: Number(v) });
          },
        },
        {
          name: 'sliceBorderRight',
          type: 'number',
          ui: {
            label: 'Slice Right',
            group: 'Skin',
            description: 'Right 9-slice inset of the trough/fill sprites (source px); 0 = stretch',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: n => (n as Bar2D).sliceBorder.right,
          setValue: (n, v) => {
            (n as Bar2D).setSliceBorder({ right: Number(v) });
          },
        },
        {
          name: 'sliceBorderTop',
          type: 'number',
          ui: {
            label: 'Slice Top',
            group: 'Skin',
            description: 'Top 9-slice inset of the trough/fill sprites (source px); 0 = stretch',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: n => (n as Bar2D).sliceBorder.top,
          setValue: (n, v) => {
            (n as Bar2D).setSliceBorder({ top: Number(v) });
          },
        },
        {
          name: 'sliceBorderBottom',
          type: 'number',
          ui: {
            label: 'Slice Bottom',
            group: 'Skin',
            description: 'Bottom 9-slice inset of the trough/fill sprites (source px); 0 = stretch',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: n => (n as Bar2D).sliceBorder.bottom,
          setValue: (n, v) => {
            (n as Bar2D).setSliceBorder({ bottom: Number(v) });
          },
        },
        {
          name: 'showBorder',
          type: 'boolean',
          ui: { label: 'Show Border', group: 'Bar' },
          getValue: n => (n as Bar2D).showBorder,
          setValue: (n, v) => {
            const bar = n as Bar2D;
            bar.showBorder = Boolean(v);
            if (bar.showBorder && !bar.borderMesh) {
              bar.createBorder();
            } else if (!bar.showBorder && bar.borderMesh) {
              bar.remove(bar.borderMesh);
              bar.borderGeometry?.dispose();
              bar.borderMaterial?.dispose();
              bar.borderMesh = null;
              bar.borderGeometry = null;
              bar.borderMaterial = null;
            }
          },
        },
        {
          name: 'borderColor',
          type: 'color',
          ui: { label: 'Border Color', group: 'Bar' },
          getValue: n => (n as Bar2D).borderColor,
          setValue: (n, v) => {
            const bar = n as Bar2D;
            bar.borderColor = String(v);
            if (bar.borderMaterial) {
              bar.borderMaterial.color.setStyle(bar.borderColor);
            }
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Bar: { label: 'Bar', expanded: true },
        Skin: { label: 'Skin', description: 'Sprites replacing the flat colours', expanded: true },
      },
    };
  }
}
