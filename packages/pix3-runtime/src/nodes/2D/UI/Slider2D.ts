import {
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    Vector2,
} from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';

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
    private isDragging: boolean = false;
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

        const pointerWorldX = pointerWorld.x;

        if (!this.isPressed && isDown && this.isPointInBounds(pointerWorld) && this.enabled) {
            this.isDragging = true;
            this.isPressed = true;
            this.updateSliderFromPointer(pointerWorldX);
        } else if (this.isDragging && !isDown) {
            this.isDragging = false;
            this.isPressed = false;
        }

        if (this.isDragging) {
            this.updateSliderFromPointer(pointerWorldX);
        }
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
                    getValue: (n) => (n as Slider2D).width,
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
                    getValue: (n) => (n as Slider2D).height,
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
                    getValue: (n) => (n as Slider2D).handleSize,
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
                    getValue: (n) => (n as Slider2D).value,
                    setValue: (n, v) => { (n as Slider2D).setValue(Number(v)); },
                },
                {
                    name: 'minValue',
                    type: 'number',
                    ui: { label: 'Min Value', group: 'Slider', step: 0.1 },
                    getValue: (n) => (n as Slider2D).minValue,
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
                    getValue: (n) => (n as Slider2D).maxValue,
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
                    type: 'string',
                    ui: { label: 'Background Color', group: 'Slider' },
                    getValue: (n) => (n as Slider2D).trackBackgroundColor,
                    setValue: (n, v) => {
                        const slider = n as Slider2D;
                        slider.trackBackgroundColor = String(v);
                        slider.trackMaterial.color.setStyle(slider.trackBackgroundColor);
                    },
                },
                {
                    name: 'trackFilledColor',
                    type: 'string',
                    ui: { label: 'Filled Color', group: 'Slider' },
                    getValue: (n) => (n as Slider2D).trackFilledColor,
                    setValue: (n, v) => {
                        const slider = n as Slider2D;
                        slider.trackFilledColor = String(v);
                        slider.filledTrackMaterial.color.setStyle(slider.trackFilledColor);
                    },
                },
                {
                    name: 'handleColor',
                    type: 'string',
                    ui: { label: 'Handle Color', group: 'Slider' },
                    getValue: (n) => (n as Slider2D).handleColor,
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
                    getValue: (n) => (n as Slider2D).axisName,
                    setValue: (n, v) => { (n as Slider2D).axisName = String(v); },
                },
            ],
            groups: {
                ...baseSchema.groups,
                Slider: { label: 'Slider', expanded: true },
            },
        };
    }
}
