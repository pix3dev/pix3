/**
 * PaddleController — the only thing the player directly drives.
 *
 * Slides the paddle along its local X axis, clamped to `boundsNode`, either by
 * following the pointer or with the arrow/A-D keys. `BallBody` re-reads the
 * paddle's world transform every frame, so anything this script does to the
 * node — including rotating it — is picked up by the physics for free.
 *
 * This is the blessed swap point for flippers: keep the file's job ("turn input
 * into paddle transforms") and change what a paddle IS. See design/recipe.md.
 */
import { Group2D, Script, type PropertySchema } from '@pix3/runtime';

export class PaddleController extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // 'pointer' = follow the finger/mouse, 'keys' = arrows / A-D.
      mode: 'pointer',
      speed: 1600,
      // Half the paddle's width — keeps it inside the field.
      halfWidth: 130,
      boundsNode: 'board',
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, min: number, max: number, step: number) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Paddle', min, max, step, slider: true },
      getValue: (s: unknown) => (s as PaddleController).config[name],
      setValue: (s: unknown, v: unknown) => {
        const n = Number(v);
        (s as PaddleController).config[name] = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
      },
    });

    return {
      nodeType: 'PaddleController',
      properties: [
        {
          name: 'mode',
          type: 'select',
          ui: { label: 'Mode', group: 'Paddle', options: ['pointer', 'keys'] },
          getValue: s => (s as PaddleController).config.mode,
          setValue: (s, v) => {
            (s as PaddleController).config.mode = v === 'keys' ? 'keys' : 'pointer';
          },
        },
        num('speed', 'Speed (px/s)', 100, 6000, 25),
        num('halfWidth', 'Half Width', 10, 800, 5),
        {
          name: 'boundsNode',
          type: 'string',
          ui: { label: 'Bounds Node', group: 'Paddle' },
          getValue: s => (s as PaddleController).config.boundsNode,
          setValue: (s, v) => {
            (s as PaddleController).config.boundsNode = typeof v === 'string' ? v : '';
          },
        },
      ],
      groups: { Paddle: { label: 'Paddle', expanded: true } },
    };
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node || dt <= 0) {
      return;
    }
    const speed = Math.max(0, Number(this.config.speed) || 0);

    if (this.config.mode === 'keys') {
      const dir =
        (this.held('Key_ArrowRight', 'Key_D') ? 1 : 0) - (this.held('Key_ArrowLeft', 'Key_A') ? 1 : 0);
      node.position.x += dir * speed * dt;
    } else {
      const pointer = this.scene?.getPointer2DWorldPosition() ?? null;
      if (pointer) {
        const target = this.worldToParentX(pointer.x, pointer.y);
        const delta = target - node.position.x;
        const step = Math.min(Math.abs(delta), speed * dt);
        node.position.x += Math.sign(delta) * step;
      }
    }

    const bounds = this.findNode(String(this.config.boundsNode ?? ''));
    if (bounds instanceof Group2D) {
      const limit = Math.max(0, bounds.width / 2 - Math.max(0, Number(this.config.halfWidth) || 0));
      node.position.x = Math.min(limit, Math.max(-limit, node.position.x));
    }
  }

  private held(...buttons: string[]): boolean {
    return buttons.some(name => this.input?.getButton(name) ?? false);
  }

  /** World X → the X of this node's parent space (exact 2×2 inverse). */
  private worldToParentX(wx: number, wy: number): number {
    const parent = this.node?.parentNode ?? null;
    if (!parent) {
      return wx;
    }
    parent.updateWorldMatrix(true, false);
    const e = parent.matrixWorld.elements;
    const dx = wx - e[12];
    const dy = wy - e[13];
    const det = e[0] * e[5] - e[1] * e[4];
    return Math.abs(det) < 1e-8 ? dx : (e[5] * dx - e[4] * dy) / det;
  }
}
