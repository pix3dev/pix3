/**
 * Carrom — shared geometry, physics constants and pure helpers.
 *
 * Not a `Script`: a plain module imported by every `user:` component so that
 * the board art, the physics colliders, the aim preview and the rules all read
 * the SAME numbers. Every value here is authored in `scenes/main.pix3scene`
 * too; if the two ever disagree the scene is wrong, not this file.
 *
 * Coordinate convention (verified against `Node2D` / `Physics2DService`):
 * design pixels, origin at the parent container's centre, **X right, Y up**.
 * The board is centred on the scene root, so board space == 2D world space.
 * The human shoots from negative y (bottom), the opponent from positive y.
 */

import type { NodeBase } from '@pix3/runtime';

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** Anything that behaves as a disc on the board. */
export type DiscKind = 'white' | 'black' | 'queen' | 'striker';

/** A player's colour. */
export type Colour = 'white' | 'black';

export interface Point2 {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Board geometry (design pixels) — spec §3
// ---------------------------------------------------------------------------

/** Half the wooden outer square: the board spans ±500 on both axes. */
export const BOARD_HALF = 500;
/** Wooden frame thickness; the playfield is what is left inside it. */
export const FRAME_THICKNESS = 60;
/** Half the playfield: cushion faces sit exactly at ±440. */
export const FIELD_HALF = BOARD_HALF - FRAME_THICKNESS; // 440
/** Cushion collider depth. Thick enough that nothing tunnels sideways into it. */
export const CUSHION_THICKNESS = 80;
/** Distance from a cushion face to a pocket centre. */
export const POCKET_INSET = 32;
/** Pocket centres sit at (±408, ±408). */
export const POCKET_CENTRE = FIELD_HALF - POCKET_INSET; // 408
/** Radius of the drawn hole. */
export const POCKET_VISUAL_RADIUS = 32;
/** A disc is pocketed when its CENTRE comes within this of a pocket centre. */
export const POCKET_CAPTURE_RADIUS = 28;

export const MAN_RADIUS = 20;
export const QUEEN_RADIUS = 20;
export const STRIKER_RADIUS = 26;

/** Front / rear baseline rows (drawn); the shooter stands between them. */
export const BASELINE_FRONT_Y = 330;
export const BASELINE_REAR_Y = 362;
/** Baselines run from -280 to +280 in x. */
export const BASELINE_HALF_EXTENT = 280;
/** The striker's centre line: midway between the two baselines. */
export const STRIKER_LINE_Y = 346;
/** How far along its line the striker may be placed (keeps its radius inside the base circles). */
export const STRIKER_X_LIMIT = 240;

export const BASE_CIRCLE_RADIUS = 19;
export const CENTRE_CIRCLE_RADIUS = 19;
export const CENTRE_RING_RADIUS = 95;
export const OUTER_CENTRE_RING_RADIUS = 170;

/** Where the striker waits while it is not in play — outside every collider. */
export const STRIKER_PARK: Point2 = { x: 0, y: -1200 };

/** Rack radii: inner ring of 6, then 6 + 6 interleaved on the outer ring. */
export const RACK_INNER_RADIUS = 2 * MAN_RADIUS + 1; // 41
export const RACK_OUTER_RADIUS = 82;
export const RACK_MID_RADIUS = 71; // 41 * sqrt(3), rounded

/** Hex-spiral step used when returning a piece to the centre. */
export const RETURN_SPACING = 2 * MAN_RADIUS + 2; // 42
/** A spot is free when no disc centre is within this distance. */
export const RETURN_CLEARANCE = 2 * MAN_RADIUS + 1; // 41

/** Men per side. */
export const MEN_PER_SIDE = 9;

/** The four pocket centres, TL, TR, BL, BR. */
export const POCKETS: readonly Point2[] = [
  { x: -POCKET_CENTRE, y: POCKET_CENTRE },
  { x: POCKET_CENTRE, y: POCKET_CENTRE },
  { x: -POCKET_CENTRE, y: -POCKET_CENTRE },
  { x: POCKET_CENTRE, y: -POCKET_CENTRE },
];

// ---------------------------------------------------------------------------
// Physics parameters — spec §4
// ---------------------------------------------------------------------------

export const MAN_MASS = 1;
export const STRIKER_MASS = 2.4;
/** Viscous part of cloth drag (`core:PhysicsBody2D.linearDamping`). */
export const LINEAR_DAMPING = 0.6;
export const DISC_FRICTION = 0.05;
export const CUSHION_FRICTION = 0.1;
/** One value for discs AND cushions: the solver combines restitution as `max`. */
export const RESTITUTION = 0.78;

/**
 * Extra CONSTANT deceleration applied by script every frame. The engine only
 * offers exponential `linearDamping`; real cloth is Coulomb (constant decel)
 * and stops crisply, which is what makes a carrom board feel like cloth rather
 * than ice.
 */
export const DECEL_PX_PER_SEC2 = 220;
/** Below this speed a disc is snapped to a dead stop, killing sub-pixel creep. */
export const STOP_SNAP_SPEED = 6;

export const MIN_LAUNCH_SPEED = 350;
export const MAX_LAUNCH_SPEED = 2200;

/** All discs must be below {@link STOP_SNAP_SPEED} this long before a strike resolves. */
export const SETTLE_HOLD_SEC = 0.35;
/** Hard ceiling on one strike, so a jitter case can never hang the turn loop. */
export const SETTLE_TIMEOUT_SEC = 8;

/** A pull shorter than this cancels instead of shooting. */
export const MIN_POWER = 0.08;
/** Forward cone: the shot's own-direction component must be at least this. */
export const FORWARD_CONE_MIN_Y = 0.12;

/** Pull length that maps to full power, and the dead zone at the start of it. */
export const PULL_DEAD_ZONE = 20;
export const PULL_FULL_POWER = 260;

/** Aim-guide presentation. */
export const GUIDE_DOT_COUNT = 12;
export const GUIDE_DOT_SPACING = 28;
export const GUIDE_MAX_LENGTH = 520;
export const GUIDE_COLOUR_SOFT = '#38bdf8';
export const GUIDE_COLOUR_HARD = '#f43f5e';
export const GUIDE_COLOUR_BLOCKED = '#ff3b30';

/** Ghost-trail pool on the striker. */
export const TRAIL_GHOST_COUNT = 8;
export const TRAIL_MIN_SPEED = 300;
export const TRAIL_INTERVAL_SEC = 0.04;
export const TRAIL_FADE_SEC = 0.3;
export const TRAIL_PEAK_OPACITY = 0.35;

/** Contacts softer than this make no sound. */
export const CONTACT_SFX_MIN_SPEED = 60;

// --- AI (M4) --------------------------------------------------------------

/** The nine striker placements the AI considers, across its baseline. */
export const AI_STRIKER_SLOTS: readonly number[] = [-240, -180, -120, -60, 0, 60, 120, 180, 240];
/** Aim noise at difficulty 0, in degrees (1 sigma). Difficulty 1 shoots exactly. */
export const AI_AIM_JITTER_DEGREES = 2.5;
/** Power of the contact-guaranteeing fallback shot. */
export const AI_FALLBACK_POWER = 0.45;
/** Distance at which a pot scores nothing, used to prefer short pots. */
export const AI_SCORE_DISTANCE_SCALE = 1200;
/** How long the AI "thinks" before it shoots, so a turn is readable. */
export const AI_THINK_SEC = 0.9;
/**
 * Hard frame cap on `AI_THINK`. The think delay is measured in scaled game
 * time, so a pathological `timeScale` could stretch it without bound; this is
 * counted in frames and forces the shot (or a turn pass) regardless.
 */
export const AI_THINK_MAX_FRAMES = 600;

// --- Feel (M5) ------------------------------------------------------------

/** Freeze on the striker's FIRST contact of a strike, in real milliseconds. */
export const HITSTOP_MS = 40;
/** Impacts softer than this do not shake the camera. */
export const IMPACT_SHAKE_MIN_SPEED = 600;
export const IMPACT_SHAKE_MIN_AMPLITUDE = 2;
export const IMPACT_SHAKE_MAX_AMPLITUDE = 8;
export const IMPACT_SHAKE_SPEED_SCALE = 400;
export const IMPACT_SHAKE_DURATION = 0.18;
export const IMPACT_SHAKE_FREQUENCY = 26;

/** The Queen's slow-motion beat. */
export const QUEEN_SLOWMO_SCALE = 0.35;
export const QUEEN_SLOWMO_MS = 450;
export const QUEEN_SLOWMO_BLEND_MS = 80;

/** End-screen celebration: three staggered bursts at the winner's HUD count. */
export const WIN_BURST_COUNT = 3;
export const WIN_BURST_INTERVAL_SEC = 0.18;

/** Idle hint: after this long in AIM with nothing touched, pulse the help text. */
export const IDLE_HINT_AFTER_SEC = 4;
export const IDLE_HINT_PERIOD_SEC = 2;
export const IDLE_HINT_PUNCH = 0.05;

/** Palettes, kept next to the geometry so bursts match the sprites. */
export const DISC_PALETTE: Readonly<Record<DiscKind, readonly string[]>> = {
  white: ['#f3e9d2', '#b89a6a', '#ffffff'],
  black: ['#23201d', '#5a5049', '#ffffff'],
  queen: ['#c8202f', '#f5ae39', '#ffd166'],
  striker: ['#f7f3ea', '#0ea5e9', '#ffffff'],
};

/** Every kind that is spawned from a prefab (the striker is authored in the scene). */
export type SpawnableKind = 'white' | 'black' | 'queen';

export function isSpawnableKind(kind: DiscKind): kind is SpawnableKind {
  return kind === 'white' || kind === 'black' || kind === 'queen';
}

/** `res://` path of the prefab that spawns one disc of `kind`. */
export function prefabPath(kind: SpawnableKind): string {
  switch (kind) {
    case 'white':
      return 'res://scenes/man-white.pix3scene';
    case 'black':
      return 'res://scenes/man-black.pix3scene';
    case 'queen':
      return 'res://scenes/queen.pix3scene';
  }
}

// ---------------------------------------------------------------------------
// Small maths helpers
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Unit vector, or `null` for a degenerate input. */
export function normalize(v: Point2): Point2 | null {
  const length = Math.hypot(v.x, v.y);
  if (!Number.isFinite(length) || length <= 1e-9) {
    return null;
  }
  return { x: v.x / length, y: v.y / length };
}

export function distance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Rotate a vector by `radians` (CCW, y up). */
export function rotateVector(v: Point2, radians: number): Point2 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

/**
 * One standard-normal sample (Box-Muller). Used for the AI's aim noise, so a
 * low difficulty misses the way a person does — mostly close, occasionally
 * badly — instead of uniformly.
 */
export function gaussian(): number {
  let u = 0;
  while (u <= Number.EPSILON) {
    u = Math.random();
  }
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/** Polar → cartesian with the angle in DEGREES, y up. */
export function polar(radius: number, degrees: number): Point2 {
  const radians = (degrees * Math.PI) / 180;
  return { x: radius * Math.cos(radians), y: radius * Math.sin(radians) };
}

export function discRadius(kind: DiscKind): number {
  return kind === 'striker' ? STRIKER_RADIUS : kind === 'queen' ? QUEEN_RADIUS : MAN_RADIUS;
}

export function otherColour(colour: Colour): Colour {
  return colour === 'white' ? 'black' : 'white';
}

/** +1 for white (shoots up the board), -1 for black. */
export function forwardSign(shooter: Colour): number {
  return shooter === 'white' ? 1 : -1;
}

/**
 * Y of the shooter's striker line.
 *
 * Note the sign is the OPPOSITE of {@link forwardSign}: white sits at the bottom
 * (negative y) and shoots up, black sits at the top and shoots down. Deriving
 * this from `forwardSign` is how it was wrong the first time — it put white's
 * striker on black's baseline, and every shot then fired away from the board.
 */
export function strikerLineY(shooter: Colour): number {
  return shooter === 'white' ? -STRIKER_LINE_Y : STRIKER_LINE_Y;
}

/** Launch speed for a normalised power. */
export function launchSpeed(power: number): number {
  return MIN_LAUNCH_SPEED + clamp(power, 0, 1) * (MAX_LAUNCH_SPEED - MIN_LAUNCH_SPEED);
}

/** The pocket whose centre captures `(x, y)`, or `null`. */
export function capturingPocket(x: number, y: number): Point2 | null {
  for (const pocket of POCKETS) {
    if (Math.hypot(x - pocket.x, y - pocket.y) <= POCKET_CAPTURE_RADIUS) {
      return pocket;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rack
// ---------------------------------------------------------------------------

export interface RackEntry {
  kind: SpawnableKind;
  x: number;
  y: number;
}

/**
 * The 19-piece opening rack: the Queen on the centre spot, a ring of six
 * alternating men around her, and twelve more on the outer ring. Totals are
 * 9 white + 9 black + 1 Queen.
 */
export function rackLayout(): RackEntry[] {
  const entries: RackEntry[] = [{ kind: 'queen', x: 0, y: 0 }];

  // Inner ring: W, B, W, B, W, B starting with white pointing at +x.
  for (let i = 0; i < 6; i++) {
    const point = polar(RACK_INNER_RADIUS, i * 60);
    entries.push({ kind: i % 2 === 0 ? 'white' : 'black', x: point.x, y: point.y });
  }

  // Outer ring: 6 on the axes at 82, 6 between them at 71, sorted by angle and
  // alternating B, W, B, W … starting with black at 0°.
  const outer: { degrees: number; radius: number }[] = [];
  for (let i = 0; i < 6; i++) {
    outer.push({ degrees: i * 60, radius: RACK_OUTER_RADIUS });
    outer.push({ degrees: 30 + i * 60, radius: RACK_MID_RADIUS });
  }
  outer.sort((a, b) => a.degrees - b.degrees);
  outer.forEach((slot, index) => {
    const point = polar(slot.radius, slot.degrees);
    entries.push({ kind: index % 2 === 0 ? 'black' : 'white', x: point.x, y: point.y });
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Analytic circle sweep (the aim preview) — the engine has no shape cast
// ---------------------------------------------------------------------------

/** One obstacle the sweep can hit. */
export interface SweepDisc {
  id: string;
  kind: DiscKind;
  x: number;
  y: number;
  radius: number;
}

export interface SweepHit {
  /** Distance travelled along `dir` before contact. */
  t: number;
  /** Centre of the swept circle at contact — where a ghost striker is drawn. */
  point: Point2;
  kind: 'disc' | 'cushion';
  /** The disc that was hit, or `null` for a cushion. */
  disc: SweepDisc | null;
  /** Unit contact normal, pointing back at the swept circle. */
  normal: Point2;
}

/**
 * Sweep a circle of `radius` from `origin` along `dir` and return the first
 * thing it touches: a disc (ray vs a circle grown by `radius + disc.radius`) or
 * a cushion (the AABB of the playfield inset by `radius`). `null` only when
 * `dir` is degenerate.
 */
export function sweepCircle(
  origin: Point2,
  dir: Point2,
  radius: number,
  discs: readonly SweepDisc[],
  fieldHalf: number = FIELD_HALF
): SweepHit | null {
  const unit = normalize(dir);
  if (!unit) {
    return null;
  }

  let bestT = Number.POSITIVE_INFINITY;
  let bestDisc: SweepDisc | null = null;

  for (const disc of discs) {
    const reach = radius + disc.radius;
    const fx = origin.x - disc.x;
    const fy = origin.y - disc.y;
    const b = fx * unit.x + fy * unit.y;
    const c = fx * fx + fy * fy - reach * reach;
    const discriminant = b * b - c;
    if (discriminant < 0) {
      continue;
    }
    const t = -b - Math.sqrt(discriminant);
    // t <= 0 means the circle already overlaps this disc; it is not "ahead".
    if (t > 1e-4 && t < bestT) {
      bestT = t;
      bestDisc = disc;
    }
  }

  // Cushions: the swept centre must stay inside the field inset by `radius`.
  const limit = Math.max(1, fieldHalf - radius);
  const tx =
    unit.x > 1e-9
      ? (limit - origin.x) / unit.x
      : unit.x < -1e-9
        ? (-limit - origin.x) / unit.x
        : Number.POSITIVE_INFINITY;
  const ty =
    unit.y > 1e-9
      ? (limit - origin.y) / unit.y
      : unit.y < -1e-9
        ? (-limit - origin.y) / unit.y
        : Number.POSITIVE_INFINITY;
  const cushionT = Math.max(0, Math.min(tx, ty));
  const cushionNormal: Point2 =
    tx < ty ? { x: unit.x > 0 ? -1 : 1, y: 0 } : { x: 0, y: unit.y > 0 ? -1 : 1 };

  if (bestDisc && bestT <= cushionT) {
    const point = { x: origin.x + unit.x * bestT, y: origin.y + unit.y * bestT };
    const normal = normalize({ x: point.x - bestDisc.x, y: point.y - bestDisc.y }) ?? {
      x: -unit.x,
      y: -unit.y,
    };
    return { t: bestT, point, kind: 'disc', disc: bestDisc, normal };
  }

  if (!Number.isFinite(cushionT)) {
    return null;
  }
  return {
    t: cushionT,
    point: { x: origin.x + unit.x * cushionT, y: origin.y + unit.y * cushionT },
    kind: 'cushion',
    disc: null,
    normal: cushionNormal,
  };
}

// ---------------------------------------------------------------------------
// Returning a piece to the centre
// ---------------------------------------------------------------------------

/**
 * The nearest free spot to `(x, y)`, walking outwards on a hexagonal lattice in
 * steps of {@link RETURN_SPACING}. A spot is free when no disc centre is within
 * {@link RETURN_CLEARANCE} and the whole man stays inside the playfield.
 *
 * Falls back to `(x, y)` when the board is so packed that nothing is free — a
 * position that overlaps is still better than dropping the piece.
 */
export function freeSpotNear(x: number, y: number, discs: readonly SweepDisc[]): Point2 {
  const rings = 8;
  const stepX = RETURN_SPACING;
  const axialX = RETURN_SPACING / 2;
  const axialY = (RETURN_SPACING * Math.sqrt(3)) / 2;
  const bound = FIELD_HALF - MAN_RADIUS - 2;

  const candidates: Point2[] = [];
  for (let a = -rings; a <= rings; a++) {
    for (let b = -rings; b <= rings; b++) {
      candidates.push({ x: x + a * stepX + b * axialX, y: y + b * axialY });
    }
  }
  candidates.sort(
    (p, q) =>
      (p.x - x) * (p.x - x) +
      (p.y - y) * (p.y - y) -
      ((q.x - x) * (q.x - x) + (q.y - y) * (q.y - y))
  );

  for (const candidate of candidates) {
    if (Math.abs(candidate.x) > bound || Math.abs(candidate.y) > bound) {
      continue;
    }
    if (capturingPocket(candidate.x, candidate.y)) {
      continue;
    }
    let blocked = false;
    for (const disc of discs) {
      if (Math.hypot(candidate.x - disc.x, candidate.y - disc.y) < RETURN_CLEARANCE) {
        blocked = true;
        break;
      }
    }
    if (!blocked) {
      return candidate;
    }
  }
  return { x, y };
}

// ---------------------------------------------------------------------------
// Shot legality
// ---------------------------------------------------------------------------

/** Is this direction inside the shooter's forward cone? */
export function isForwardDir(dir: Point2, shooter: Colour): boolean {
  const unit = normalize(dir);
  if (!unit) {
    return false;
  }
  return unit.y * forwardSign(shooter) >= FORWARD_CONE_MIN_Y - 1e-6;
}

export interface ConeClamp extends Point2 {
  /** True when the requested direction was outside the cone and got pulled in. */
  clamped: boolean;
}

/**
 * Clamp `dir` into the shooter's forward cone (within ±83° of straight ahead).
 * Out-of-cone pulls snap to the nearer cone edge rather than being rejected —
 * the gesture stays alive and the guide turns red.
 */
export function clampForwardCone(dir: Point2, shooter: Colour): ConeClamp {
  const sign = forwardSign(shooter);
  const unit = normalize(dir) ?? { x: 0, y: sign };
  if (unit.y * sign >= FORWARD_CONE_MIN_Y) {
    return { x: unit.x, y: unit.y, clamped: false };
  }
  const edgeX = Math.sqrt(1 - FORWARD_CONE_MIN_Y * FORWARD_CONE_MIN_Y) * (unit.x >= 0 ? 1 : -1);
  return { x: edgeX, y: FORWARD_CONE_MIN_Y * sign, clamped: true };
}

// ---------------------------------------------------------------------------
// Cross-script contract
// ---------------------------------------------------------------------------

/** The run states of `user:GameController`. */
export type CarromState =
  | 'AIM'
  | 'AI_THINK'
  | 'SHOOT'
  | 'SIMULATE'
  | 'RESOLVE'
  | 'NEXT_TURN'
  | 'GAME_OVER';

/**
 * What `user:ShotInput` and `user:AimGuide` need from `user:GameController`.
 *
 * Resolved by component `type` rather than `instanceof` on purpose: in-editor
 * user scripts are compiled per file and may resolve more than one module copy,
 * which would make `instanceof` silently false.
 */
export interface CarromControllerApi {
  readonly state: CarromState;
  readonly shooter: Colour;
  /**
   * Every man and the Queen currently on the board. The striker is deliberately
   * NOT in the list: it is the circle being swept, not an obstacle.
   */
  sweepDiscs(): SweepDisc[];
  /** Board-space centre of the striker. */
  strikerPosition(): Point2;
  /** Slide the striker along the shooter's line; only legal in `AIM`. */
  placeStriker(x: number): boolean;
  /**
   * Launch the striker. Legal in `AIM` and `AI_THINK`, and only inside the
   * shooter's forward cone — an out-of-cone direction is REFUSED, not clamped,
   * so a bad `shoot` command is visible rather than silently corrected.
   */
  requestShot(dir: Point2, power: number): boolean;
}

/** The `user:GameController` attached to `node`, or `null`. */
export function controllerOn(node: NodeBase | null | undefined): CarromControllerApi | null {
  if (!node) {
    return null;
  }
  for (const component of node.components) {
    if (component.type === 'user:GameController') {
      return component as unknown as CarromControllerApi;
    }
  }
  return null;
}

/** One shot the AI wants to take: where to place the striker, and how to hit it. */
export interface AiShot {
  /** Striker x on the shooter's baseline; the controller clamps it to ±240. */
  x: number;
  /** Unit direction, already inside the shooter's forward cone. */
  dir: Point2;
  /** 0..1. */
  power: number;
}

/** Everything `user:CarromAI` needs to choose a shot. */
export interface AiShotRequest {
  shooter: Colour;
  /** The live board, striker excluded (see {@link CarromControllerApi.sweepDiscs}). */
  discs: readonly SweepDisc[];
  /** How many men of the shooter's colour are already pocketed — gates the Queen. */
  ownPocketed: number;
  /** 0..1. 1 aims exactly; 0 gets the full aim noise. */
  difficulty: number;
}

/**
 * What `user:GameController` needs from `user:CarromAI`.
 *
 * `pickShot` is synchronous and MUST return a shot. When it cannot find a pot it
 * returns the contact-guaranteeing fallback rather than nothing: an AI that
 * declines to shoot would strand the turn loop in `AI_THINK`.
 */
export interface CarromAiApi {
  pickShot(request: AiShotRequest): AiShot;
}

/** The `user:CarromAI` attached to `node`, or `null`. */
export function aiOn(node: NodeBase | null | undefined): CarromAiApi | null {
  if (!node) {
    return null;
  }
  for (const component of node.components) {
    if (component.type === 'user:CarromAI') {
      return component as unknown as CarromAiApi;
    }
  }
  return null;
}

/**
 * Previous-frame velocity of a disc, published by `user:Disc` so a contact can
 * estimate its impact speed. Contact signals carry only the other node — no
 * point, normal or impulse — and they are flushed AFTER the solver, so the
 * post-impact velocities are useless for scaling a sound.
 *
 * Duck-typed for the same reason as {@link controllerOn}.
 */
export interface DiscVelocitySample {
  lastSpeedX: number;
  lastSpeedY: number;
}

export function velocitySampleOn(node: NodeBase | null | undefined): DiscVelocitySample | null {
  if (!node) {
    return null;
  }
  for (const component of node.components) {
    const candidate = component as unknown as Partial<DiscVelocitySample>;
    if (typeof candidate.lastSpeedX === 'number' && typeof candidate.lastSpeedY === 'number') {
      return candidate as DiscVelocitySample;
    }
  }
  return null;
}

/** Linear sRGB-hex interpolation, used for the guide's power colour. */
export function lerpHex(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const t = clamp(amount, 0, 1);
  const channel = (index: number): number => Math.round(a[index] + (b[index] - a[index]) * t);
  return `#${[channel(0), channel(1), channel(2)]
    .map(value => clamp(value, 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

function parseHex(hex: string): [number, number, number] {
  const text = hex.startsWith('#') ? hex.slice(1) : hex;
  const full =
    text.length === 3
      ? text
          .split('')
          .map(c => c + c)
          .join('')
      : text;
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(value)) {
    return [255, 255, 255];
  }
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
