import { Node2D, Script, readWorldTransform2D } from '@pix3/runtime';

import {
  TRAIL_FADE_SEC,
  TRAIL_GHOST_COUNT,
  TRAIL_INTERVAL_SEC,
  TRAIL_MIN_SPEED,
  TRAIL_PEAK_OPACITY,
} from './carrom-geometry';

/**
 * `user:StrikerTrail` — the ghost trail behind a fast striker, on `Striker`.
 *
 * There is no 2D trail renderer in the engine (`Particles3D` has trails, nothing
 * 2D does), so this stamps a small pool of pre-authored additive sprites under
 * `Board/Trail` and fades them out. A pool rather than spawned nodes because a
 * full-power shot crosses the board in 0.4 s and would otherwise allocate a
 * node every 40 ms.
 */
export class StrikerTrail extends Script {
  private ghosts: Node2D[] = [];
  private opacities: number[] = [];
  private nextGhost = 0;
  private stampTimer = 0;

  onStart(): void {
    this.ghosts = [];
    this.opacities = [];
    for (let i = 0; i < TRAIL_GHOST_COUNT; i++) {
      const node = this.findNode(`Ghost${i}`);
      if (node instanceof Node2D) {
        node.opacity = 0;
        this.ghosts.push(node);
        this.opacities.push(0);
      }
    }
  }

  onUpdate(dt: number): void {
    if (dt <= 0 || this.ghosts.length === 0) {
      return;
    }

    for (let i = 0; i < this.ghosts.length; i++) {
      if (this.opacities[i] <= 0) {
        continue;
      }
      this.opacities[i] = Math.max(0, this.opacities[i] - dt / TRAIL_FADE_SEC);
      this.ghosts[i].opacity = this.opacities[i];
    }

    const striker = this.node;
    const scene = this.scene;
    if (!striker || !scene || !striker.visible) {
      return;
    }
    const body = scene.physics2d.getBody(striker);
    if (!body) {
      return;
    }

    this.stampTimer += dt;
    if (Math.hypot(body.velocityX, body.velocityY) < TRAIL_MIN_SPEED) {
      return;
    }
    if (this.stampTimer < TRAIL_INTERVAL_SEC) {
      return;
    }
    this.stampTimer = 0;

    const index = this.nextGhost;
    this.nextGhost = (this.nextGhost + 1) % this.ghosts.length;
    const ghost = this.ghosts[index];
    const parent = ghost.parentNode;
    const here = readWorldTransform2D(striker);
    // Ghosts live under Board/Trail, which need not sit at the origin — convert
    // through the pool's own frame rather than assuming it does.
    const frame = parent ? readWorldTransform2D(parent) : { x: 0, y: 0 };
    ghost.position.set(here.x - frame.x, here.y - frame.y, ghost.position.z);
    this.opacities[index] = TRAIL_PEAK_OPACITY;
    ghost.opacity = TRAIL_PEAK_OPACITY;
  }
}
