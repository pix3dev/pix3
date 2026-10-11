import { type Texture, Vector2 } from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';
import { type InteractionDescriptor } from '../../../fw/interactive';
import { type TextureResourceRef } from '../../../core/TextureResource';
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
export declare class Checkbox2D extends UIControl2D {
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
    private readonly slotTextures;
    private boxMesh;
    private boxMaterial;
    private checkMesh;
    private checkMaterial;
    private geometry;
    private checkGeometry;
    constructor(props: Checkbox2DProps);
    /** Horizontal gap between the box's right edge and the label plane. */
    private static readonly LABEL_GAP;
    protected updateLabel(): void;
    private createCheckmark;
    /** Mark quad: box-sized for a sprite, the small tilted bar for the colour tick. */
    private static buildMarkGeometry;
    private destroyCheckmark;
    /**
     * Assign the loaded `Texture` for one skin slot (called by the SceneLoader after
     * loading, mirroring `Button2D.setStateTexture`). Passing null clears the slot
     * and the control falls back to its flat colours.
     */
    setSlotTexture(slot: Checkbox2DTextureSlot, texture: Texture | null): void;
    /** The authored path that should be loaded for a slot, or null. */
    getSlotTexturePath(slot: Checkbox2DTextureSlot): string | null;
    private setSlotTextureRef;
    /** Box sprite for the current checked state (checked falls back to the box sprite). */
    private resolveBoxTexture;
    /** Apply the box sprite, or the flat colour when no sprite is set. */
    private refreshBoxSkin;
    isPointInBounds(worldPoint: Vector2): boolean;
    /**
     * True while the virtual button raised by {@link toggle} still has to be lowered. The pulse is
     * one FRAME long and released at the top of the next tick — never on a wall clock, so it lands on
     * the same frame boundary under a paused, stepped or accelerated game loop.
     */
    private pendingActionRelease;
    tick(dt: number): void;
    /**
     * Flip the checked state. Called by the funnel on a completed click (released inside the bounds,
     * just AFTER the `click` signal was emitted) and directly by scripts. That order is why `click`
     * listeners still read the pre-click `checked`, and why anything acting on the state connects to
     * `toggled` instead.
     */
    protected onClick(): void;
    getInteractions(): InteractionDescriptor[];
    protected performInteraction(name: string, args?: Record<string, unknown>): boolean;
    /**
     * Toggle the checkbox state.
     *
     * The virtual button/axis is raised BEFORE the state lands, so that by the time `toggled` fires
     * everything a listener can observe — `checked`, the visuals, the action axis — is already the
     * new state.
     */
    toggle(): void;
    /**
     * The one funnel every checked-state change goes through: store, repaint, then emit `toggled`
     * with the new value. Called by {@link toggle} and by the schema's `setValue` (which is what a
     * script's `checkbox.checked = x` and an Inspector edit both reach), so a listener can never be
     * told about a state the node has not adopted yet.
     *
     * The field is written through `assignWithoutSchemaRefresh` because the schema `setValue` routes
     * back here — a plain assignment would run the refresh (and this emit) a second time.
     */
    private applyChecked;
    private updateCheckboxVisuals;
    static getPropertySchema(): PropertySchema;
}
