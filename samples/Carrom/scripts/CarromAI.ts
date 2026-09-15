import { Script } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';

import {
  AI_AIM_JITTER_DEGREES,
  AI_FALLBACK_POWER,
  AI_SCORE_DISTANCE_SCALE,
  AI_STRIKER_SLOTS,
  MAN_RADIUS,
  POCKETS,
  POCKET_CAPTURE_RADIUS,
  STRIKER_RADIUS,
  STRIKER_X_LIMIT,
  clamp,
  clampForwardCone,
  forwardSign,
  gaussian,
  isForwardDir,
  normalize,
  rotateVector,
  strikerLineY,
  sweepCircle,
  type AiShot,
  type AiShotRequest,
  type CarromAiApi,
  type Colour,
  type Point2,
  type SweepDisc,
} from './carrom-geometry';

/** A pot the search found, before noise is added. */
interface Candidate {
  x: number;
  dir: Point2;
  power: number;
  score: number;
}

/**
 * `user:CarromAI` — picks the opponent's shot, on `GameRoot`.
 *
 * It searches the same board the player is shown, with the SAME circle sweep the
 * aim guide draws (`sweepCircle` in `carrom-geometry`), so the AI cannot "see"
 * a line through a man that the guide says is blocked. For each of nine striker
 * placements × each of its own men (plus the Queen once it has a man banked) ×
 * each pocket, it builds the ghost contact point behind the man, requires both
 * legs of the shot to be clear, and scores the cut angle against the length of
 * the pot.
 *
 * Difficulty is aim noise only, never knowledge: a weak AI picks the same shot
 * and misses it. That keeps a low difficulty from looking stupid — it looks
 * inaccurate, which is what a beginner is.
 *
 * **It always returns a shot.** When nothing is potable it aims at the nearest
 * own man in front of the baseline at moderate power, which guarantees contact.
 * Returning nothing would leave the controller sitting in `AI_THINK`, and a turn
 * loop that can hang is worse than an opponent that plays badly.
 */
export class CarromAI extends Script implements CarromAiApi {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      aimJitterDegrees: AI_AIM_JITTER_DEGREES,
      fallbackPower: AI_FALLBACK_POWER,
    };
  }

  static getPropertySchema(): PropertySchema {
    const numberProp = (name: string, label: string, description: string, step: number) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'AI', step, description },
      getValue: (c: unknown) => (c as CarromAI).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as CarromAI).config[name] = Number(v);
      },
    });

    return {
      nodeType: 'CarromAI',
      properties: [
        numberProp(
          'aimJitterDegrees',
          'Aim Jitter',
          'One sigma of aim noise at difficulty 0, in degrees. Scaled down to 0 at difficulty 1.',
          0.1
        ),
        numberProp(
          'fallbackPower',
          'Fallback Power',
          'Power of the contact-guaranteeing shot taken when no pot is available.',
          0.05
        ),
      ],
      groups: { AI: { label: 'Carrom AI', expanded: true } },
    };
  }

  // -------------------------------------------------------------------------

  pickShot(request: AiShotRequest): AiShot {
    const best = this.searchPots(request);
    if (!best) {
      return this.fallbackShot(request.shooter, request.discs);
    }

    const sigma =
      (1 - clamp(request.difficulty, 0, 1)) *
      this.numberConfig('aimJitterDegrees', AI_AIM_JITTER_DEGREES);
    const noisy =
      sigma > 0 ? rotateVector(best.dir, ((gaussian() * sigma) / 180) * Math.PI) : best.dir;
    const cone = clampForwardCone(noisy, request.shooter);
    return { x: best.x, dir: { x: cone.x, y: cone.y }, power: best.power };
  }

  // -------------------------------------------------------------------------

  private searchPots(request: AiShotRequest): Candidate | null {
    const { shooter, discs, ownPocketed } = request;
    const lineY = strikerLineY(shooter);
    // The Queen is only worth going for once a man is banked to cover her with.
    const targets = discs.filter(
      disc => disc.kind === shooter || (disc.kind === 'queen' && ownPocketed >= 1)
    );
    if (targets.length === 0) {
      return null;
    }

    let best: Candidate | null = null;
    for (const slot of AI_STRIKER_SLOTS) {
      const from: Point2 = { x: slot, y: lineY };
      for (const man of targets) {
        for (const pocket of POCKETS) {
          const candidate = this.evaluate(shooter, discs, from, slot, man, pocket);
          if (candidate && (!best || candidate.score > best.score)) {
            best = candidate;
          }
        }
      }
    }
    return best;
  }

  private evaluate(
    shooter: Colour,
    discs: readonly SweepDisc[],
    from: Point2,
    slot: number,
    man: SweepDisc,
    pocket: Point2
  ): Candidate | null {
    // The ghost point: where the striker's CENTRE must be at contact to send the
    // man straight at the pocket.
    const away = normalize({ x: man.x - pocket.x, y: man.y - pocket.y });
    if (!away) {
      return null;
    }
    const contactDistance = STRIKER_RADIUS + man.radius;
    const ghost: Point2 = {
      x: man.x + away.x * contactDistance,
      y: man.y + away.y * contactDistance,
    };

    const toGhost = { x: ghost.x - from.x, y: ghost.y - from.y };
    const runUp = Math.hypot(toGhost.x, toGhost.y);
    if (runUp < 1) {
      return null;
    }
    const dir: Point2 = { x: toGhost.x / runUp, y: toGhost.y / runUp };
    if (!isForwardDir(dir, shooter)) {
      return null;
    }

    // Leg 1: the striker must actually reach the ghost point, i.e. the first
    // thing its swept circle touches has to be this man.
    const approach = sweepCircle(from, dir, STRIKER_RADIUS, discs);
    if (!approach || approach.kind !== 'disc' || approach.disc?.id !== man.id) {
      return null;
    }

    // Leg 2: the man's own run to the pocket must be clear far enough that its
    // centre lands inside the capture radius.
    const toPocket = normalize({ x: pocket.x - man.x, y: pocket.y - man.y });
    if (!toPocket) {
      return null;
    }
    const potLength = Math.hypot(pocket.x - man.x, pocket.y - man.y);
    const needed = Math.max(0, potLength - POCKET_CAPTURE_RADIUS);
    const others = discs.filter(disc => disc.id !== man.id);
    const run = sweepCircle({ x: man.x, y: man.y }, toPocket, man.radius, others);
    if (run && run.t < needed) {
      return null;
    }

    // Cut angle: a straight-on pot transfers everything, a thin cut almost
    // nothing. Squared because that is how the energy actually splits.
    const cut = Math.max(0, dir.x * toPocket.x + dir.y * toPocket.y);
    const score = cut * cut * Math.max(0, 1 - potLength / AI_SCORE_DISTANCE_SCALE);
    if (score <= 0) {
      return null;
    }

    const power = clamp(0.35 + runUp / 1400 + potLength / 2200, 0.3, 0.95);
    return { x: slot, dir, power, score };
  }

  /**
   * No pot available: hit the nearest own man that is IN FRONT of the baseline,
   * from the striker slot closest to it. Preferring a man in front matters — a
   * man level with or behind the line cannot be reached inside the forward cone,
   * and aiming at it would produce a legal shot that touches nothing.
   */
  private fallbackShot(shooter: Colour, discs: readonly SweepDisc[]): AiShot {
    const power = clamp(this.numberConfig('fallbackPower', AI_FALLBACK_POWER), 0.1, 1);
    const lineY = strikerLineY(shooter);
    const sign = forwardSign(shooter);
    const straightAhead: AiShot = { x: 0, dir: { x: 0, y: sign }, power };

    const own = discs.filter(disc => disc.kind === shooter);
    const pool = own.length > 0 ? own : discs.filter(disc => disc.kind !== 'striker');
    const inFront = pool.filter(disc => (disc.y - lineY) * sign > MAN_RADIUS);
    const reachable = inFront.length > 0 ? inFront : pool;
    if (reachable.length === 0) {
      return straightAhead;
    }

    let target = reachable[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const disc of reachable) {
      const distance = Math.hypot(disc.x, disc.y - lineY);
      if (distance < bestDistance) {
        bestDistance = distance;
        target = disc;
      }
    }

    const x = clamp(target.x, -STRIKER_X_LIMIT, STRIKER_X_LIMIT);
    const cone = clampForwardCone({ x: target.x - x, y: target.y - lineY }, shooter);
    return { x, dir: { x: cone.x, y: cone.y }, power };
  }

  private numberConfig(name: string, fallback: number): number {
    const value = Number(this.config[name]);
    return Number.isFinite(value) ? value : fallback;
  }
}
