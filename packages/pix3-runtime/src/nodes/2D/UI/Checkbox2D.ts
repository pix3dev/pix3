import {
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    Vector2,
} from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';

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
    }

    /** Horizontal gap between the box's right edge and the label plane. */
    private static readonly LABEL_GAP = 6;

    protected override updateLabel(): void {
        super.updateLabel();
        if (!this.labelMesh) return;
        // Position the label to the right of the box, vertically centered —
        // instead of the base class's centered-on-control placement, which would
        // draw the text on top of the box.
        this.labelMesh.position.x =
            this.size / 2 + this.labelMesh.scale.x / 2 + Checkbox2D.LABEL_GAP;
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

    override tick(dt: number): void {
        super.tick(dt);
        if (!this.input) return;

        const isDown = this.input.isPointerDown;
        const pointerWorld = this.getPointerWorldPosition();
        if (!pointerWorld) return;

        if (!this.isPressed && isDown && this.isPointInBounds(pointerWorld) && this.enabled) {
            this.isPressed = true;
            this.toggle();
        } else if (this.isPressed && !isDown) {
            this.isPressed = false;
        }
    }

    /**
     * Toggle the checkbox state
     */
    toggle(): void {
        this.checked = !this.checked;
        this.updateCheckboxVisuals();
        const buttonState = this.checked ? 1 : 0;
        this.input?.setButton(this.checkmarkAction, true);
        this.input?.setAxis(this.checkmarkAction, buttonState);
        // Release button after a frame
        setTimeout(() => {
            this.input?.setButton(this.checkmarkAction, false);
        }, 0);
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
                    getValue: (n) => (n as Checkbox2D).size,
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
                    getValue: (n) => (n as Checkbox2D).checked,
                    setValue: (n, v) => {
                        const cb = n as Checkbox2D;
                        const newState = Boolean(v);
                        if (cb.checked !== newState) {
                            cb.checked = newState;
                            cb.updateCheckboxVisuals();
                        }
                    },
                },
                {
                    name: 'uncheckedColor',
                    type: 'string',
                    ui: { label: 'Unchecked Color', group: 'Checkbox' },
                    getValue: (n) => (n as Checkbox2D).uncheckedColor,
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
                    type: 'string',
                    ui: { label: 'Checked Color', group: 'Checkbox' },
                    getValue: (n) => (n as Checkbox2D).checkedColor,
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
                    type: 'string',
                    ui: { label: 'Checkmark Color', group: 'Checkbox' },
                    getValue: (n) => (n as Checkbox2D).checkmarkColor,
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
                    getValue: (n) => (n as Checkbox2D).checkmarkAction,
                    setValue: (n, v) => { (n as Checkbox2D).checkmarkAction = String(v); },
                },
            ],
            groups: {
                ...baseSchema.groups,
                Checkbox: { label: 'Checkbox', expanded: true },
            },
        };
    }
}
