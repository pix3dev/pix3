import {
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    CanvasTexture,
    Vector2,
} from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';

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
 */
export class InventorySlot2D extends UIControl2D {
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
    selected: boolean = false;

    private slotMesh: Mesh;
    private slotMaterial: MeshBasicMaterial;
    private borderMesh: Mesh | null = null;
    private borderMaterial: MeshBasicMaterial | null = null;
    private quantityMesh: Mesh | null = null;
    private quantityTexture: CanvasTexture | null = null;
    private slotGeometry: PlaneGeometry;
    private borderGeometry: PlaneGeometry | null = null;

    constructor(props: InventorySlot2DProps) {
        super(props, 'InventorySlot2D');

        this.width = props.width ?? 60;
        this.height = props.height ?? 60;
        this.backdropColor = props.backdropColor ?? '#555555';
        this.borderColor = props.borderColor ?? '#888888';
        this.borderWidth = props.borderWidth ?? 2;
        this.quantity = Math.max(0, props.quantity ?? 0);
        this.showQuantity = props.showQuantity ?? true;
        this.quantityFontSize = props.quantityFontSize ?? 12;
        this.selectionColor = props.selectionColor ?? '#ffff00';
        this.selectedAction = props.selectedAction ?? 'SlotSelected';

        // Create slot backdrop
        this.slotGeometry = new PlaneGeometry(this.width, this.height);
        this.slotMaterial = new MeshBasicMaterial({
            color: this.backdropColor,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
        });
        this.registerSkinMaterial(this.slotMaterial);
        this.slotMesh = new Mesh(this.slotGeometry, this.slotMaterial);
        this.slotMesh.renderOrder = 999;
        this.add(this.slotMesh);

        // Create border
        this.createBorder();

        // Create quantity display
        if (this.showQuantity && this.quantity > 0) {
            this.updateQuantityDisplay();
        }
    }

    private createBorder(): void {
        this.borderGeometry = new PlaneGeometry(this.width, this.height);
        this.borderMaterial = new MeshBasicMaterial({
            color: this.borderColor,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
            wireframe: false,
        });
        this.registerOpacityMaterial(this.borderMaterial, 1);
        this.borderMesh = new Mesh(this.borderGeometry, this.borderMaterial);
        this.borderMesh.renderOrder = 1000;
        this.borderMesh.position.z = 0.1;
        this.add(this.borderMesh);
    }

    private createQuantityTexture(): CanvasTexture {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get canvas 2D context');

        // Clear canvas
        ctx.fillStyle = 'rgba(0, 0, 0, 0)';
        ctx.fillRect(0, 0, 64, 64);

        // Draw quantity text in bottom-right corner
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${this.quantityFontSize}px Arial`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(String(this.quantity), 60, 60);

        const texture = new CanvasTexture(canvas);
        texture.needsUpdate = true;
        return texture;
    }

    private updateQuantityDisplay(): void {
        if (!this.showQuantity || this.quantity <= 0) {
            if (this.quantityMesh) {
                this.remove(this.quantityMesh);
                this.quantityMesh = null;
                this.quantityTexture?.dispose();
                this.quantityTexture = null;
            }
            return;
        }

        this.quantityTexture?.dispose();
        this.quantityTexture = this.createQuantityTexture();

        if (!this.quantityMesh) {
            const material = new MeshBasicMaterial({
                map: this.quantityTexture,
                transparent: true,
                depthTest: false,
            });
            this.registerOpacityMaterial(material, 1);
            const geometry = new PlaneGeometry(this.width * 0.8, this.height * 0.8);
            this.quantityMesh = new Mesh(geometry, material);
            this.quantityMesh.renderOrder = 1001;
            this.quantityMesh.position.z = 0.2;
            this.add(this.quantityMesh);
        }
    }

    override isPointInBounds(worldPoint: Vector2): boolean {
        this.getWorldPosition(this.tmpWorldPos);
        const dx = Math.abs(worldPoint.x - this.tmpWorldPos.x);
        const dy = Math.abs(worldPoint.y - this.tmpWorldPos.y);
        return dx <= this.width / 2 && dy <= this.height / 2;
    }

    override tick(dt: number): void {
        super.tick(dt);
        if (!this.input) return;

        const isDown = this.input.isPointerDown;
        const pointerWorld = this.getPointerWorldPosition();
        if (!pointerWorld) return;

        if (!this.isPressed && isDown && this.isPointInBounds(pointerWorld) && this.enabled) {
            this.isPressed = true;
            this.select();
        } else if (this.isPressed && !isDown) {
            this.isPressed = false;
        }
    }

    /**
     * Select this slot (toggle selection)
     */
    select(): void {
        this.selected = !this.selected;
        this.updateSlotVisuals();
        this.input?.setButton(this.selectedAction, this.selected);
    }

    /**
     * Set quantity of items in slot
     */
    setQuantity(qty: number): void {
        this.quantity = Math.max(0, qty);
        this.updateQuantityDisplay();
    }

    private updateSlotVisuals(): void {
        if (this.selected) {
            this.slotMaterial.color.setStyle(this.selectionColor);
            if (this.borderMaterial) {
                this.borderMaterial.color.setStyle(this.selectionColor);
            }
        } else {
            this.slotMaterial.color.setStyle(this.backdropColor);
            if (this.borderMaterial) {
                this.borderMaterial.color.setStyle(this.borderColor);
            }
        }
    }

    static getPropertySchema(): PropertySchema {
        const baseSchema = UIControl2D.getPropertySchema();
        return {
            nodeType: 'InventorySlot2D',
            extends: 'UIControl2D',
            properties: [
                ...baseSchema.properties,
                {
                    name: 'width',
                    type: 'number',
                    ui: { label: 'Width', group: 'Slot', min: 20, max: 200, step: 1 },
                    getValue: (n) => (n as InventorySlot2D).width,
                    setValue: (n, v) => {
                        const slot = n as InventorySlot2D;
                        slot.width = Number(v);
                        slot.slotGeometry.dispose();
                        slot.slotGeometry = new PlaneGeometry(slot.width, slot.height);
                        slot.slotMesh.geometry = slot.slotGeometry;
                        if (slot.borderGeometry) {
                            slot.borderGeometry.dispose();
                            slot.borderGeometry = new PlaneGeometry(slot.width, slot.height);
                            if (slot.borderMesh) slot.borderMesh.geometry = slot.borderGeometry;
                        }
                    },
                },
                {
                    name: 'height',
                    type: 'number',
                    ui: { label: 'Height', group: 'Slot', min: 20, max: 200, step: 1 },
                    getValue: (n) => (n as InventorySlot2D).height,
                    setValue: (n, v) => {
                        const slot = n as InventorySlot2D;
                        slot.height = Number(v);
                        slot.slotGeometry.dispose();
                        slot.slotGeometry = new PlaneGeometry(slot.width, slot.height);
                        slot.slotMesh.geometry = slot.slotGeometry;
                        if (slot.borderGeometry) {
                            slot.borderGeometry.dispose();
                            slot.borderGeometry = new PlaneGeometry(slot.width, slot.height);
                            if (slot.borderMesh) slot.borderMesh.geometry = slot.borderGeometry;
                        }
                    },
                },
                {
                    name: 'quantity',
                    type: 'number',
                    ui: { label: 'Quantity', group: 'Slot', min: 0, step: 1 },
                    getValue: (n) => (n as InventorySlot2D).quantity,
                    setValue: (n, v) => { (n as InventorySlot2D).setQuantity(Number(v)); },
                },
                {
                    name: 'showQuantity',
                    type: 'boolean',
                    ui: { label: 'Show Quantity', group: 'Slot' },
                    getValue: (n) => (n as InventorySlot2D).showQuantity,
                    setValue: (n, v) => {
                        const slot = n as InventorySlot2D;
                        slot.showQuantity = Boolean(v);
                        slot.updateQuantityDisplay();
                    },
                },
                {
                    name: 'backdropColor',
                    type: 'string',
                    ui: { label: 'Backdrop Color', group: 'Slot' },
                    getValue: (n) => (n as InventorySlot2D).backdropColor,
                    setValue: (n, v) => {
                        const slot = n as InventorySlot2D;
                        slot.backdropColor = String(v);
                        if (!slot.selected) {
                            slot.slotMaterial.color.setStyle(slot.backdropColor);
                        }
                    },
                },
                {
                    name: 'borderColor',
                    type: 'string',
                    ui: { label: 'Border Color', group: 'Slot' },
                    getValue: (n) => (n as InventorySlot2D).borderColor,
                    setValue: (n, v) => {
                        const slot = n as InventorySlot2D;
                        slot.borderColor = String(v);
                        if (!slot.selected && slot.borderMaterial) {
                            slot.borderMaterial.color.setStyle(slot.borderColor);
                        }
                    },
                },
                {
                    name: 'selectionColor',
                    type: 'string',
                    ui: { label: 'Selection Color', group: 'Slot' },
                    getValue: (n) => (n as InventorySlot2D).selectionColor,
                    setValue: (n, v) => { (n as InventorySlot2D).selectionColor = String(v); },
                },
                {
                    name: 'selectedAction',
                    type: 'string',
                    ui: { label: 'Selection Action', group: 'Input', description: 'Virtual button name' },
                    getValue: (n) => (n as InventorySlot2D).selectedAction,
                    setValue: (n, v) => { (n as InventorySlot2D).selectedAction = String(v); },
                },
            ],
            groups: {
                ...baseSchema.groups,
                Slot: { label: 'Slot', expanded: true },
            },
        };
    }
}
