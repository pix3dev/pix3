/**
 * PlayerController — steers the avatar inside a bounded field.
 *
 * Two locomotion modes, chosen in the inspector:
 *  - `pointer` — the avatar chases the pointer/finger at `speed` px/s.
 *  - `keys`    — 8-direction WASD / arrow movement at `speed` px/s.
 *
 * The avatar is clamped to `boundsNode` (a Group2D — normally the node it is
 * parented to) inset by `radius`, so it can never leave the field.
 *
 * This file is deliberately the ONLY thing that decides how the avatar moves:
 * swap it wholesale for a grid stepper, a jumper or an auto-runner and the rest
 * of the recipe (spawners, touch rules, HUD, win/lose) keeps working unchanged.
 */
import { Group2D, Script, type PropertySchema } from '@pix3/runtime';

type LocomotionMode = 'pointer' | 'keys';

export class PlayerController extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // 'pointer' = follow the finger/mouse, 'keys' = 8-direction WASD/arrows.
      mode: 'pointer',
      // Movement speed in logical pixels per second.
      speed: 620,
      // Collision/inset radius: keeps the avatar fully inside the field.
      radius: 56,
      // Node id/name of the Group2D whose rect bounds the avatar.
      boundsNode: 'board',
      // Pointer mode only: stop chasing once this close (px) to avoid jitter.
      deadZone: 4,
    };
  }

  static getPropertySchema(): PropertySchema {
    const numberProp = (name: string, label: string, min: number, max: number, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Movement', min, max, step, slider: true },
      getValue: (s: unknown) => (s as PlayerController).config[name],
      setValue: (s: unknown, v: unknown) => {
        const n = Number(v);
        (s as PlayerController).config[name] = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
      },
    });

    return {
      nodeType: 'PlayerController',
      properties: [
        {
          name: 'mode',
          type: 'select',
          ui: {
            label: 'Mode',
            description: 'pointer = follow the finger, keys = 8-direction WASD/arrows',
            group: 'Movement',
            options: ['pointer', 'keys'],
          },
          getValue: s => (s as PlayerController).config.mode,
          setValue: (s, v) => {
            (s as PlayerController).config.mode = v === 'keys' ? 'keys' : 'pointer';
          },
        },
        numberProp('speed', 'Speed (px/s)', 60, 2000, 10),
        numberProp('radius', 'Radius', 4, 400, 1),
        numberProp('deadZone', 'Dead Zone', 0, 60, 1),
        {
          name: 'boundsNode',
          type: 'string',
          ui: { label: 'Bounds Node', group: 'Movement' },
          getValue: s => (s as PlayerController).config.boundsNode,
          setValue: (s, v) => {
            (s as PlayerController).config.boundsNode = typeof v === 'string' ? v : '';
          },
        },
      ],
      groups: { Movement: { label: 'Movement', expanded: true } },
    };
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node || dt <= 0) {
      return;
    }
    const speed = Math.max(0, Number(this.config.speed) || 0);
    const mode: LocomotionMode = this.config.mode === 'keys' ? 'keys' : 'pointer';

    if (mode === 'keys') {
      const ax = (this.held('Key_ArrowRight', 'Key_D') ? 1 : 0) - (this.held('Key_ArrowLeft', 'Key_A') ? 1 : 0);
      const ay = (this.held('Key_ArrowUp', 'Key_W') ? 1 : 0) - (this.held('Key_ArrowDown', 'Key_S') ? 1 : 0);
      const len = Math.hypot(ax, ay);
      if (len > 0) {
        node.position.x += (ax / len) * speed * dt;
        node.position.y += (ay / len) * speed * dt;
      }
    } else {
      const pointer = this.scene?.getPointer2DWorldPosition() ?? null;
      if (pointer) {
        const target = this.worldToParent(pointer.x, pointer.y);
        const dx = target.x - node.position.x;
        const dy = target.y - node.position.y;
        const dist = Math.hypot(dx, dy);
        const deadZone = Math.max(0, Number(this.config.deadZone) || 0);
        if (dist > deadZone) {
          const step = Math.min(dist, speed * dt);
          node.position.x += (dx / dist) * step;
          node.position.y += (dy / dist) * step;
        }
      }
    }

    this.clampToBounds();
  }

  private held(...buttons: string[]): boolean {
    return buttons.some(name => this.input?.getButton(name) ?? false);
  }

  /** Convert a 2D world point into the coordinate space of this node's parent. */
  private worldToParent(wx: number, wy: number): { x: number; y: number } {
    const parent = this.node?.parentNode ?? null;
    if (!parent) {
      return { x: wx, y: wy };
    }
    parent.updateWorldMatrix(true, false);
    const e = parent.matrixWorld.elements;
    const dx = wx - e[12];
    const dy = wy - e[13];
    const det = e[0] * e[5] - e[1] * e[4];
    if (Math.abs(det) < 1e-8) {
      return { x: dx, y: dy };
    }
    return { x: (e[5] * dx - e[4] * dy) / det, y: (e[0] * dy - e[1] * dx) / det };
  }

  /** Keep the avatar inside the bounds node's rect, inset by `radius`. */
  private clampToBounds(): void {
    const node = this.node;
    const bounds = this.findNode(String(this.config.boundsNode ?? ''));
    if (!node || !(bounds instanceof Group2D)) {
      return;
    }
    const radius = Math.max(0, Number(this.config.radius) || 0);
    const halfW = Math.max(0, bounds.width / 2 - radius);
    const halfH = Math.max(0, bounds.height / 2 - radius);
    node.position.x = Math.min(halfW, Math.max(-halfW, node.position.x));
    node.position.y = Math.min(halfH, Math.max(-halfH, node.position.y));
  }
}
