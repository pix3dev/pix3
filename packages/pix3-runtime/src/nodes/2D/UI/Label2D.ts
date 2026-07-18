import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, Vector2 } from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import { configure2DTexture } from '../../../core/configure-2d-texture';
import {
  LABEL_AUTO_SIZE_BLEED,
  LABEL_H_ALIGN_VALUES,
  LABEL_V_ALIGN_VALUES,
  layoutLabelText,
  paintLabelCanvas,
  type LabelLayout,
  type LabelVAlign,
} from '../../../core/label-text-layout';
import type { PropertySchema } from '../../../fw/property-schema';
import { resolveLocalizedText } from '../../../core/localization/active-localization';
import type { TrParams } from '../../../core/localization/localization-types';

export interface Label2DProps extends UIControl2DProps {
  /** Fixed box width in logical px; 0 = auto-size to the text (no word wrap). */
  width?: number;
  /** Fixed box height in logical px; 0 = auto-size to the wrapped lines. */
  height?: number;
  /** Vertical alignment of the text inside a fixed-height box. */
  labelVAlign?: LabelVAlign;
  /** Characters per second for the typewriter reveal; 0 disables it. */
  typewriterSpeed?: number;
}

interface LabelRenderState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  layout: LabelLayout;
  boxWidth: number;
  boxHeight: number;
  text: string;
}

/**
 * A multiline text label control for 2D UI.
 *
 * - Explicit `\n` breaks lines; a fixed `width` additionally word-wraps.
 * - `labelAlign` / `labelVAlign` position the text inside the fixed box.
 * - `typewriterSpeed` > 0 reveals the text character by character in play
 *   mode; the node emits `'typewriter-complete'` when the reveal finishes.
 */
export class Label2D extends UIControl2D {
  width: number;
  height: number;
  labelVAlign: LabelVAlign;
  typewriterSpeed: number;

  private renderState: LabelRenderState | null = null;
  private typewriterVisible = 0;
  private typewriterActive = false;
  /** Interpolation params for `labelKey` (runtime-only, not serialized). */
  private labelKeyParams: TrParams | null = null;

  constructor(props: Label2DProps) {
    super(props, 'Label2D');

    this.width = props.width ?? 0;
    this.height = props.height ?? 0;
    this.labelVAlign = props.labelVAlign ?? 'middle';
    this.typewriterSpeed = props.typewriterSpeed ?? 0;

    // Re-render with the Label2D-specific fields now that they are set (the
    // base constructor already ran updateLabel with defaults).
    this.updateLabel();
  }

  override getDisplayText(): string {
    return this.labelKey
      ? resolveLocalizedText(this.labelKey, this.label, this.labelKeyParams ?? undefined)
      : this.label;
  }

  /**
   * Replace the label with a literal string; restarts the typewriter reveal when enabled. Clears any
   * bound localization key — an explicit literal overrides localization.
   */
  setText(text: string): void {
    if (this.labelKey === '' && this.label === text) {
      return;
    }
    this.labelKey = '';
    this.labelKeyParams = null;
    this.label = text;
    this.updateLabel();
  }

  /** Bind the label to a translation key; re-resolves on locale change (via the tree walk). */
  setTextKey(key: string, params?: TrParams): void {
    this.labelKey = key;
    this.labelKeyParams = params ?? null;
    this.updateLabel();
  }

  /** True while a typewriter reveal is still printing characters. */
  get isTyping(): boolean {
    return this.typewriterActive;
  }

  /** Finish the typewriter reveal instantly (show the full text). */
  skipTypewriter(): void {
    if (!this.typewriterActive) {
      return;
    }
    this.typewriterVisible = this.renderState?.layout.totalChars ?? 0;
    this.finishTypewriter();
  }

  /** Restart the typewriter reveal from the first character. */
  restartTypewriter(): void {
    if (this.typewriterSpeed <= 0 || !this.renderState) {
      return;
    }
    this.typewriterVisible = 0;
    this.typewriterActive = this.renderState.layout.totalChars > 0;
    this.repaint();
  }

  override tick(dt: number): void {
    super.tick(dt);

    if (this.typewriterActive && this.typewriterSpeed > 0 && this.renderState) {
      const previous = Math.floor(this.typewriterVisible);
      this.typewriterVisible += dt * this.typewriterSpeed;
      if (this.typewriterVisible >= this.renderState.layout.totalChars) {
        this.finishTypewriter();
      } else if (Math.floor(this.typewriterVisible) !== previous) {
        this.repaint();
      }
    }

    if (!this.input) return;

    const isDown = this.input.isPointerDown;
    const pointerWorld = this.getPointerWorldPosition();
    if (!pointerWorld) return;

    // Still update pointer state for hover registry/blocking joystick
    this.updatePointerState(pointerWorld.x, pointerWorld.y, isDown);
  }

  override isPointInBounds(worldPoint: Vector2): boolean {
    const state = this.renderState;
    if (!state) return false;

    this.getWorldPosition(this.tmpWorldPos);
    const dx = Math.abs(worldPoint.x - this.tmpWorldPos.x);
    const dy = Math.abs(worldPoint.y - this.tmpWorldPos.y);

    return dx <= state.boxWidth / 2 && dy <= state.boxHeight / 2;
  }

  override updateLabel(): void {
    const text = this.getDisplayText();
    if (text.length === 0) {
      this.renderState = null;
      this.typewriterActive = false;
      if (this.labelMesh) {
        this.remove(this.labelMesh);
        this.labelMesh = null;
      }
      this.labelTexture?.dispose();
      this.labelTexture = null;
      return;
    }

    // The base constructor calls updateLabel before Label2D fields initialize.
    const boxWidthProp = this.width ?? 0;
    const boxHeightProp = this.height ?? 0;
    const fontSize = Math.max(1, this.labelFontSize || 16);

    const canvas = this.renderState?.canvas ?? document.createElement('canvas');
    const ctx = this.renderState?.ctx ?? canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas 2D context');

    ctx.font = `${fontSize}px ${this.labelFontFamily}`;
    const layout = layoutLabelText(text, line => ctx.measureText(line).width, {
      fontSize,
      maxWidth: boxWidthProp > 0 ? boxWidthProp : 0,
    });

    const boxWidth =
      boxWidthProp > 0 ? boxWidthProp : Math.ceil(layout.textWidth) + LABEL_AUTO_SIZE_BLEED;
    const boxHeight =
      boxHeightProp > 0 ? boxHeightProp : Math.ceil(layout.textHeight) + LABEL_AUTO_SIZE_BLEED;

    const dprRaw = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const dpr = Math.max(1, Math.min(3, dprRaw));
    const pixelWidth = Math.max(1, Math.round(boxWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(boxHeight * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const textChanged = this.renderState?.text !== text;
    this.renderState = { canvas, ctx, layout, boxWidth, boxHeight, text };

    const typewriterEnabled = (this.typewriterSpeed ?? 0) > 0;
    if (textChanged) {
      this.typewriterVisible = 0;
      this.typewriterActive = typewriterEnabled && layout.totalChars > 0;
    } else if (!typewriterEnabled) {
      this.typewriterActive = false;
    }

    // Recreate the texture only when the backing canvas is new; repaints of
    // the same canvas just need a needsUpdate flip.
    if (!this.labelTexture || this.labelTexture.image !== canvas) {
      this.labelTexture?.dispose();
      this.labelTexture = new CanvasTexture(canvas);
      configure2DTexture(this.labelTexture);
    }
    this.labelTexture.userData = {
      ...(this.labelTexture.userData ?? {}),
      logicalWidth: boxWidth,
      logicalHeight: boxHeight,
      dpr,
    };

    if (!this.labelMesh) {
      const material = new MeshBasicMaterial({
        map: this.labelTexture,
        transparent: true,
        depthTest: false,
      });
      this.registerOpacityMaterial(material, 1);
      this.labelMesh = new Mesh(new PlaneGeometry(1, 1), material);
      this.labelMesh.renderOrder = 1001;
      this.labelMesh.position.z = 2;
      this.add(this.labelMesh);
    } else {
      const material = this.labelMesh.material as MeshBasicMaterial;
      material.map = this.labelTexture;
      material.needsUpdate = true;
    }
    this.labelMesh.scale.set(boxWidth, boxHeight, 1);

    this.repaint();
  }

  private finishTypewriter(): void {
    this.typewriterVisible = this.renderState?.layout.totalChars ?? 0;
    this.typewriterActive = false;
    this.repaint();
    this.emit('typewriter-complete');
  }

  private repaint(): void {
    const state = this.renderState;
    if (!state || !this.labelTexture) {
      return;
    }
    paintLabelCanvas(state.ctx, {
      layout: state.layout,
      fontFamily: this.labelFontFamily,
      fontSize: Math.max(1, this.labelFontSize || 16),
      color: this.labelColor,
      align: this.labelAlign,
      vAlign: this.labelVAlign ?? 'middle',
      width: state.boxWidth,
      height: state.boxHeight,
      visibleCharacters: this.typewriterActive ? Math.floor(this.typewriterVisible) : Infinity,
    });
    this.labelTexture.needsUpdate = true;
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = UIControl2D.getPropertySchema();
    const properties = baseSchema.properties.map(prop => {
      // Upgrade the inherited free-text alignment to a dropdown for labels.
      if (prop.name === 'labelAlign') {
        return {
          ...prop,
          type: 'enum' as const,
          ui: { ...prop.ui, options: [...LABEL_H_ALIGN_VALUES] },
        };
      }
      return prop;
    });
    return {
      nodeType: 'Label2D',
      extends: 'UIControl2D',
      properties: [
        ...properties,
        {
          name: 'width',
          type: 'number',
          ui: {
            label: 'Width',
            group: 'Label',
            min: 0,
            step: 1,
            unit: 'px',
            description: 'Fixed box width; text word-wraps to it. 0 = auto-size, no wrapping',
          },
          getValue: n => (n as Label2D).width,
          setValue: (n, v) => {
            const label = n as Label2D;
            label.width = Math.max(0, Number(v) || 0);
            label.updateLabel();
          },
        },
        {
          name: 'height',
          type: 'number',
          ui: {
            label: 'Height',
            group: 'Label',
            min: 0,
            step: 1,
            unit: 'px',
            description: 'Fixed box height for vertical alignment. 0 = auto-size to the lines',
          },
          getValue: n => (n as Label2D).height,
          setValue: (n, v) => {
            const label = n as Label2D;
            label.height = Math.max(0, Number(v) || 0);
            label.updateLabel();
          },
        },
        {
          name: 'labelVAlign',
          type: 'enum',
          ui: {
            label: 'V-Alignment',
            group: 'Label',
            options: [...LABEL_V_ALIGN_VALUES],
            description: 'Vertical text placement inside a fixed-height box',
          },
          getValue: n => (n as Label2D).labelVAlign,
          setValue: (n, v) => {
            const label = n as Label2D;
            const value = String(v) as LabelVAlign;
            if (LABEL_V_ALIGN_VALUES.includes(value)) {
              label.labelVAlign = value;
              label.updateLabel();
            }
          },
        },
        {
          name: 'typewriterSpeed',
          type: 'number',
          ui: {
            label: 'Typewriter Speed',
            group: 'Label',
            min: 0,
            step: 1,
            unit: 'chars/s',
            description: 'Reveal the text character by character in play mode; 0 = off',
          },
          getValue: n => (n as Label2D).typewriterSpeed,
          setValue: (n, v) => {
            const label = n as Label2D;
            label.typewriterSpeed = Math.max(0, Number(v) || 0);
            label.restartTypewriter();
          },
        },
      ],
      groups: baseSchema.groups,
    };
  }
}
