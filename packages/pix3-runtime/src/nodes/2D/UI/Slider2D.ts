import { Mesh, MeshBasicMaterial, PlaneGeometry, Vector2 } from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';
import { readNumberArg, type InteractionDescriptor } from '../../../fw/interactive';
import { installReactiveSchemaProperties } from '../../../fw/reactive-schema-properties';

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

  private trackMesh: Mesh;
  private filledTrackMesh: Mesh;
  private handleMesh: Mesh;
  private trackMaterial: MeshBasicMaterial;
  private filledTrackMaterial: MeshBasicMaterial;
  private handleMaterial: MeshBasicMaterial;
  private trackGeometry: PlaneGeometry;
  private filledTrackGeometry: PlaneGeometry;
  private handleGeometry: PlaneGeometry;

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

    // Create track background
    this.trackGeometry = new PlaneGeometry(this.width, this.height);
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

    // Update filled track. PlaneGeometry is centered on the origin, so offset
    // the mesh to anchor the fill to the track's left edge (grows rightward).
    this.filledTrackGeometry.dispose();
    this.filledTrackGeometry = new PlaneGeometry(filledWidth, this.height);
    this.filledTrackMesh.geometry = this.filledTrackGeometry;
    this.filledTrackMesh.position.x = -this.width / 2 + filledWidth / 2;

    // Update handle position
    const handleX = -this.width / 2 + filledWidth;
    this.handleMesh.position.x = handleX;
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
            slider.trackGeometry.dispose();
            slider.trackGeometry = new PlaneGeometry(slider.width, slider.height);
            slider.trackMesh.geometry = slider.trackGeometry;
            slider.updateSliderVisuals();
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
            slider.trackGeometry.dispose();
            slider.trackGeometry = new PlaneGeometry(slider.width, slider.height);
            slider.trackMesh.geometry = slider.trackGeometry;
            slider.updateSliderVisuals();
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
            slider.trackMaterial.color.setStyle(slider.trackBackgroundColor);
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
            slider.filledTrackMaterial.color.setStyle(slider.trackFilledColor);
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
            slider.handleMaterial.color.setStyle(slider.handleColor);
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
      },
    };
  }
}
