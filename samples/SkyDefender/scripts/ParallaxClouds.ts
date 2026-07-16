import { Script } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';

/**
 * ParallaxClouds — drifts every direct child of the owning node to the left
 * and wraps it around when it leaves the configured band, recreating the
 * multi-speed cloud panorama of the original Sky Defender (see design/original-data/sky.xml:
 * layer speeds 0.7 / 0.57 / 0.27 / 0.17 of the base wind speed).
 *
 * Attach one instance per cloud layer group; give farther layers a lower speed.
 */
export class ParallaxClouds extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // Horizontal drift speed in local units per second (design px of the owning layer).
      speed: 20,
      // Total width of the wrap band, centered on x = 0. A child leaving the left
      // edge (x < -wrapWidth / 2) re-enters from the right.
      wrapWidth: 2400,
      // Per-child speed variation (0..1). Child i moves at speed * (1 - jitter * phase(i))
      // so clouds inside one layer don't move in lockstep.
      jitter: 0.25,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'ParallaxClouds',
      properties: [
        {
          name: 'speed',
          type: 'number',
          ui: { label: 'Speed (px/s)', group: 'Parallax', step: 1 },
          getValue: (c: unknown) => (c as ParallaxClouds).config.speed,
          setValue: (c: unknown, v: unknown) => {
            (c as ParallaxClouds).config.speed = Number(v);
          },
        },
        {
          name: 'wrapWidth',
          type: 'number',
          ui: { label: 'Wrap Width', group: 'Parallax', min: 100, step: 10 },
          getValue: (c: unknown) => (c as ParallaxClouds).config.wrapWidth,
          setValue: (c: unknown, v: unknown) => {
            (c as ParallaxClouds).config.wrapWidth = Number(v);
          },
        },
        {
          name: 'jitter',
          type: 'number',
          ui: { label: 'Speed Jitter', group: 'Parallax', min: 0, max: 1, step: 0.05 },
          getValue: (c: unknown) => (c as ParallaxClouds).config.jitter,
          setValue: (c: unknown, v: unknown) => {
            (c as ParallaxClouds).config.jitter = Number(v);
          },
        },
      ],
      groups: {
        Parallax: { label: 'Parallax', expanded: true },
      },
    };
  }

  onUpdate(dt: number): void {
    if (!this.node) return;
    const speed = (this.config.speed as number) ?? 20;
    const wrapWidth = (this.config.wrapWidth as number) ?? 2400;
    const jitter = (this.config.jitter as number) ?? 0;
    const half = wrapWidth / 2;

    const children = this.node.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      // Deterministic per-child phase in [0..1) so the layer stays stable across runs.
      const phase = ((i * 37) % 100) / 100;
      const childSpeed = speed * (1 - jitter * phase);
      child.position.x -= childSpeed * dt;
      if (child.position.x < -half) {
        child.position.x += wrapWidth;
      }
    }
  }
}
