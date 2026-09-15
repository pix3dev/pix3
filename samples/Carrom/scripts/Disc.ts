import { NodeBase, Script } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';

import {
  CONTACT_SFX_MIN_SPEED,
  clamp,
  velocitySampleOn,
  type DiscKind,
  type DiscVelocitySample,
} from './carrom-geometry';

/**
 * `user:Disc` — the tag every playing piece carries, plus its contact sound.
 *
 * It exists for two reasons the rules cannot do without:
 *
 * 1. **Identity.** The controller has to know what a node IS (white man, black
 *    man, Queen, striker) to score it, and reading that from the node name
 *    would break the moment a prefab instance is renamed.
 * 2. **Impact speed.** `contact-started` carries only the other node — no point,
 *    normal or impulse — and the signal is flushed AFTER the solver has already
 *    changed both velocities. So each disc publishes its PREVIOUS frame's
 *    velocity ({@link lastSpeedX} / {@link lastSpeedY}) and a contact estimates
 *    its strength from the pair.
 */
export class Disc extends Script {
  /** Previous frame's velocity, read by the other side of a contact. */
  lastSpeedX = 0;
  lastSpeedY = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = { kind: 'white' };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'Disc',
      properties: [
        {
          name: 'kind',
          type: 'select',
          ui: {
            label: 'Kind',
            group: 'Disc',
            description: 'What this piece counts as for the rules and for its pocket sound.',
            options: ['white', 'black', 'queen', 'striker'],
          },
          getValue: (c: unknown) => (c as Disc).config.kind,
          setValue: (c: unknown, v: unknown) => {
            const value = String(v);
            (c as Disc).config.kind = (['white', 'black', 'queen', 'striker'] as string[]).includes(
              value
            )
              ? value
              : 'white';
          },
        },
      ],
      groups: { Disc: { label: 'Disc', expanded: true } },
    };
  }

  /** What this piece counts as. */
  get kind(): DiscKind {
    const value = this.config.kind;
    if (value === 'white' || value === 'black' || value === 'queen' || value === 'striker') {
      return value;
    }
    return 'white';
  }

  onStart(): void {
    this.node?.connect('contact-started', this, this.handleContact);
  }

  onUpdate(): void {
    const body = this.node ? (this.scene?.physics2d.getBody(this.node) ?? null) : null;
    this.lastSpeedX = body?.velocityX ?? 0;
    this.lastSpeedY = body?.velocityY ?? 0;
  }

  private handleContact(...args: unknown[]): void {
    const other = args[0];
    const self = this.node;
    const scene = this.scene;
    if (!self || !scene || !(other instanceof NodeBase)) {
      return;
    }

    const otherBody = scene.physics2d.getBody(other);
    // Both discs of a disc-disc pair receive the signal; only the lower id
    // reports it, or every clack plays twice.
    if (otherBody && self.nodeId >= other.nodeId) {
      return;
    }

    const sample: DiscVelocitySample | null = otherBody ? velocitySampleOn(other) : null;
    const relativeX = this.lastSpeedX - (sample?.lastSpeedX ?? 0);
    const relativeY = this.lastSpeedY - (sample?.lastSpeedY ?? 0);
    const speed = Math.hypot(relativeX, relativeY);
    if (speed < CONTACT_SFX_MIN_SPEED) {
      return;
    }

    if (otherBody) {
      scene.audio.sfx('tap', {
        volume: clamp(speed / 1600, 0.08, 1),
        pitch: 1.1 + Math.random() * 0.25,
      });
    } else {
      // No body on the other side = static world geometry, i.e. a cushion.
      scene.audio.sfx('bounce', {
        volume: clamp(speed / 1800, 0.05, 0.8),
        pitch: 0.8 + Math.random() * 0.2,
      });
    }
  }
}
