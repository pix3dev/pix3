/**
 * HoverScale — smoothly scales this 2D node up while the pointer hovers over
 * it, and back down when it leaves. Meant for Button2D (and similar) UI nodes.
 */
import { Script, type PropertySchema } from '@pix3/runtime';

export class HoverScale extends Script {
  private baseScaleX = 1;
  private baseScaleY = 1;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      hoverScale: 1.08,
      speed: 14,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'HoverScale',
      properties: [
        {
          name: 'hoverScale',
          type: 'number',
          ui: { label: 'Hover Scale', description: 'Scale multiplier while hovered', group: 'Hover', min: 1, step: 0.01, precision: 2 },
          getValue: s => (s as HoverScale).config.hoverScale,
          setValue: (s, v) => { (s as HoverScale).config.hoverScale = Number(v); },
        },
        {
          name: 'speed',
          type: 'number',
          ui: { label: 'Speed', description: 'Lerp speed (higher = snappier)', group: 'Hover', min: 1, step: 1, precision: 1 },
          getValue: s => (s as HoverScale).config.speed,
          setValue: (s, v) => { (s as HoverScale).config.speed = Number(v); },
        },
      ],
      groups: { Hover: { label: 'Hover', expanded: true } },
    };
  }

  onStart(): void {
    if (this.node) {
      this.baseScaleX = this.node.scale.x ?? 1;
      this.baseScaleY = this.node.scale.y ?? 1;
    }
  }

  onUpdate(dt: number): void {
    if (!this.node || !this.input) return;

    const anyNode = this.node as any;
    const hovered: boolean = anyNode.isHovering === true;

    const hoverScale = Number(this.config.hoverScale) || 1.08;
    const speed = Number(this.config.speed) || 14;
    const targetX = hovered ? this.baseScaleX * hoverScale : this.baseScaleX;
    const targetY = hovered ? this.baseScaleY * hoverScale : this.baseScaleY;
    const k = 1 - Math.exp(-speed * dt);

    this.node.scale.x += (targetX - this.node.scale.x) * k;
    this.node.scale.y += (targetY - this.node.scale.y) * k;
  }
}
