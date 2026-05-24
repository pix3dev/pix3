import {
    Mesh,
    MeshBasicMaterial,
    CircleGeometry,
    Vector2,
    Vector3,
} from 'three';
import { Node2D, type Node2DProps } from '../../Node2D';
import type { PropertySchema } from '../../../fw/property-schema';

export interface Joystick2DProps extends Node2DProps {
    radius?: number;
    handleRadius?: number;
    axisHorizontal?: string;
    axisVertical?: string;
    baseColor?: string;
    handleColor?: string;
    floating?: boolean;
}

export class Joystick2D extends Node2D {
    private static readonly BASE_OPACITY = 0.3;
    private static readonly HANDLE_OPACITY = 0.8;
    private static readonly FADE_SPEED = 6;

    radius: number;
    handleRadius: number;
    axisHorizontal: string;
    axisVertical: string;
    baseColor: string;
    handleColor: string;
    floating: boolean;

    private baseMesh: Mesh;
    private handleMesh: Mesh;
    private baseMaterial: MeshBasicMaterial;
    private handleMaterial: MeshBasicMaterial;

    // State
    private isDragging: boolean = false;
    private inputVector = new Vector2();
    private authoredLocalPosition = new Vector3();
    private dragCenterWorld = new Vector2();
    private visibilityAlpha = 1;
    private visibilityTarget = 1;
    private tmpWorldPos = new Vector3();
    private pendingResetAfterHide = false;

    constructor(props: Joystick2DProps) {
        super(props, 'Joystick2D');

        this.radius = props.radius ?? 50;
        this.handleRadius = props.handleRadius ?? 20;
        this.axisHorizontal = props.axisHorizontal ?? 'Horizontal';
        this.axisVertical = props.axisVertical ?? 'Vertical';
        this.baseColor = props.baseColor ?? '#ffffff';
        this.handleColor = props.handleColor ?? '#cccccc';
        this.floating = props.floating ?? false;

        // Create Visuals
        const baseGeo = new CircleGeometry(this.radius, 32);
        this.baseMaterial = new MeshBasicMaterial({
            color: this.baseColor,
            transparent: true,
            opacity: Joystick2D.BASE_OPACITY,
            depthTest: false,
        });
        this.registerOpacityMaterial(this.baseMaterial, Joystick2D.BASE_OPACITY);
        this.baseMesh = new Mesh(baseGeo, this.baseMaterial);
        this.baseMesh.renderOrder = 999;
        this.add(this.baseMesh);

        const handleGeo = new CircleGeometry(this.handleRadius, 32);
        this.handleMaterial = new MeshBasicMaterial({
            color: this.handleColor,
            transparent: true,
            opacity: Joystick2D.HANDLE_OPACITY,
            depthTest: false,
        });
        this.registerOpacityMaterial(this.handleMaterial, Joystick2D.HANDLE_OPACITY);
        this.handleMesh = new Mesh(handleGeo, this.handleMaterial);
        // Render handle on top of base
        this.handleMesh.position.z = 1;
        this.handleMesh.renderOrder = 1000;
        this.add(this.handleMesh);

        this.authoredLocalPosition.copy(this.position);

        if (this.floating) {
            this.visibilityAlpha = 0;
            this.visibilityTarget = 0;
            this.applyVisibility();
        }
    }

    override tick(dt: number): void {
        super.tick(dt);
        if (!this.input) return;

        if (!this.input.width) {
            // console.warn('[Joystick2D] InputService width is 0');
            return;
        }

        const isDown = this.input.isPointerDown;
        const pointerWorld = this.getPointerWorldPosition();
        if (!pointerWorld) return;

        const pointerWorldX = pointerWorld.x;
        const pointerWorldY = pointerWorld.y;

        if (this.floating) {
            if (!this.isDragging && isDown && !this.input.isHoveringUI) {
                this.isDragging = true;
                this.pendingResetAfterHide = false;
                this.handleMesh.position.set(0, 0, this.handleMesh.position.z);
                this.dragCenterWorld.set(pointerWorldX, pointerWorldY);
                this.setCenterFromWorld(this.dragCenterWorld.x, this.dragCenterWorld.y);
                this.visibilityTarget = 1;
            }

            if (this.isDragging && !isDown) {
                this.endDrag();
            }

            if (this.isDragging) {
                this.updateHandleAndAxes(pointerWorldX - this.dragCenterWorld.x, pointerWorldY - this.dragCenterWorld.y);
            }

            this.updateVisibility(dt);
            return;
        }

        this.getWorldPosition(this.tmpWorldPos);

        const dx = pointerWorldX - this.tmpWorldPos.x;
        const dy = pointerWorldY - this.tmpWorldPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (this.isDragging) {
            if (!isDown) {
                this.endDrag();
            } else {
                this.updateHandleAndAxes(dx, dy);
            }
        } else if (isDown && dist < this.radius) {
            this.isDragging = true;
        }
    }

    private updateHandleAndAxes(dx: number, dy: number): void {
        const angle = Math.atan2(dy, dx);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const clampDist = Math.min(dist, this.radius);

        const stickX = Math.cos(angle) * clampDist;
        const stickY = Math.sin(angle) * clampDist;

        this.handleMesh.position.x = stickX;
        this.handleMesh.position.y = stickY;

        this.inputVector.set(stickX / this.radius, stickY / this.radius);

        this.input?.setAxis(this.axisHorizontal, this.inputVector.x);
        this.input?.setAxis(this.axisVertical, this.inputVector.y);
    }

    private endDrag(): void {
        this.isDragging = false;
        this.inputVector.set(0, 0);
        this.input?.setAxis(this.axisHorizontal, 0);
        this.input?.setAxis(this.axisVertical, 0);

        if (this.floating) {
            this.visibilityTarget = 0;
            this.pendingResetAfterHide = true;
            return;
        }

        this.handleMesh.position.x = 0;
        this.handleMesh.position.y = 0;
    }

    private updateVisibility(dt: number): void {
        const delta = this.visibilityTarget - this.visibilityAlpha;
        if (Math.abs(delta) <= Number.EPSILON) {
            this.visibilityAlpha = this.visibilityTarget;
            this.applyVisibility();
            return;
        }

        const safeDt = Math.min(dt, 1 / 30);
        const step = Joystick2D.FADE_SPEED * safeDt;
        if (Math.abs(delta) <= step) {
            this.visibilityAlpha = this.visibilityTarget;
        } else {
            this.visibilityAlpha += Math.sign(delta) * step;
        }

        this.applyVisibility();

        if (this.visibilityAlpha === 0 && this.pendingResetAfterHide) {
            this.pendingResetAfterHide = false;
            this.position.copy(this.authoredLocalPosition);
            this.handleMesh.position.x = 0;
            this.handleMesh.position.y = 0;
        }
    }

    private applyVisibility(): void {
        this.setOpacityMaterialBase(this.baseMaterial, Joystick2D.BASE_OPACITY * this.visibilityAlpha);
        this.setOpacityMaterialBase(this.handleMaterial, Joystick2D.HANDLE_OPACITY * this.visibilityAlpha);
    }

    private setCenterFromWorld(worldX: number, worldY: number): void {
        this.position.set(worldX, worldY, this.position.z);
        this.dragCenterWorld.set(worldX, worldY);
    }

    static getPropertySchema(): PropertySchema {
        const baseSchema = Node2D.getPropertySchema();
        return {
            nodeType: 'Joystick2D',
            extends: 'Node2D',
            properties: [
                ...baseSchema.properties,
                {
                    name: 'radius',
                    type: 'number',
                    ui: { label: 'Radius', group: 'Joystick' },
                    getValue: (n) => (n as Joystick2D).radius,
                    setValue: (n, v) => { (n as Joystick2D).radius = Number(v); },
                },
                {
                    name: 'floating',
                    type: 'boolean',
                    ui: { label: 'Floating Position', group: 'Joystick' },
                    getValue: (n) => (n as Joystick2D).floating,
                    setValue: (n, v) => {
                        const joystick = n as Joystick2D;
                        joystick.floating = Boolean(v);
                        if (joystick.floating) {
                            joystick.endDrag();
                            joystick.visibilityAlpha = 0;
                            joystick.visibilityTarget = 0;
                            joystick.pendingResetAfterHide = false;
                            joystick.position.copy(joystick.authoredLocalPosition);
                            joystick.handleMesh.position.set(0, 0, joystick.handleMesh.position.z);
                        } else {
                            joystick.pendingResetAfterHide = false;
                            joystick.position.copy(joystick.authoredLocalPosition);
                            joystick.handleMesh.position.set(0, 0, joystick.handleMesh.position.z);
                            joystick.visibilityAlpha = 1;
                            joystick.visibilityTarget = 1;
                        }
                        joystick.applyVisibility();
                    },
                },
                {
                    name: 'axisHorizontal',
                    type: 'string',
                    ui: { label: 'Horz Axis', group: 'Input' },
                    getValue: (n) => (n as Joystick2D).axisHorizontal,
                    setValue: (n, v) => { (n as Joystick2D).axisHorizontal = String(v); },
                },
                {
                    name: 'axisVertical',
                    type: 'string',
                    ui: { label: 'Vert Axis', group: 'Input' },
                    getValue: (n) => (n as Joystick2D).axisVertical,
                    setValue: (n, v) => { (n as Joystick2D).axisVertical = String(v); },
                },
            ],
            groups: {
                ...baseSchema.groups,
                Joystick: { label: 'Joystick', expanded: true },
                Input: { label: 'Input Mapping', expanded: true },
            },
        };
    }
}
