import { Mesh, MeshBasicMaterial, PlaneGeometry, Vector2 } from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';
import { readBooleanArg, type InteractionDescriptor } from '../../../fw/interactive';
import {
  assignWithoutSchemaRefresh,
  installReactiveSchemaProperties,
} from '../../../fw/reactive-schema-properties';

export interface Checkbox2DProps extends UIControl2DProps {
  size?: number;
  checked?: boolean;
  uncheckedColor?: string;
  checkedColor?: string;
  checkmarkColor?: string;
  checkmarkAction?: string;
}

/**
 * A checkbox/toggle control for 2D UI.
 * Emits virtual button presses and supports toggle callbacks.
 *
 * Pointer handling runs through the shared `UIControl2D` funnel, which means: the control emits the
 * lifecycle signals (`pointerdown`/`pressed`/`pointerup`/`released`/`click`), tracks hover, honours
 * the ancestor-scroll gate (a scroll drag passing over the box no longer toggles it) and flips on
 * RELEASE inside the bounds — it used to flip on press-down, which double-fired against a drag.
 *
 * ## `click` vs `toggled` (Godot's split, and why it exists)
 *
 * - **`click`** is a POINTER signal: "I was clicked". Like every funnel signal it fires at the
 *   moment the gesture completes, *before* the control reacts to it — so inside a `click` listener
 *   `checked` still holds the value the box had before the click.
 * - **`toggled`** is a STATE signal: "my checked state changed", emitted with the new value
 *   (`checkbox.connect('toggled', this, checked => …)`) once the flip, the repaint and the virtual
 *   button/axis are all in place. It fires for every spelling of the change — a tap, a semantic
 *   `toggle`/`setChecked` interaction, `checkbox.checked = x` from a script, an Inspector edit.
 *
 * Anything that applies the checkbox's state (mute a bus, show a panel) connects to `toggled` and
 * reads the payload or the node. Connecting that to `click` and reading `checked` gives the PREVIOUS
 * state, which reads as inverted behaviour — the trap this split closes.
 */
export class Checkbox2D extends UIControl2D {
  size: number;
  checked: boolean;
  uncheckedColor: string;
  checkedColor: string;
  checkmarkColor: string;
  checkmarkAction: string;

  private boxMesh: Mesh;
  private boxMaterial: MeshBasicMaterial;
  private checkMesh: Mesh | null = null;
  private checkMaterial: MeshBasicMaterial | null = null;
  private geometry: PlaneGeometry;
  private checkGeometry: PlaneGeometry | null = null;

  constructor(props: Checkbox2DProps) {
    super(props, 'Checkbox2D');

    this.size = props.size ?? 30;
    this.checked = props.checked ?? false;
    this.uncheckedColor = props.uncheckedColor ?? '#ffffff';
    this.checkedColor = props.checkedColor ?? '#4a9eff';
    this.checkmarkColor = props.checkmarkColor ?? '#ffffff';
    this.checkmarkAction = props.checkmarkAction ?? 'Checkbox';

    // Create checkbox box
    this.geometry = new PlaneGeometry(this.size, this.size);
    this.boxMaterial = new MeshBasicMaterial({
      color: this.checked ? this.checkedColor : this.uncheckedColor,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
    });
    this.registerSkinMaterial(this.boxMaterial);
    this.boxMesh = new Mesh(this.geometry, this.boxMaterial);
    this.boxMesh.renderOrder = 999;
    this.add(this.boxMesh);

    // Create checkmark if checked
    if (this.checked) {
      this.createCheckmark();
    }

    // A checkbox reads as "[box] Label", so default the label to left-aligned
    // and lay it out beside the box (see updateLabel override). The base
    // constructor already rendered it centered-on-control while `size` was
    // still undefined, so re-run now that our props are set.
    if (props.labelAlign === undefined) {
      this.labelAlign = 'left';
    }
    if (this.label.trim().length > 0) {
      this.updateLabel();
    }

    // Last: `checkbox.checked = true` from a script now draws/removes the checkmark like the
    // Inspector does — toggle() was the only working spelling before.
    installReactiveSchemaProperties(this, Checkbox2D.getPropertySchema);
  }

  /** Horizontal gap between the box's right edge and the label plane. */
  private static readonly LABEL_GAP = 6;

  protected override updateLabel(): void {
    super.updateLabel();
    if (!this.labelMesh) return;
    // Position the label to the right of the box, vertically centered —
    // instead of the base class's centered-on-control placement, which would
    // draw the text on top of the box.
    this.labelMesh.position.x = this.size / 2 + this.labelMesh.scale.x / 2 + Checkbox2D.LABEL_GAP;
    this.labelMesh.position.y = 0;
  }

  private createCheckmark(): void {
    const checkSize = this.size * 0.6;
    this.checkGeometry = new PlaneGeometry(checkSize, checkSize * 0.5);
    this.checkMaterial = new MeshBasicMaterial({
      color: this.checkmarkColor,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.checkMaterial, 1);
    this.checkMesh = new Mesh(this.checkGeometry, this.checkMaterial);
    this.checkMesh.renderOrder = 1000;
    this.checkMesh.position.z = 0.1;
    this.checkMesh.rotation.z = Math.PI / 4; // Tilt checkmark
    this.add(this.checkMesh);
  }

  override isPointInBounds(worldPoint: Vector2): boolean {
    this.getWorldPosition(this.tmpWorldPos);
    const localX = worldPoint.x - this.tmpWorldPos.x;
    const localY = worldPoint.y - this.tmpWorldPos.y;
    // Hit area spans the box plus the label to its right, so clicking the
    // text toggles the checkbox too.
    let maxX = this.size / 2;
    if (this.labelMesh) {
      maxX = Math.max(maxX, this.labelMesh.position.x + this.labelMesh.scale.x / 2);
    }
    return localX >= -this.size / 2 && localX <= maxX && Math.abs(localY) <= this.size / 2;
  }

  /**
   * True while the virtual button raised by {@link toggle} still has to be lowered. The pulse is
   * one FRAME long and released at the top of the next tick — never on a wall clock, so it lands on
   * the same frame boundary under a paused, stepped or accelerated game loop.
   */
  private pendingActionRelease = false;

  override tick(dt: number): void {
    super.tick(dt);

    if (this.pendingActionRelease) {
      this.pendingActionRelease = false;
      this.input?.setButton(this.checkmarkAction, false);
    }

    // Hover/press/click all come from the shared UIControl2D funnel: it applies `enabled`, the
    // ancestor-scroll gate and emits the lifecycle signals. The toggle itself hangs off onClick().
    this.updatePointerStateFromInput();
  }

  /**
   * Flip the checked state. Called by the funnel on a completed click (released inside the bounds,
   * just AFTER the `click` signal was emitted) and directly by scripts. That order is why `click`
   * listeners still read the pre-click `checked`, and why anything acting on the state connects to
   * `toggled` instead.
   */
  protected override onClick(): void {
    this.toggle();
  }

  override getInteractions(): InteractionDescriptor[] {
    return [
      ...super.getInteractions(),
      { name: 'toggle', description: 'Flip the checkbox by clicking it' },
      {
        name: 'setChecked',
        description: 'Click the checkbox only if that reaches the requested state',
        args: [
          {
            name: 'checked',
            type: 'boolean',
            ui: { label: 'Checked', description: 'Desired state after the interaction' },
          },
        ],
      },
    ];
  }

  protected override performInteraction(name: string, args?: Record<string, unknown>): boolean {
    switch (name) {
      case 'toggle':
        // A click, not a call to toggle(): the state flip has to arrive through onClick() so the
        // signals, the skin and the virtual button pulse all happen the way a tap makes them.
        return this.runSemanticClick();
      case 'setChecked': {
        const desired = readBooleanArg(args, 'checked');
        if (desired === null) return false;
        // The gates still apply even when nothing has to change — a disabled checkbox accepts no
        // interaction, including a redundant one.
        if (!this.canAcceptSemanticPointer()) return false;
        if (this.checked === desired) return true;
        return this.runSemanticClick();
      }
      default:
        return super.performInteraction(name, args);
    }
  }

  /**
   * Toggle the checkbox state.
   *
   * The virtual button/axis is raised BEFORE the state lands, so that by the time `toggled` fires
   * everything a listener can observe — `checked`, the visuals, the action axis — is already the
   * new state.
   */
  toggle(): void {
    const next = !this.checked;
    this.input?.setButton(this.checkmarkAction, true);
    this.input?.setAxis(this.checkmarkAction, next ? 1 : 0);
    // Lowered by the next tick (see pendingActionRelease) rather than by a setTimeout, which fired
    // on wall-clock time and therefore on an arbitrary frame.
    this.pendingActionRelease = true;
    this.applyChecked(next);
  }

  /**
   * The one funnel every checked-state change goes through: store, repaint, then emit `toggled`
   * with the new value. Called by {@link toggle} and by the schema's `setValue` (which is what a
   * script's `checkbox.checked = x` and an Inspector edit both reach), so a listener can never be
   * told about a state the node has not adopted yet.
   *
   * The field is written through `assignWithoutSchemaRefresh` because the schema `setValue` routes
   * back here — a plain assignment would run the refresh (and this emit) a second time.
   */
  private applyChecked(next: boolean): void {
    if (this.checked === next) {
      return;
    }
    assignWithoutSchemaRefresh(this, 'checked', next);
    this.updateCheckboxVisuals();
    this.emit('toggled', next);
  }

  private updateCheckboxVisuals(): void {
    // Update box color
    this.boxMaterial.color.setStyle(this.checked ? this.checkedColor : this.uncheckedColor);

    // Update checkmark
    if (this.checked && !this.checkMesh) {
      this.createCheckmark();
    } else if (!this.checked && this.checkMesh) {
      this.remove(this.checkMesh);
      this.checkGeometry?.dispose();
      this.checkMaterial?.dispose();
      this.checkMesh = null;
      this.checkGeometry = null;
      this.checkMaterial = null;
    }
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = UIControl2D.getPropertySchema();
    return {
      nodeType: 'Checkbox2D',
      extends: 'UIControl2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'size',
          type: 'number',
          ui: { label: 'Size', group: 'Checkbox', min: 10, max: 100, step: 1 },
          getValue: n => (n as Checkbox2D).size,
          setValue: (n, v) => {
            const cb = n as Checkbox2D;
            cb.size = Number(v);
            cb.geometry.dispose();
            cb.geometry = new PlaneGeometry(cb.size, cb.size);
            cb.boxMesh.geometry = cb.geometry;
            if (cb.checked && cb.checkGeometry) {
              const checkSize = cb.size * 0.6;
              cb.checkGeometry.dispose();
              cb.checkGeometry = new PlaneGeometry(checkSize, checkSize * 0.5);
              if (cb.checkMesh) cb.checkMesh.geometry = cb.checkGeometry;
            }
          },
        },
        {
          name: 'checked',
          type: 'boolean',
          ui: { label: 'Checked', group: 'Checkbox' },
          getValue: n => (n as Checkbox2D).checked,
          setValue: (n, v) => {
            // Same funnel as a tap: repaint plus a `toggled` emit once the new state is in place.
            (n as Checkbox2D).applyChecked(Boolean(v));
          },
        },
        {
          name: 'uncheckedColor',
          type: 'color',
          ui: { label: 'Unchecked Color', group: 'Checkbox' },
          getValue: n => (n as Checkbox2D).uncheckedColor,
          setValue: (n, v) => {
            const cb = n as Checkbox2D;
            cb.uncheckedColor = String(v);
            if (!cb.checked) {
              cb.boxMaterial.color.setStyle(cb.uncheckedColor);
            }
          },
        },
        {
          name: 'checkedColor',
          type: 'color',
          ui: { label: 'Checked Color', group: 'Checkbox' },
          getValue: n => (n as Checkbox2D).checkedColor,
          setValue: (n, v) => {
            const cb = n as Checkbox2D;
            cb.checkedColor = String(v);
            if (cb.checked) {
              cb.boxMaterial.color.setStyle(cb.checkedColor);
            }
          },
        },
        {
          name: 'checkmarkColor',
          type: 'color',
          ui: { label: 'Checkmark Color', group: 'Checkbox' },
          getValue: n => (n as Checkbox2D).checkmarkColor,
          setValue: (n, v) => {
            const cb = n as Checkbox2D;
            cb.checkmarkColor = String(v);
            if (cb.checkMaterial) {
              cb.checkMaterial.color.setStyle(cb.checkmarkColor);
            }
          },
        },
        {
          name: 'checkmarkAction',
          type: 'string',
          ui: { label: 'Action', group: 'Input', description: 'Virtual button/axis name' },
          getValue: n => (n as Checkbox2D).checkmarkAction,
          setValue: (n, v) => {
            (n as Checkbox2D).checkmarkAction = String(v);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Checkbox: { label: 'Checkbox', expanded: true },
      },
    };
  }
}
