import {
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    Vector2,
} from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';

export interface Bar2DProps extends UIControl2DProps {
    width?: number;
    height?: number;
    backBackgroundColor?: string;
    barColor?: string;
    minValue?: number;
    maxValue?: number;
    value?: number;
    showBorder?: boolean;
    borderColor?: string;
    borderWidth?: number;
}

/**
 * A progress/status bar for 2D UI (HP, energy, progress, etc).
 * Visual only - no interaction. Value is typically set by scripts.
 */
export class Bar2D extends UIControl2D {
    width: number;
    height: number;
    backBackgroundColor: string;
    barColor: string;
    minValue: number;
    maxValue: number;
    value: number;
    showBorder: boolean;
    borderColor: string;
    borderWidth: number;

    private backgroundMesh: Mesh;
    private barMesh: Mesh;
    private borderMesh: Mesh | null = null;
    private backgroundMaterial: MeshBasicMaterial;
    private barMaterial: MeshBasicMaterial;
    private borderMaterial: MeshBasicMaterial | null = null;
    private backgroundGeometry: PlaneGeometry;
    private barGeometry: PlaneGeometry;
    private borderGeometry: PlaneGeometry | null = null;

    constructor(props: Bar2DProps) {
        super(props, 'Bar2D');

        this.width = props.width ?? 150;
        this.height = props.height ?? 20;
        this.backBackgroundColor = props.backBackgroundColor ?? '#333333';
        this.barColor = props.barColor ?? '#ff4444';
        this.minValue = props.minValue ?? 0;
        this.maxValue = props.maxValue ?? 100;
        this.value = Math.max(this.minValue, Math.min(this.maxValue, props.value ?? 100));
        this.showBorder = props.showBorder ?? true;
        this.borderColor = props.borderColor ?? '#000000';
        this.borderWidth = props.borderWidth ?? 2;

        // Create background
        this.backgroundGeometry = new PlaneGeometry(this.width, this.height);
        this.backgroundMaterial = new MeshBasicMaterial({
            color: this.backBackgroundColor,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
        });
        this.registerSkinMaterial(this.backgroundMaterial);
        this.backgroundMesh = new Mesh(this.backgroundGeometry, this.backgroundMaterial);
        this.backgroundMesh.renderOrder = 999;
        this.add(this.backgroundMesh);

        // Create bar (filled portion)
        this.barGeometry = new PlaneGeometry(0, this.height);
        this.barMaterial = new MeshBasicMaterial({
            color: this.barColor,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
        });
        this.registerOpacityMaterial(this.barMaterial, 1);
        this.barMesh = new Mesh(this.barGeometry, this.barMaterial);
        this.barMesh.renderOrder = 1000;
        this.barMesh.position.z = 0.1;
        this.add(this.barMesh);

        // Create border if enabled
        if (this.showBorder) {
            this.createBorder();
        }

        this.updateBarVisuals();
    }

    private createBorder(): void {
        // The border is a solid quad drawn BEHIND the background, expanded by
        // borderWidth on every side, so its outer edge peeks out as a frame while
        // the background/bar cover the interior. Drawing it on top (as before)
        // would paint a solid rect over the whole bar and hide the fill entirely.
        this.borderGeometry = this.buildBorderGeometry();
        this.borderMaterial = new MeshBasicMaterial({
            color: this.borderColor,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
            wireframe: false,
        });
        this.registerOpacityMaterial(this.borderMaterial, 1);
        this.borderMesh = new Mesh(this.borderGeometry, this.borderMaterial);
        this.borderMesh.renderOrder = 998;
        this.borderMesh.position.z = -0.1;
        this.add(this.borderMesh);
    }

    private buildBorderGeometry(): PlaneGeometry {
        return new PlaneGeometry(
            this.width + this.borderWidth * 2,
            this.height + this.borderWidth * 2,
        );
    }

    private rebuildBorderGeometry(): void {
        if (!this.borderMesh) return;
        this.borderGeometry?.dispose();
        this.borderGeometry = this.buildBorderGeometry();
        this.borderMesh.geometry = this.borderGeometry;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override isPointInBounds(_worldPoint: Vector2): boolean {
        // Bar is visual only, no interaction
        return false;
    }

    /**
     * Set the bar's value (clamped to min/max range)
     */
    setValue(newValue: number): void {
        const oldValue = this.value;
        this.value = Math.max(this.minValue, Math.min(this.maxValue, newValue));
        
        if (this.value !== oldValue) {
            this.updateBarVisuals();
        }
    }

    private updateBarVisuals(): void {
        const normalized = (this.value - this.minValue) / (this.maxValue - this.minValue);
        const filledWidth = Math.max(0, this.width * normalized);

        // Update bar geometry
        this.barGeometry.dispose();
        this.barGeometry = new PlaneGeometry(filledWidth, this.height);
        this.barMesh.geometry = this.barGeometry;

        // Position bar to fill from left
        this.barMesh.position.x = -this.width / 2 + filledWidth / 2;
    }

    static getPropertySchema(): PropertySchema {
        const baseSchema = UIControl2D.getPropertySchema();
        return {
            nodeType: 'Bar2D',
            extends: 'UIControl2D',
            properties: [
                ...baseSchema.properties,
                {
                    name: 'width',
                    type: 'number',
                    ui: { label: 'Width', group: 'Bar', min: 20, max: 500, step: 1 },
                    getValue: (n) => (n as Bar2D).width,
                    setValue: (n, v) => {
                        const bar = n as Bar2D;
                        bar.width = Number(v);
                        bar.backgroundGeometry.dispose();
                        bar.backgroundGeometry = new PlaneGeometry(bar.width, bar.height);
                        bar.backgroundMesh.geometry = bar.backgroundGeometry;
                        bar.rebuildBorderGeometry();
                        bar.updateBarVisuals();
                    },
                },
                {
                    name: 'height',
                    type: 'number',
                    ui: { label: 'Height', group: 'Bar', min: 5, max: 200, step: 1 },
                    getValue: (n) => (n as Bar2D).height,
                    setValue: (n, v) => {
                        const bar = n as Bar2D;
                        bar.height = Number(v);
                        bar.backgroundGeometry.dispose();
                        bar.backgroundGeometry = new PlaneGeometry(bar.width, bar.height);
                        bar.backgroundMesh.geometry = bar.backgroundGeometry;
                        bar.rebuildBorderGeometry();
                        bar.updateBarVisuals();
                    },
                },
                {
                    name: 'value',
                    type: 'number',
                    ui: { label: 'Value', group: 'Bar', step: 0.1 },
                    getValue: (n) => (n as Bar2D).value,
                    setValue: (n, v) => { (n as Bar2D).setValue(Number(v)); },
                },
                {
                    name: 'minValue',
                    type: 'number',
                    ui: { label: 'Min Value', group: 'Bar', step: 0.1 },
                    getValue: (n) => (n as Bar2D).minValue,
                    setValue: (n, v) => {
                        const bar = n as Bar2D;
                        bar.minValue = Number(v);
                        if (bar.value < bar.minValue) {
                            bar.setValue(bar.minValue);
                        }
                        bar.updateBarVisuals();
                    },
                },
                {
                    name: 'maxValue',
                    type: 'number',
                    ui: { label: 'Max Value', group: 'Bar', step: 0.1 },
                    getValue: (n) => (n as Bar2D).maxValue,
                    setValue: (n, v) => {
                        const bar = n as Bar2D;
                        bar.maxValue = Number(v);
                        if (bar.value > bar.maxValue) {
                            bar.setValue(bar.maxValue);
                        }
                        bar.updateBarVisuals();
                    },
                },
                {
                    name: 'backBackgroundColor',
                    type: 'string',
                    ui: { label: 'Background Color', group: 'Bar' },
                    getValue: (n) => (n as Bar2D).backBackgroundColor,
                    setValue: (n, v) => {
                        const bar = n as Bar2D;
                        bar.backBackgroundColor = String(v);
                        bar.backgroundMaterial.color.setStyle(bar.backBackgroundColor);
                    },
                },
                {
                    name: 'barColor',
                    type: 'string',
                    ui: { label: 'Bar Color', group: 'Bar' },
                    getValue: (n) => (n as Bar2D).barColor,
                    setValue: (n, v) => {
                        const bar = n as Bar2D;
                        bar.barColor = String(v);
                        bar.barMaterial.color.setStyle(bar.barColor);
                    },
                },
                {
                    name: 'showBorder',
                    type: 'boolean',
                    ui: { label: 'Show Border', group: 'Bar' },
                    getValue: (n) => (n as Bar2D).showBorder,
                    setValue: (n, v) => {
                        const bar = n as Bar2D;
                        bar.showBorder = Boolean(v);
                        if (bar.showBorder && !bar.borderMesh) {
                            bar.createBorder();
                        } else if (!bar.showBorder && bar.borderMesh) {
                            bar.remove(bar.borderMesh);
                            bar.borderGeometry?.dispose();
                            bar.borderMaterial?.dispose();
                            bar.borderMesh = null;
                            bar.borderGeometry = null;
                            bar.borderMaterial = null;
                        }
                    },
                },
                {
                    name: 'borderColor',
                    type: 'string',
                    ui: { label: 'Border Color', group: 'Bar' },
                    getValue: (n) => (n as Bar2D).borderColor,
                    setValue: (n, v) => {
                        const bar = n as Bar2D;
                        bar.borderColor = String(v);
                        if (bar.borderMaterial) {
                            bar.borderMaterial.color.setStyle(bar.borderColor);
                        }
                    },
                },
            ],
            groups: {
                ...baseSchema.groups,
                Bar: { label: 'Bar', expanded: true },
            },
        };
    }
}
