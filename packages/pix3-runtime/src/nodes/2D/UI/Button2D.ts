import {
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    Vector2,
} from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';

export interface Button2DProps extends UIControl2DProps {
    width?: number;
    height?: number;
    backgroundColor?: string;
    hoverColor?: string;
    pressedColor?: string;
    buttonAction?: string;
}

/**
 * A clickable button control for 2D UI.
 * Emits virtual button presses and supports click callbacks.
 */
export class Button2D extends UIControl2D {
    width: number;
    height: number;
    backgroundColor: string;
    hoverColor: string;
    pressedColor: string;
    buttonAction: string;

    private buttonMesh: Mesh;
    private buttonMaterial: MeshBasicMaterial;
    private geometry: PlaneGeometry;

    constructor(props: Button2DProps) {
        super(props, 'Button2D');

        this.width = props.width ?? 100;
        this.height = props.height ?? 40;
        this.backgroundColor = props.backgroundColor ?? '#4a4a4a';
        this.hoverColor = props.hoverColor ?? '#5a5a5a';
        this.pressedColor = props.pressedColor ?? '#3a3a3a';
        this.buttonAction = props.buttonAction ?? 'Submit';

        // Create button mesh
        this.geometry = new PlaneGeometry(this.width, this.height);
        this.buttonMaterial = new MeshBasicMaterial({
            color: this.backgroundColor,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
        });
        this.registerSkinMaterial(this.buttonMaterial);
        this.buttonMesh = new Mesh(this.geometry, this.buttonMaterial);
        this.buttonMesh.renderOrder = 999;
        this.add(this.buttonMesh);
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

        this.updatePointerState(pointerWorld.x, pointerWorld.y, isDown);
    }

    protected override onPress(isPressed: boolean): void {
        if (isPressed) {
            this.buttonMaterial.color.setStyle(this.pressedColor);
            this.input?.setButton(this.buttonAction, true);
        } else {
            const targetColor = this.isHovering ? this.hoverColor : this.backgroundColor;
            this.buttonMaterial.color.setStyle(targetColor);
            this.input?.setButton(this.buttonAction, false);
        }
    }

    protected override onHover(isHovering: boolean): void {
        if (!this.isPressed) {
            const targetColor = isHovering ? this.hoverColor : this.backgroundColor;
            this.buttonMaterial.color.setStyle(targetColor);
        }
    }

    static getPropertySchema(): PropertySchema {
        const baseSchema = UIControl2D.getPropertySchema();
        return {
            nodeType: 'Button2D',
            extends: 'UIControl2D',
            properties: [
                ...baseSchema.properties,
                {
                    name: 'width',
                    type: 'number',
                    ui: { label: 'Width', group: 'Button', min: 10, max: 500, step: 1 },
                    getValue: (n) => (n as Button2D).width,
                    setValue: (n, v) => {
                        const btn = n as Button2D;
                        btn.width = Number(v);
                        btn.geometry.dispose();
                        btn.geometry = new PlaneGeometry(btn.width, btn.height);
                        btn.buttonMesh.geometry = btn.geometry;
                    },
                },
                {
                    name: 'height',
                    type: 'number',
                    ui: { label: 'Height', group: 'Button', min: 10, max: 500, step: 1 },
                    getValue: (n) => (n as Button2D).height,
                    setValue: (n, v) => {
                        const btn = n as Button2D;
                        btn.height = Number(v);
                        btn.geometry.dispose();
                        btn.geometry = new PlaneGeometry(btn.width, btn.height);
                        btn.buttonMesh.geometry = btn.geometry;
                    },
                },
                {
                    name: 'backgroundColor',
                    type: 'string',
                    ui: { label: 'Color', group: 'Button' },
                    getValue: (n) => (n as Button2D).backgroundColor,
                    setValue: (n, v) => {
                        const btn = n as Button2D;
                        btn.backgroundColor = String(v);
                        if (!btn.isPressed && !btn.isHovering) {
                            btn.buttonMaterial.color.setStyle(btn.backgroundColor);
                        }
                    },
                },
                {
                    name: 'hoverColor',
                    type: 'string',
                    ui: { label: 'Hover Color', group: 'Button' },
                    getValue: (n) => (n as Button2D).hoverColor,
                    setValue: (n, v) => { (n as Button2D).hoverColor = String(v); },
                },
                {
                    name: 'pressedColor',
                    type: 'string',
                    ui: { label: 'Pressed Color', group: 'Button' },
                    getValue: (n) => (n as Button2D).pressedColor,
                    setValue: (n, v) => { (n as Button2D).pressedColor = String(v); },
                },
                {
                    name: 'buttonAction',
                    type: 'string',
                    ui: { label: 'Button Action', group: 'Input', description: 'Virtual button name' },
                    getValue: (n) => (n as Button2D).buttonAction,
                    setValue: (n, v) => { (n as Button2D).buttonAction = String(v); },
                },
            ],
            groups: {
                ...baseSchema.groups,
                Button: { label: 'Button', expanded: true },
            },
        };
    }
}
