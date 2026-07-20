import { Script, UIControl2D, isShaderEffectHost } from '@pix3/runtime';
import type { NodeBase, PropertySchema, ShaderEffectStack } from '@pix3/runtime';

/**
 * HoverBrightness — dims a UIControl2D (Button2D) with a `core:adjust` shader
 * effect and smoothly restores it to full brightness while hovered.
 *
 * Replaces the old two-texture hover swap (campaign_dark.png → campaign.png):
 * the node keeps ONE bright texture and this script drives the brightness param
 * of an attached `core:adjust` effect — dimmed at rest, animated up on hover.
 * The approach is a frame-rate-independent exponential ease
 * (`current += (target - current) * min(1, fadeSpeed * dt)`).
 */
export class HoverBrightness extends Script {
  private control: UIControl2D | null = null;
  private stack: ShaderEffectStack | null = null;

  private dim = 0.65;
  private hover = 1;
  private speed = 10;

  private current = 0.65;
  private target = 0.65;
  private settled = false;

  /** Saved host callbacks so we chain instead of clobbering, restored on detach. */
  private prevHoverEnter?: () => void;
  private prevHoverExit?: () => void;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      dimBrightness: 0.65,
      hoverBrightness: 1,
      fadeSpeed: 10,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'HoverBrightness',
      properties: [
        {
          name: 'dimBrightness',
          type: 'number',
          ui: { label: 'Dim Brightness', group: 'Hover Brightness', step: 0.05 },
          getValue: (c: unknown) => (c as HoverBrightness).config.dimBrightness,
          setValue: (c: unknown, v: unknown) => {
            (c as HoverBrightness).config.dimBrightness = Number(v);
          },
        },
        {
          name: 'hoverBrightness',
          type: 'number',
          ui: { label: 'Hover Brightness', group: 'Hover Brightness', step: 0.05 },
          getValue: (c: unknown) => (c as HoverBrightness).config.hoverBrightness,
          setValue: (c: unknown, v: unknown) => {
            (c as HoverBrightness).config.hoverBrightness = Number(v);
          },
        },
        {
          name: 'fadeSpeed',
          type: 'number',
          ui: { label: 'Fade Speed', group: 'Hover Brightness', step: 1 },
          getValue: (c: unknown) => (c as HoverBrightness).config.fadeSpeed,
          setValue: (c: unknown, v: unknown) => {
            (c as HoverBrightness).config.fadeSpeed = Number(v);
          },
        },
      ],
      groups: { 'Hover Brightness': { label: 'Hover Brightness', expanded: true } },
    };
  }

  onStart(): void {
    const node: NodeBase | null = this.node;
    if (!(node instanceof UIControl2D) || !isShaderEffectHost(node)) {
      console.warn('[HoverBrightness] requires a UIControl2D shader-effect host (e.g. Button2D)');
      return;
    }

    this.dim = Number(this.config.dimBrightness) || 0.65;
    this.hover = Number(this.config.hoverBrightness);
    if (!Number.isFinite(this.hover)) this.hover = 1;
    this.speed = Number(this.config.fadeSpeed) || 10;

    this.control = node;
    this.stack = node.getShaderEffectStack();

    // Attach the effect only if the node doesn't already carry one (the scene
    // YAML may declare it up front — don't stack a duplicate).
    if (!this.stack.get('adjust')) {
      this.stack.attach('core:adjust', { params: { brightness: this.dim } });
    }

    this.current = this.dim;
    this.target = this.dim;
    this.settled = false;

    // Chain onto any pre-existing hover callbacks rather than replacing them.
    this.prevHoverEnter = node.onHoverEnter;
    this.prevHoverExit = node.onHoverExit;
    node.onHoverEnter = () => {
      this.prevHoverEnter?.();
      this.target = this.hover;
    };
    node.onHoverExit = () => {
      this.prevHoverExit?.();
      this.target = this.dim;
    };
  }

  onUpdate(dt: number): void {
    const control = this.control;
    const stack = this.stack;
    if (!control || !stack) return;

    // A disabled control should never look "lit".
    if (!control.enabled) this.target = this.dim;

    const diff = this.target - this.current;
    if (Math.abs(diff) < 1e-3) {
      if (this.settled) return; // already applied the resting value
      this.current = this.target;
      stack.setParam('adjust', 'brightness', this.current);
      this.settled = true;
      return;
    }

    this.settled = false;
    this.current += diff * Math.min(1, this.speed * dt);
    stack.setParam('adjust', 'brightness', this.current);
  }

  onDetach(): void {
    // Restore whatever hover callbacks were in place before we chained ours.
    if (this.control) {
      this.control.onHoverEnter = this.prevHoverEnter;
      this.control.onHoverExit = this.prevHoverExit;
    }
    this.control = null;
    this.stack = null;
    super.onDetach();
  }
}
