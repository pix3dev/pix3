import { Vector2 } from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';

export interface Label2DProps extends UIControl2DProps {
}

/**
 * A simple text label control for 2D UI.
 */
export class Label2D extends UIControl2D {
    constructor(props: Label2DProps) {
        super(props, 'Label2D');
        
        // Initial label update
        this.updateLabel();
    }

    override tick(dt: number): void {
        super.tick(dt);
        if (!this.input) return;

        const isDown = this.input.isPointerDown;
        const pointerWorld = this.getPointerWorldPosition();
        if (!pointerWorld) return;

        // Still update pointer state for hover registry/blocking joystick
        this.updatePointerState(pointerWorld.x, pointerWorld.y, isDown);
    }

    override isPointInBounds(worldPoint: Vector2): boolean {
        if (!this.labelMesh) return false;
        
        this.getWorldPosition(this.tmpWorldPos);
        const texture = this.labelTexture;
        if (!texture) return false;

        const canvas = texture.image as HTMLCanvasElement;
        const userData = (texture.userData ?? {}) as {
            logicalWidth?: number;
            logicalHeight?: number;
            dpr?: number;
        };
        const dpr = userData.dpr ?? 1;
        const width = userData.logicalWidth ?? (canvas.width / dpr);
        const height = userData.logicalHeight ?? (canvas.height / dpr);

        const dx = Math.abs(worldPoint.x - this.tmpWorldPos.x);
        const dy = Math.abs(worldPoint.y - this.tmpWorldPos.y);
        
        return dx <= width / 2 && dy <= height / 2;
    }

    static getPropertySchema(): PropertySchema {
        const baseSchema = UIControl2D.getPropertySchema();
        return {
            nodeType: 'Label2D',
            extends: 'UIControl2D',
            properties: [
                ...baseSchema.properties,
            ],
        };
    }
}
