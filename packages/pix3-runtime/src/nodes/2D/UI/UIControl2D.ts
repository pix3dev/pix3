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
import type { PropertySchema } from '../../../fw/property-schema';
import { ScrollContainer2D } from './ScrollContainer2D';

export interface UIControl2DProps extends Node2DProps {
  enabled?: boolean;
  label?: string;
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
 */
export abstract class UIControl2D extends Node2D {
  // Control state
  enabled: boolean;
  label: string;
  labelFontFamily: string;
  labelFontSize: number;
  labelColor: string;
  labelAlign: 'left' | 'center' | 'right';
  texturePath: string | null;

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

    this.enabled = props.enabled ?? true;
    this.label = props.label ?? '';
    this.labelFontFamily = props.labelFontFamily ?? 'Arial';
    this.labelFontSize = props.labelFontSize ?? 16;
    this.labelColor = props.labelColor ?? '#ffffff';
    this.labelAlign = props.labelAlign ?? 'center';
    this.texturePath = props.texturePath ?? null;

    if (this.texturePath) {
      this.tryLoadTextureFromPath(this.texturePath);
    }

    if (this.label.trim().length > 0) {
      this.updateLabel();
    }
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
   * Update hover and pressed states based on pointer input
   */
  protected updatePointerState(
    pointerWorldX: number,
    pointerWorldY: number,
    isDown: boolean
  ): void {
    const pointerPos = new Vector2(pointerWorldX, pointerWorldY);
    const isInBounds = this.isPointerAllowedByAncestorScrollContainers(pointerPos) && this.isPointInBounds(pointerPos);

    // Handle hover state
    if (isInBounds && !this.isHovering && this.enabled) {
      this.isHovering = true;
      this.onHoverEnter?.();
      this.onHover(true);
    } else if (!isInBounds && this.isHovering) {
      this.isHovering = false;
      this.onHoverExit?.();
      this.onHover(false);
      if (this.isPressed) {
        this.isPressed = false;
        this.onReleased?.();
        this.onPress(false);
      }
    }

    if (this.isHovering && this.input) {
      this.input.registerHover(this.nodeId);
    }

    // Handle pressed state
    if (isInBounds && isDown && !this.isPressed && this.enabled) {
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

  private isPointerAllowedByAncestorScrollContainers(pointerPos: Vector2): boolean {
    let currentParent = this.parent;
    while (currentParent) {
      if (currentParent instanceof ScrollContainer2D) {
        if (!currentParent.isPointInViewportBounds(pointerPos) || currentParent.hasActivePointerCapture()) {
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
   * Update the label display
   */
  protected updateLabel(): void {
    if (!this.label) {
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
    const textureWidth = Math.max(
      128,
      Math.ceil(this.label.length * this.labelFontSize * 0.75) + 24
    );
    const textureHeight = Math.max(32, Math.ceil(this.labelFontSize * 2));
    this.labelTexture = this.createLabelTexture(this.label, textureWidth, textureHeight);

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
          getValue: n => (n as UIControl2D).label,
          setValue: (n, v) => {
            const control = n as UIControl2D;
            control.label = String(v);
            control.updateLabel();
          },
        },
        {
          name: 'labelFontSize',
          type: 'number',
          ui: { label: 'Font Size', group: 'Label', min: 8, max: 64, step: 1 },
          getValue: n => (n as UIControl2D).labelFontSize,
          setValue: (n, v) => {
            const control = n as UIControl2D;
            control.labelFontSize = Number(v);
            control.labelTexture?.dispose();
            control.labelTexture = null;
            control.updateLabel();
          },
        },
        {
          name: 'labelColor',
          type: 'string',
          ui: { label: 'Font Color', group: 'Label' },
          getValue: n => (n as UIControl2D).labelColor,
          setValue: (n, v) => {
            const control = n as UIControl2D;
            control.labelColor = String(v);
            control.labelTexture?.dispose();
            control.labelTexture = null;
            control.updateLabel();
          },
        },
        {
          name: 'labelAlign',
          type: 'string',
          ui: { label: 'Alignment', group: 'Label', description: 'left, center, or right' },
          getValue: n => (n as UIControl2D).labelAlign,
          setValue: (n, v) => {
            const control = n as UIControl2D;
            const val = String(v);
            if (val === 'left' || val === 'center' || val === 'right') {
              control.labelAlign = val;
              control.labelTexture?.dispose();
              control.labelTexture = null;
              control.updateLabel();
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
