import { Mesh, MeshBasicMaterial, PlaneGeometry, type Texture, Vector2 } from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';
import { readBooleanArg, type InteractionDescriptor } from '../../../fw/interactive';
import {
  assignWithoutSchemaRefresh,
  installReactiveSchemaProperties,
} from '../../../fw/reactive-schema-properties';
import { coerceTextureResource, type TextureResourceRef } from '../../../core/TextureResource';
import { configure2DTexture } from '../../../core/configure-2d-texture';

/** The three skin slots a checkbox can be given a sprite for. */
export type Checkbox2DTextureSlot = 'box' | 'boxChecked' | 'mark';

export interface Checkbox2DProps extends UIControl2DProps {
  size?: number;
  checked?: boolean;
  uncheckedColor?: string;
  checkedColor?: string;
  checkmarkColor?: string;
  checkmarkAction?: string;
  /** Sprite for the box in its unchecked state (and the checked fallback). */
  textureBox?: TextureResourceRef | string | null;
  /** Optional sprite for the box while checked; falls back to {@link Checkbox2DProps.textureBox}. */
  textureBoxChecked?: TextureResourceRef | string | null;
  /** Sprite drawn over the box while checked (the tick itself). */
  textureMark?: TextureResourceRef | string | null;
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
  /**
   * Skin slots. A set slot replaces the corresponding flat colour with the sprite
   * (material colour goes white, exactly as `Button2D` does for its state skins);
   * an unset slot keeps the historical colour fill. The actual `Texture` objects
   * are supplied post-construction by the SceneLoader - nodes have no asset loader,
   * so the schema stores only resource refs.
   */
  textureBox: TextureResourceRef | null;
  textureBoxChecked: TextureResourceRef | null;
  textureMark: TextureResourceRef | null;

  private readonly slotTextures: Record<Checkbox2DTextureSlot, Texture | null> = {
    box: null,
    boxChecked: null,
    mark: null,
  };

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
    this.textureBox = coerceTextureResource(props.textureBox ?? null);
    this.textureBoxChecked = coerceTextureResource(props.textureBoxChecked ?? null);
    this.textureMark = coerceTextureResource(props.textureMark ?? null);

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
    const markTexture = this.slotTextures.mark;
    // A mark SPRITE covers the whole box unrotated (the artwork carries the shape);
    // without one the historical tilted colour bar stands in for a tick.
    this.checkGeometry = Checkbox2D.buildMarkGeometry(this.size, markTexture !== null);
    this.checkMaterial = new MeshBasicMaterial({
      color: markTexture ? '#ffffff' : this.checkmarkColor,
      map: markTexture,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.checkMaterial, 1);
    this.checkMesh = new Mesh(this.checkGeometry, this.checkMaterial);
    this.checkMesh.renderOrder = 1000;
    this.checkMesh.position.z = 0.1;
    this.checkMesh.rotation.z = markTexture ? 0 : Math.PI / 4; // Tilt the colour tick only
    this.add(this.checkMesh);
  }

  /** Mark quad: box-sized for a sprite, the small tilted bar for the colour tick. */
  private static buildMarkGeometry(size: number, textured: boolean): PlaneGeometry {
    if (textured) {
      return new PlaneGeometry(size, size);
    }
    const checkSize = size * 0.6;
    return new PlaneGeometry(checkSize, checkSize * 0.5);
  }

  private destroyCheckmark(): void {
    if (!this.checkMesh) {
      return;
    }
    this.remove(this.checkMesh);
    this.checkGeometry?.dispose();
    this.checkMaterial?.dispose();
    this.checkMesh = null;
    this.checkGeometry = null;
    this.checkMaterial = null;
  }

  /**
   * Assign the loaded `Texture` for one skin slot (called by the SceneLoader after
   * loading, mirroring `Button2D.setStateTexture`). Passing null clears the slot
   * and the control falls back to its flat colours.
   */
  setSlotTexture(slot: Checkbox2DTextureSlot, texture: Texture | null): void {
    if (texture) {
      // sRGB + mipmaps disabled (see configure2DTexture for the why).
      configure2DTexture(texture);
    }
    this.slotTextures[slot] = texture;
    if (slot === 'mark') {
      // The mark mesh's geometry and rotation differ between sprite and colour tick.
      if (this.checked) {
        this.destroyCheckmark();
        this.createCheckmark();
      }
      return;
    }
    this.refreshBoxSkin();
  }

  /** The authored path that should be loaded for a slot, or null. */
  getSlotTexturePath(slot: Checkbox2DTextureSlot): string | null {
    switch (slot) {
      case 'box':
        return this.textureBox?.url ?? null;
      case 'boxChecked':
        return this.textureBoxChecked?.url ?? null;
      case 'mark':
        return this.textureMark?.url ?? null;
    }
  }

  private setSlotTextureRef(slot: Checkbox2DTextureSlot, value: unknown): void {
    const ref = coerceTextureResource(value);
    const previous = this.getSlotTexturePath(slot);
    switch (slot) {
      case 'box':
        this.textureBox = ref;
        break;
      case 'boxChecked':
        this.textureBoxChecked = ref;
        break;
      case 'mark':
        this.textureMark = ref;
        break;
    }
    if (previous !== (ref?.url ?? null)) {
      // The loaded Texture no longer matches the ref; drop it. The SceneLoader
      // reloads from the ref on the next scene load / play.
      this.setSlotTexture(slot, null);
    }
  }

  /** Box sprite for the current checked state (checked falls back to the box sprite). */
  private resolveBoxTexture(): Texture | null {
    if (this.checked) {
      return this.slotTextures.boxChecked ?? this.slotTextures.box;
    }
    return this.slotTextures.box;
  }

  /** Apply the box sprite, or the flat colour when no sprite is set. */
  private refreshBoxSkin(): void {
    if (!this.boxMaterial) {
      return; // guard: called before the material exists during construction
    }
    const texture = this.resolveBoxTexture();
    const hadMap = this.boxMaterial.map !== null;
    if (texture) {
      this.boxMaterial.map = texture;
      this.boxMaterial.color.set('#ffffff');
      this.boxMaterial.transparent = true;
    } else {
      this.boxMaterial.map = null;
      this.boxMaterial.color.setStyle(this.checked ? this.checkedColor : this.uncheckedColor);
    }
    if (hadMap !== (texture !== null)) {
      this.boxMaterial.needsUpdate = true;
    }
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
    // Box: the checked/unchecked sprite when one is set, else the flat colour.
    this.refreshBoxSkin();

    // Mark: present exactly while checked.
    if (this.checked && !this.checkMesh) {
      this.createCheckmark();
    } else if (!this.checked && this.checkMesh) {
      this.destroyCheckmark();
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
              cb.checkGeometry.dispose();
              cb.checkGeometry = Checkbox2D.buildMarkGeometry(
                cb.size,
                cb.slotTextures.mark !== null
              );
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
            cb.refreshBoxSkin();
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
            cb.refreshBoxSkin();
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
            // A mark SPRITE keeps its white tint; the colour only drives the fallback tick.
            if (cb.checkMaterial && !cb.slotTextures.mark) {
              cb.checkMaterial.color.setStyle(cb.checkmarkColor);
            }
          },
        },
        {
          name: 'textureBox',
          type: 'object',
          ui: {
            label: 'Box Sprite',
            group: 'Skin',
            description: 'Sprite for the box (also the checked fallback)',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: n => (n as Checkbox2D).textureBox ?? { type: 'texture', url: '' },
          setValue: (n, v) => {
            (n as Checkbox2D).setSlotTextureRef('box', v);
          },
        },
        {
          name: 'textureBoxChecked',
          type: 'object',
          ui: {
            label: 'Checked Box Sprite',
            group: 'Skin',
            description: 'Optional sprite for the box while checked',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: n => (n as Checkbox2D).textureBoxChecked ?? { type: 'texture', url: '' },
          setValue: (n, v) => {
            (n as Checkbox2D).setSlotTextureRef('boxChecked', v);
          },
        },
        {
          name: 'textureMark',
          type: 'object',
          ui: {
            label: 'Mark Sprite',
            group: 'Skin',
            description: 'Sprite drawn over the box while checked',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: n => (n as Checkbox2D).textureMark ?? { type: 'texture', url: '' },
          setValue: (n, v) => {
            (n as Checkbox2D).setSlotTextureRef('mark', v);
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
        Skin: { label: 'Skin', description: 'Sprites replacing the flat colours', expanded: true },
      },
    };
  }
}
