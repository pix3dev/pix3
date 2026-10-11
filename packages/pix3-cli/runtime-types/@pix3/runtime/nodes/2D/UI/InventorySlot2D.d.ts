import { Vector2 } from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';
import type { InteractionDescriptor } from '../../../fw/interactive';
export interface InventorySlot2DProps extends UIControl2DProps {
    width?: number;
    height?: number;
    backdropColor?: string;
    borderColor?: string;
    borderWidth?: number;
    quantity?: number;
    showQuantity?: boolean;
    quantityFontSize?: number;
    selectionColor?: string;
    selectedAction?: string;
}
/**
 * An inventory slot control for displaying items, typically in inventory/shop UIs.
 * Can display a quantity number and support selection/click events.
 *
 * Pointer handling runs through the shared `UIControl2D` funnel, which means: the slot emits the
 * lifecycle signals (`pointerdown`/`pressed`/`pointerup`/`released`/`click`), tracks hover, honours
 * the ancestor-scroll gate and activates on RELEASE inside the bounds (it used to activate on
 * press-down).
 *
 * Signals split the same way `Checkbox2D`'s do: **`click`** is the pointer signal ("I was clicked"),
 * emitted before the slot reacts, so `selected` still reads its pre-click value inside a `click`
 * listener. **`toggled`** is the state signal, emitted with the new `selected` value once the
 * selection and its visuals are in place — that is the one an inventory connects to.
 */
export declare class InventorySlot2D extends UIControl2D {
    width: number;
    height: number;
    backdropColor: string;
    borderColor: string;
    borderWidth: number;
    quantity: number;
    showQuantity: boolean;
    quantityFontSize: number;
    selectionColor: string;
    selectedAction: string;
    selected: boolean;
    private slotMesh;
    private slotMaterial;
    private borderMesh;
    private borderMaterial;
    private quantityMesh;
    private quantityTexture;
    private slotGeometry;
    private borderGeometry;
    constructor(props: InventorySlot2DProps);
    private createBorder;
    private createQuantityTexture;
    private updateQuantityDisplay;
    isPointInBounds(worldPoint: Vector2): boolean;
    tick(dt: number): void;
    /**
     * Activate the slot on a completed click (released inside the bounds, just after the `click`
     * signal was emitted). Slots usually live inside a scrolling inventory list, which is exactly
     * where press-down activation misfired: flicking the list selected whatever was under the finger.
     */
    protected onClick(): void;
    getInteractions(): InteractionDescriptor[];
    protected performInteraction(name: string, args?: Record<string, unknown>): boolean;
    /**
     * Select this slot (toggle selection).
     *
     * `toggled` is emitted last, with the new value: by then `selected`, the highlight and the
     * virtual button all agree, which is what the `click` signal cannot promise (it fires before
     * {@link onClick} gets here).
     */
    select(): void;
    /**
     * Set quantity of items in slot
     */
    setQuantity(qty: number): void;
    private updateSlotVisuals;
    static getPropertySchema(): PropertySchema;
}
