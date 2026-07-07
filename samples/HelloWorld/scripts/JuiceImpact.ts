/**
 * JuiceImpact — tap or click anywhere to fire the classic "juicy hit" combo:
 * a brief hitstop, a camera shake, a screen flash, and a punch-scale on the
 * hero. Demonstrates driving GameTime (Time.scale) and the JuiceApi from a
 * user script — the same primitives a designer can drop as core:* behaviors.
 */
import { Script } from '@pix3/runtime';

export class JuiceImpact extends Script {
  onUpdate(): void {
    const input = this.input;
    const scene = this.scene;
    if (!input || !scene) {
      return;
    }

    const tapped = input.pointerEvents.some(event => event.type === 'down');
    if (!tapped) {
      return;
    }

    // The canonical "juicy hit" is a few fire-and-forget calls.
    scene.time.hitstop(90);
    scene.juice.shake('camera', { amplitude: 14, frequency: 26, duration: 0.4, decay: 1.4 });
    scene.juice.flash({ color: '#ffffff', intensity: 0.8, durationSec: 0.18 });
    scene.juice.punchScale('juice-hero', { amount: 0.4, duration: 0.45, vibrato: 3 });

    // For a slow-motion beat instead of a freeze, swap the hitstop above for:
    //   scene.time.slowMotion(0.35, { durationMs: 500, blendMs: 120 });
  }
}
