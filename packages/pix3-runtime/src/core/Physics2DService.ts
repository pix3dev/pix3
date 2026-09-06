import type { NodeBase } from '../nodes/NodeBase';
import {
  boxPolygon,
  capsulePolygon,
  decomposeConvex,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  polygonCentroid,
  transformPolygon,
  type Bounds2D,
  type Point2D,
  type ShapeTransform2D,
} from './collision-shapes-2d';
import {
  collideCirclePolygon,
  collideCircles,
  collidePolygons,
  sweepCircleAgainstPolygon,
  type Manifold2D,
} from './physics-2d-narrowphase';
import { readWorldTransform2D } from './world-transform-2d';

/**
 * Physics2DService — the built-in 2D rigid-body solver.
 *
 * Reached from scripts as `this.scene.physics2d`, stepped by `SceneRunner` in the
 * existing fixed-step slot, and authored as two components (`core:PhysicsBody2D`
 * + `core:Collider2D`) rather than node types — see `.plans/physics-engine.md`
 * for why: a component needs none of the ~14-file new-node checklist and gets
 * inspector UI, YAML serialization and export stripping for free.
 *
 * **Units and space.** Design pixels, y up, radians CCW — the same space
 * `Node2D` and `Collision2DService` live in. Gravity therefore defaults to
 * *negative* y.
 *
 * **Shapes.** Circles and convex polygons. Rects are polygons; an authored
 * concave polygon is decomposed once (`decomposeConvex`) into convex parts that
 * all belong to the same collider, so a traced sprite outline is a first-class
 * collider rather than something the designer has to cut up by hand.
 *
 * **Solver.** Sequential impulses with warm starting: accumulated normal and
 * tangent impulses are carried between steps keyed by the narrowphase's feature
 * ids, which is what lets a stack settle instead of buzzing. Penetration is
 * resolved by Baumgarte bias with a slop, restitution only above a threshold
 * speed. Iteration order is insertion order, so a run reproduces on the same
 * machine.
 *
 * **What it is not.** No joints, no capsules, no islands, no cross-machine
 * determinism. This is a playable-ads engine's physics, not middleware; the
 * escape hatch (swap the internals for a vendored solver behind the same
 * component API) is documented in the plan and is why the authored surface is
 * specified independently of any of this.
 */

// --- authored surface -------------------------------------------------------

export type PhysicsBody2DType = 'static' | 'kinematic' | 'dynamic';

/**
 * Shape of a collider as authored. Everything except `circle` resolves to convex
 * polygon parts; see {@link capsulePolygon} for what a capsule becomes and why.
 */
export type Collider2DShape = 'rect' | 'circle' | 'polygon' | 'capsule';

/**
 * The contract a collider component implements. Read live on every rebuild so an
 * inspector edit applies without re-registration, exactly like `Hitbox2DSource`.
 */
export interface Collider2DSource {
  readonly node: NodeBase | null;
  readonly enabled: boolean;
  getColliderShape(): Collider2DShape;
  getColliderSize(): { width: number; height: number; radius: number };
  getColliderOffset(): { x: number; y: number };
  getColliderPolygon(): readonly Point2D[];
  getColliderMaterial(): { friction: number; restitution: number; density: number };
  isSensor(): boolean;
  getColliderGroup(): string;
  /** Config revision; a change rebuilds the baked shape. */
  getColliderRevision(): string;
}

/** The contract a body component implements. */
export interface PhysicsBody2DSource {
  readonly node: NodeBase | null;
  readonly enabled: boolean;
  getBodyType(): PhysicsBody2DType;
  getBodyConfig(): {
    gravityScale: number;
    mass: number;
    linearDamping: number;
    angularDamping: number;
    fixedRotation: boolean;
    bullet: boolean;
    canSleep: boolean;
    emitContacts: boolean;
  };
}

/** The handle scripts get back from `physics2d.getBody(node)`. */
export interface PhysicsBody2DHandle {
  readonly node: NodeBase;
  readonly bodyType: PhysicsBody2DType;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly angularVelocity: number;
  readonly isSleeping: boolean;
  setVelocity(vx: number, vy: number): void;
  setAngularVelocity(w: number): void;
  applyImpulse(ix: number, iy: number): void;
  applyForce(fx: number, fy: number): void;
  /** Reposition without generating a contact impulse (Godot's teleport semantics). */
  teleport(x: number, y: number, rotation?: number): void;
  wake(): void;
}

/** The live, solver-facing settings of a hinge. Angles are radians here. */
export interface RevoluteJoint2DConfig {
  limitEnabled: boolean;
  lowerAngle: number;
  upperAngle: number;
  motorEnabled: boolean;
  /** Target relative spin, radians per second. */
  motorSpeed: number;
  maxMotorTorque: number;
  /**
   * Let the two hinged bodies collide with each other. Off by default (as in
   * Box2D): the parts of a hinge almost always overlap at the pivot, and a
   * contact there fights the joint for control of the same two bodies —
   * measured as ~8 px of pivot drift on a two-body hinge before this existed.
   */
  collideConnected: boolean;
}

/** The contract a hinge component implements (see `RevoluteJoint2DBehavior`). */
export interface RevoluteJoint2DSource {
  readonly node: NodeBase | null;
  readonly enabled: boolean;
  /** Pivot in the joint node's local pixels. */
  getJointAnchor(): { x: number; y: number };
  /** The other body, or null to hinge against the world. */
  getConnectedNode(): NodeBase | null;
  getJointConfig(): RevoluteJoint2DConfig;
}

/** Options accepted by every world query. */
export interface Physics2DQueryOptions {
  /** Only consider colliders in this group. */
  group?: string;
  /** Include sensors in the result (default: false — sensors detect, they do not block). */
  includeSensors?: boolean;
}

/** What {@link Physics2DService.moveAndCollide} did and what stopped it. */
export interface MoveCollide2DResult {
  /** Actual displacement, which is less than the request when something blocked. */
  movedX: number;
  movedY: number;
  collided: boolean;
  /** Surface normal pointing *away* from what was hit, or `(0, 0)`. */
  normalX: number;
  normalY: number;
  collider: NodeBase | null;
}

export interface MoveAndSlide2DOptions extends Physics2DQueryOptions {
  /** "Up" for floor/ceiling classification. Defaults to `(0, 1)`. */
  upX?: number;
  upY?: number;
  /** Degrees from `up` a surface may tilt and still count as floor. Default 45. */
  floorMaxAngle?: number;
  /** How many times the motion may be redirected in one call. Default 4. */
  maxSlides?: number;
}

export interface MoveAndSlide2DResult {
  /** The velocity with blocked components removed — feed it back next frame. */
  velocityX: number;
  velocityY: number;
  isOnFloor: boolean;
  isOnWall: boolean;
  isOnCeiling: boolean;
  /** Normal of the surface being stood on, when `isOnFloor`. */
  floorNormalX: number;
  floorNormalY: number;
  /** The last thing hit during the slide, or null. */
  collider: NodeBase | null;
}

export interface Physics2DRaycastHit {
  node: NodeBase;
  group: string;
  x: number;
  y: number;
  distance: number;
}

// --- internals --------------------------------------------------------------

interface BakedShape {
  /** `empty` is an authored shape that resolved to nothing — skipped everywhere. */
  kind: 'circle' | 'polygon' | 'empty';
  /** Circle: centre in body space. Polygon: unused. */
  cx: number;
  cy: number;
  radius: number;
  /** Convex parts in body-local space (post-scale, pre-rotation). */
  parts: Point2D[][];
  /** World-space parts, refreshed each step. */
  worldParts: Point2D[][];
  worldCx: number;
  worldCy: number;
  area: number;
  /** Second moment of area about the shape centroid, per unit density. */
  inertiaPerDensity: number;
  centroidX: number;
  centroidY: number;
}

interface ColliderEntry {
  source: Collider2DSource;
  body: BodyEntry;
  shape: BakedShape;
  friction: number;
  restitution: number;
  density: number;
  sensor: boolean;
  group: string;
  revision: string;
  bounds: Bounds2D;
  /** Insertion index — the tiebreaker that keeps iteration reproducible. */
  order: number;
}

interface BodyEntry {
  node: NodeBase;
  source: PhysicsBody2DSource | null;
  bodyType: PhysicsBody2DType;
  x: number;
  y: number;
  rotation: number;
  vx: number;
  vy: number;
  w: number;
  forceX: number;
  forceY: number;
  torque: number;
  mass: number;
  invMass: number;
  inertia: number;
  invInertia: number;
  gravityScale: number;
  linearDamping: number;
  angularDamping: number;
  fixedRotation: boolean;
  bullet: boolean;
  canSleep: boolean;
  emitContacts: boolean;
  /** Pose at the end of the previous step, for render interpolation. */
  prevX: number;
  prevY: number;
  prevRotation: number;
  sleepTimer: number;
  sleeping: boolean;
  colliders: ColliderEntry[];
  order: number;
  /** Set when something outside the solver moved the node; next step re-syncs. */
  transformDirty: boolean;
}

interface ContactPointState {
  featureId: number;
  normalImpulse: number;
  tangentImpulse: number;
  /** Lever arms from each body's centre, refreshed per step. */
  rax: number;
  ray: number;
  rbx: number;
  rby: number;
  normalMass: number;
  tangentMass: number;
  bias: number;
  penetration: number;
  x: number;
  y: number;
}

interface ContactPair {
  a: ColliderEntry;
  b: ColliderEntry;
  /** Which convex parts of each collider produced this manifold. */
  partA: number;
  partB: number;
  normalX: number;
  normalY: number;
  points: ContactPointState[];
  friction: number;
  restitution: number;
  /** Relative normal velocity sampled before the solve, for restitution. */
  approachSpeed: number[];
  /**
   * Body positions at the moment the manifold was measured. The position solver
   * needs them to re-derive how deep a contact still is after earlier
   * corrections have moved things — see {@link Physics2DService.solvePositions}.
   */
  prepAx: number;
  prepAy: number;
  prepBx: number;
  prepBy: number;
}

interface JointEntry {
  source: RevoluteJoint2DSource;
  /** The thing hinged TO: the connected body, or the static world. */
  bodyA: BodyEntry;
  /** The body the component sits on — the one that swings. */
  bodyB: BodyEntry;
  /** The pivot in each body's own frame, captured when the joint was bound. */
  localAX: number;
  localAY: number;
  localBX: number;
  localBY: number;
  /** Relative body angle at bind time; limits are measured from it. */
  referenceAngle: number;
  /** World lever arms, refreshed each step. */
  rax: number;
  ray: number;
  rbx: number;
  rby: number;
  /** Inverse of the 2x2 point-constraint mass. */
  massXX: number;
  massXY: number;
  massYY: number;
  angularMass: number;
  /** Accumulated impulses, carried across steps (warm starting). */
  impulseX: number;
  impulseY: number;
  motorImpulse: number;
  lowerImpulse: number;
  upperImpulse: number;
  order: number;
}

/** Signals queued during a step and emitted after it, never mid-iteration. */
interface QueuedSignal {
  node: NodeBase;
  name: string;
  args: unknown[];
}

const DEFAULT_GRAVITY_Y = -1960;
/**
 * Velocity iterations. Eight is the 2D default and is enough *because* two-point
 * manifolds go through the block solver; solved point-by-point instead, a stack
 * needs roughly one iteration per box to propagate the load and an eight-high
 * stack visibly leans over and falls.
 */
const VELOCITY_ITERATIONS = 8;
const POSITION_ITERATIONS = 3;
/** Overlap tolerated before position correction acts, in px. */
const PENETRATION_SLOP = 0.05;
/** Fraction of the remaining overlap corrected per position iteration. */
const BAUMGARTE = 0.2;
/**
 * Ceiling on how far one position iteration may move a pair apart, in px. A body
 * that starts the frame buried (a teleport into a wall, a scene loaded with
 * overlapping colliders) would otherwise be flung out at whatever depth it had.
 */
const MAX_POSITION_CORRECTION = 4;
/** Fraction of a joint's positional error corrected per position iteration. */
const JOINT_POSITION_BIAS = 0.2;
/** Below this approach speed a contact does not bounce, however elastic it is. */
const RESTITUTION_THRESHOLD = 40;
/** Sleep thresholds: px/s and rad/s sustained for `SLEEP_TIME` seconds. */
const SLEEP_LINEAR_THRESHOLD = 4;
const SLEEP_ANGULAR_THRESHOLD = 0.15;
const SLEEP_TIME = 0.5;
/** Segments per capsule cap. Eight keeps the radial error under 2% of the radius. */
const CAPSULE_CAP_SEGMENTS = 8;
/** Broadphase cell size in px — a compromise for the 32-128 px sprites 2D games use. */
const BROADPHASE_CELL = 128;

export class Physics2DService {
  private gravityX = 0;
  private gravityY = DEFAULT_GRAVITY_Y;

  private readonly bodies = new Map<NodeBase, BodyEntry>();
  private readonly colliders = new Map<Collider2DSource, ColliderEntry>();
  /** Colliders with no body of their own or above them: implicit static geometry. */
  private readonly staticBody: BodyEntry;
  private readonly contacts = new Map<string, ContactPair>();
  private readonly joints = new Map<RevoluteJoint2DSource, JointEntry>();
  /** Body pairs a joint has asked the broadphase to ignore; see `collideConnected`. */
  private jointedPairs = new Set<string>();
  /**
   * Pairs touching as of last step, keyed the same way as {@link contacts}.
   *
   * The colliders are stored, not just the key, because the *exit* transition is
   * precisely the case where the pair has left the broadphase and there is no
   * candidate list left to look them up in — reading the exit off this frame's
   * pairs reports enters and silently drops every exit.
   */
  private touching = new Map<string, [ColliderEntry, ColliderEntry]>();
  private readonly signalQueue: QueuedSignal[] = [];
  private orderCounter = 0;

  constructor() {
    this.staticBody = makeStaticWorldBody();
  }

  // --- world configuration ---

  /** Gravity in design px/s^2. Y is up, so a falling world wants a negative y. */
  setGravity(x: number, y: number): void {
    this.gravityX = Number.isFinite(x) ? x : 0;
    this.gravityY = Number.isFinite(y) ? y : DEFAULT_GRAVITY_Y;
  }

  getGravity(): { x: number; y: number } {
    return { x: this.gravityX, y: this.gravityY };
  }

  /** Registered body count (diagnostics, and how `SceneRunner` skips a no-op step). */
  get bodyCount(): number {
    return this.bodies.size;
  }

  get colliderCount(): number {
    return this.colliders.size;
  }

  // --- registration ---

  registerBody(source: PhysicsBody2DSource): void {
    const node = source.node;
    if (!node) {
      return;
    }
    const existing = this.bodies.get(node);
    if (existing) {
      existing.source = source;
      return;
    }
    const transform = readWorldTransform2D(node);
    this.bodies.set(node, {
      node,
      source,
      bodyType: source.getBodyType(),
      x: transform.x,
      y: transform.y,
      rotation: transform.rotation,
      vx: 0,
      vy: 0,
      w: 0,
      forceX: 0,
      forceY: 0,
      torque: 0,
      mass: 1,
      invMass: 1,
      inertia: 1,
      invInertia: 1,
      prevX: transform.x,
      prevY: transform.y,
      prevRotation: transform.rotation,
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      fixedRotation: false,
      bullet: false,
      canSleep: true,
      emitContacts: false,
      sleepTimer: 0,
      sleeping: false,
      colliders: [],
      order: this.orderCounter++,
      transformDirty: false,
    });
    // Colliders registered before their body attach to the world body; rebind.
    this.rebindColliders();
  }

  unregisterBody(source: PhysicsBody2DSource): void {
    const node = source.node;
    if (!node) {
      return;
    }
    this.bodies.delete(node);
    this.rebindColliders();
  }

  registerCollider(source: Collider2DSource): void {
    if (!source.node) {
      return;
    }
    const entry: ColliderEntry = {
      source,
      body: this.staticBody,
      shape: emptyShape(),
      friction: 0.4,
      restitution: 0,
      density: 1,
      sensor: false,
      group: 'default',
      revision: '',
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      order: this.orderCounter++,
    };
    this.colliders.set(source, entry);
    this.rebindColliders();
  }

  unregisterCollider(source: Collider2DSource): void {
    const entry = this.colliders.get(source);
    if (!entry) {
      return;
    }
    this.colliders.delete(source);
    entry.body.colliders = entry.body.colliders.filter(c => c !== entry);
    // Drop contacts that referenced it so a removed collider cannot keep pushing.
    for (const [key, pair] of this.contacts) {
      if (pair.a === entry || pair.b === entry) {
        this.contacts.delete(key);
      }
    }
    for (const [key, pair] of this.touching) {
      if (pair[0] !== entry && pair[1] !== entry) {
        continue;
      }
      // Whatever was resting on (or against) this collider has to wake: the
      // support it went to sleep against is gone. Without this, deleting the
      // ground under a settled body leaves it hanging in the air forever.
      this.wakeBody(pair[0].body);
      this.wakeBody(pair[1].body);
      this.touching.delete(key);
    }
  }

  /**
   * Bind a hinge. The pivot is resolved once, at registration: the authored
   * anchor is a point in the joint node's local space, and both bodies remember
   * where that world point sits in their own frame. Re-resolving it per step
   * would make the joint chase whatever drift the solver left behind instead of
   * correcting it.
   */
  registerJoint(source: RevoluteJoint2DSource): void {
    const node = source.node;
    if (!node || this.joints.has(source)) {
      return;
    }
    const own = this.bodies.get(node);
    if (!own) {
      return; // a hinge needs something to hinge
    }

    // The component's own body is B, not A. Every angular term in the solver is
    // `B relative to A`, so this is what makes the authored surface read the way
    // a designer expects: a positive `motorSpeed` spins THIS node
    // counter-clockwise, and the angle limits are this node's own swing range.
    // With the roles the other way round a flipper set to +600 swings down.
    const connected = source.getConnectedNode();
    const bodyA = (connected ? this.bodies.get(connected) : null) ?? this.staticBody;
    const bodyB = own;

    const anchor = source.getJointAnchor();
    const world = readWorldTransform2D(node);
    const cosA = Math.cos(world.rotation);
    const sinA = Math.sin(world.rotation);
    const anchorWorldX = world.x + anchor.x * cosA - anchor.y * sinA;
    const anchorWorldY = world.y + anchor.x * sinA + anchor.y * cosA;

    const localA = toLocalAnchor(bodyA, anchorWorldX, anchorWorldY);
    const localB = toLocalAnchor(bodyB, anchorWorldX, anchorWorldY);
    this.joints.set(source, {
      source,
      bodyA,
      bodyB,
      localAX: localA.x,
      localAY: localA.y,
      localBX: localB.x,
      localBY: localB.y,
      referenceAngle: bodyB.rotation - bodyA.rotation,
      rax: 0,
      ray: 0,
      rbx: 0,
      rby: 0,
      massXX: 0,
      massXY: 0,
      massYY: 0,
      angularMass: 0,
      impulseX: 0,
      impulseY: 0,
      motorImpulse: 0,
      lowerImpulse: 0,
      upperImpulse: 0,
      order: this.orderCounter++,
    });
    this.refreshJointedPairs();
  }

  unregisterJoint(source: RevoluteJoint2DSource): void {
    this.joints.delete(source);
    this.refreshJointedPairs();
  }

  /** Recompute which body pairs the broadphase must skip. */
  private refreshJointedPairs(): void {
    this.jointedPairs = new Set<string>();
    for (const joint of this.joints.values()) {
      if (!joint.source.getJointConfig().collideConnected) {
        this.jointedPairs.add(bodyPairKey(joint.bodyA, joint.bodyB));
      }
    }
  }

  get jointCount(): number {
    return this.joints.size;
  }

  /** Handle for a node's body, or null when it has none. */
  getBody(node: NodeBase | null | undefined): PhysicsBody2DHandle | null {
    const entry = node ? this.bodies.get(node) : null;
    return entry ? makeHandle(entry) : null;
  }

  // --- the step ---

  /**
   * Advance the world by one fixed step. Called from
   * `SceneRunner.runFixedUpdates` via `SceneService.stepPhysics2D`, so it
   * inherits the runner's GameTime scaling (hitstop freezes physics for free)
   * and its `maxFixedStepsPerFrame` clamp.
   */
  step(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0 || this.colliders.size === 0) {
      return;
    }
    this.syncFromNodes();
    // Snapshot the pose the step starts from; `interpolate` blends from it.
    for (const body of this.bodies.values()) {
      body.prevX = body.x;
      body.prevY = body.y;
      body.prevRotation = body.rotation;
    }
    this.refreshShapes();
    this.integrateVelocities(dt);

    const pairs = this.broadphase();
    this.narrowphase(pairs);

    this.prepareJoints();
    this.warmStart();
    this.warmStartJoints();
    for (let i = 0; i < VELOCITY_ITERATIONS; i++) {
      this.solveJointVelocities(dt);
      this.solveVelocities(dt);
    }

    this.integratePositions(dt);
    this.applyContinuousCollision(dt);

    for (let i = 0; i < POSITION_ITERATIONS; i++) {
      this.solvePositions();
      this.solveJointPositions();
    }

    this.writeBackToNodes();
    this.updateSleep(dt);
    this.flushSignals();
  }

  /**
   * Blend every dynamic body between its pose at the start of the last step and
   * its pose now, and write the result to the nodes.
   *
   * Physics runs at a fixed 1/60 while the display may not: on a 120 Hz screen
   * every second frame otherwise shows the *same* pose, which reads as a regular
   * stutter rather than as smooth motion. `alpha` is the fraction of a step the
   * renderer is past the last one — `SceneRunner` already computes it for the ECS.
   *
   * Nothing else reads the interpolated value: the solver keeps working from
   * `body.x/y`, so this only affects what is drawn, and a body that sleeps or is
   * teleported lands exactly where the solver put it.
   */
  interpolate(alpha: number): void {
    if (!Number.isFinite(alpha) || this.bodies.size === 0) {
      return;
    }
    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    for (const body of this.orderedBodies()) {
      if (body.bodyType !== 'dynamic' || body.sleeping) {
        continue;
      }
      const x = body.x;
      const y = body.y;
      const rotation = body.rotation;
      // Borrow the write-back path by moving the body to the blended pose and
      // restoring it, so parent frames and rotation are handled in one place.
      body.x = body.prevX + (x - body.prevX) * t;
      body.y = body.prevY + (y - body.prevY) * t;
      body.rotation = body.prevRotation + shortestAngle(body.prevRotation, rotation) * t;
      this.writeBodyToNode(body);
      body.x = x;
      body.y = y;
      body.rotation = rotation;
    }
  }

  // --- queries ---

  /** Closest collider hit by the world-space segment, or null. */
  raycast(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    options: Physics2DQueryOptions = {}
  ): Physics2DRaycastHit | null {
    this.refreshShapes();
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) {
      return null;
    }

    let best: Physics2DRaycastHit | null = null;
    let bestT = Infinity;
    for (const entry of this.orderedColliders(options)) {
      const t = raycastShape(entry.shape, x1, y1, dx, dy);
      if (t !== null && t < bestT) {
        bestT = t;
        best = {
          node: entry.source.node as NodeBase,
          group: entry.group,
          x: x1 + dx * t,
          y: y1 + dy * t,
          distance: length * t,
        };
      }
    }
    return best;
  }

  /** Every collider overlapping the world-space circle. */
  overlapCircle(
    x: number,
    y: number,
    radius: number,
    options: Physics2DQueryOptions = {}
  ): NodeBase[] {
    this.refreshShapes();
    const probe: BakedShape = circleShape(0, 0, Math.abs(radius));
    probe.worldCx = x;
    probe.worldCy = y;
    return this.orderedColliders(options)
      .filter(entry => shapesOverlap(probe, entry.shape))
      .map(entry => entry.source.node as NodeBase);
  }

  /** Every collider overlapping the world-space axis-aligned rect. */
  overlapRect(
    cx: number,
    cy: number,
    width: number,
    height: number,
    options: Physics2DQueryOptions = {}
  ): NodeBase[] {
    this.refreshShapes();
    const probe = polygonShape([boxPolygon(Math.abs(width) / 2, Math.abs(height) / 2)]);
    probe.worldParts = probe.parts.map(part =>
      transformPolygon(part, { x: cx, y: cy, rotation: 0, scaleX: 1, scaleY: 1 })
    );
    probe.worldCx = cx;
    probe.worldCy = cy;
    return this.orderedColliders(options)
      .filter(entry => shapesOverlap(probe, entry.shape))
      .map(entry => entry.source.node as NodeBase);
  }

  // --- character movement -----------------------------------------------
  //
  // Godot's CharacterBody2D role, as two methods on the world rather than a
  // node type. A kinematic body moved this way is *driven*: it pushes nothing,
  // is pushed by nothing, and stops exactly where geometry says it should —
  // which is what a platformer or a top-down character wants, and what falls out
  // wrong if you try to build it out of forces.

  /**
   * Move `node`'s body by `(dx, dy)`, stopping at the first thing it hits.
   *
   * Motion is substepped so no substep advances further than half the body's
   * smallest extent — without that a fast character samples past a thin wall and
   * ends up on the far side of it. After each substep the body is pushed back out
   * of anything it overlaps, and the deepest such push is reported as the hit.
   */
  moveAndCollide(
    node: NodeBase | null | undefined,
    dx: number,
    dy: number,
    options: Physics2DQueryOptions = {}
  ): MoveCollide2DResult {
    const empty: MoveCollide2DResult = {
      movedX: 0,
      movedY: 0,
      collided: false,
      normalX: 0,
      normalY: 0,
      collider: null,
    };
    const body = node ? this.bodies.get(node) : null;
    if (!body || !Number.isFinite(dx) || !Number.isFinite(dy)) {
      return empty;
    }

    this.refreshShapes();

    const startX = body.x;
    const startY = body.y;
    const distance = Math.hypot(dx, dy);
    const step = Math.max(1, Math.ceil(distance / Math.max(1, this.bodyStepLimit(body))));

    let collided = false;
    let bestNormalX = 0;
    let bestNormalY = 0;
    let bestDepth = -Infinity;
    let bestCollider: NodeBase | null = null;

    for (let i = 0; i < step; i++) {
      body.x += dx / step;
      body.y += dy / step;
      const hit = this.depenetrate(body, options);
      if (hit) {
        collided = true;
        if (hit.depth > bestDepth) {
          bestDepth = hit.depth;
          bestNormalX = hit.normalX;
          bestNormalY = hit.normalY;
          bestCollider = hit.collider;
        }
      }
    }

    this.writeBodyToNode(body);
    return {
      movedX: body.x - startX,
      movedY: body.y - startY,
      collided,
      normalX: bestNormalX,
      normalY: bestNormalY,
      collider: bestCollider,
    };
  }

  /**
   * Move by `velocity * dt`, sliding along whatever is hit instead of stopping
   * dead, and report what the body is standing on.
   *
   * The returned velocity has the blocked component removed, so the usual game
   * loop is `velocity = phys.moveAndSlide(node, vx, vy, dt).velocity` — a
   * character walking into a wall keeps its along-wall speed, and one landing on
   * the floor loses its fall speed rather than accumulating it forever.
   *
   * Floor / wall / ceiling are classified against `up` exactly as Godot does:
   * a contact whose normal is within `floorMaxAngle` of `up` is floor, within
   * that angle of `-up` is ceiling, anything else is wall.
   */
  moveAndSlide(
    node: NodeBase | null | undefined,
    velocityX: number,
    velocityY: number,
    dt: number,
    options: MoveAndSlide2DOptions = {}
  ): MoveAndSlide2DResult {
    const upX = options.upX ?? 0;
    const upY = options.upY ?? 1;
    const upLength = Math.hypot(upX, upY) || 1;
    const ux = upX / upLength;
    const uy = upY / upLength;
    const floorCos = Math.cos(((options.floorMaxAngle ?? 45) * Math.PI) / 180);
    const maxSlides = Math.max(1, Math.floor(options.maxSlides ?? 4));

    let vx = velocityX;
    let vy = velocityY;
    let remainingX = velocityX * dt;
    let remainingY = velocityY * dt;

    const result: MoveAndSlide2DResult = {
      velocityX: vx,
      velocityY: vy,
      isOnFloor: false,
      isOnWall: false,
      isOnCeiling: false,
      floorNormalX: 0,
      floorNormalY: 0,
      collider: null,
    };

    for (let slide = 0; slide < maxSlides; slide++) {
      if (Math.hypot(remainingX, remainingY) < 1e-6) {
        break;
      }
      const hit = this.moveAndCollide(node, remainingX, remainingY, options);
      if (!hit.collided) {
        break;
      }

      // The normal from `depenetrate` points the way the body was pushed, i.e.
      // out of the surface — which is the direction a floor's normal has to face.
      const nx = hit.normalX;
      const ny = hit.normalY;
      const alignment = nx * ux + ny * uy;
      if (alignment >= floorCos) {
        result.isOnFloor = true;
        result.floorNormalX = nx;
        result.floorNormalY = ny;
      } else if (alignment <= -floorCos) {
        result.isOnCeiling = true;
      } else {
        result.isOnWall = true;
      }
      result.collider = hit.collider;

      // Project the blocked component out of both the leftover motion and the
      // velocity the caller will carry into the next frame.
      remainingX -= hit.movedX;
      remainingY -= hit.movedY;
      const motionDot = remainingX * nx + remainingY * ny;
      if (motionDot < 0) {
        remainingX -= nx * motionDot;
        remainingY -= ny * motionDot;
      }
      const velocityDot = vx * nx + vy * ny;
      if (velocityDot < 0) {
        vx -= nx * velocityDot;
        vy -= ny * velocityDot;
      }
    }

    result.velocityX = vx;
    result.velocityY = vy;
    const body = node ? this.bodies.get(node) : null;
    if (body) {
      body.vx = vx;
      body.vy = vy;
    }
    return result;
  }

  /**
   * How far one substep of {@link moveAndCollide} may advance: half the body's
   * smallest collider extent, so a substep can never skip clean over the thing it
   * should have hit.
   */
  private bodyStepLimit(body: BodyEntry): number {
    let smallest = Infinity;
    for (const collider of body.colliders) {
      if (collider.sensor || collider.shape.kind === 'empty') {
        continue;
      }
      const extent =
        collider.shape.kind === 'circle'
          ? collider.shape.radius * 2
          : Math.min(
              collider.bounds.maxX - collider.bounds.minX,
              collider.bounds.maxY - collider.bounds.minY
            );
      smallest = Math.min(smallest, extent);
    }
    return Number.isFinite(smallest) ? Math.max(1, smallest / 2) : Infinity;
  }

  /**
   * Push `body` out of everything solid it currently overlaps, deepest first.
   * Returns the deepest correction applied, or null when it was already clear.
   */
  private depenetrate(
    body: BodyEntry,
    options: Physics2DQueryOptions
  ): { normalX: number; normalY: number; depth: number; collider: NodeBase | null } | null {
    let best: {
      normalX: number;
      normalY: number;
      depth: number;
      collider: NodeBase | null;
    } | null = null;

    for (let pass = 0; pass < 4; pass++) {
      for (const own of body.colliders) {
        this.refreshColliderWorldShape(own);
      }

      let deepest: {
        normalX: number;
        normalY: number;
        depth: number;
        collider: NodeBase | null;
      } | null = null;

      for (const own of body.colliders) {
        if (own.sensor || own.shape.kind === 'empty') {
          continue;
        }
        for (const other of this.orderedColliders(options)) {
          if (other.body === body || other.shape.kind === 'empty') {
            continue;
          }
          for (const part of collideShapeParts(own.shape, other.shape)) {
            for (const contact of part.manifold.contacts) {
              if (contact.penetration <= PENETRATION_SLOP) {
                continue;
              }
              if (!deepest || contact.penetration > deepest.depth) {
                deepest = {
                  // The manifold normal points own -> other, so backing out of
                  // the overlap means moving along its negation.
                  normalX: -part.manifold.normalX,
                  normalY: -part.manifold.normalY,
                  depth: contact.penetration,
                  collider: other.source.node,
                };
              }
            }
          }
        }
      }

      if (!deepest) {
        break;
      }
      body.x += deepest.normalX * deepest.depth;
      body.y += deepest.normalY * deepest.depth;
      if (!best || deepest.depth > best.depth) {
        best = deepest;
      }
    }

    return best;
  }

  /** Push a body's solved pose onto its node, honouring the parent's frame. */
  private writeBodyToNode(body: BodyEntry): void {
    const node = body.node;
    const parent = node.parentNode;
    if (!parent) {
      node.position.set(body.x, body.y, node.position.z);
      node.rotation.z = body.rotation;
      return;
    }
    const parentTransform = readWorldTransform2D(parent);
    const dx = body.x - parentTransform.x;
    const dy = body.y - parentTransform.y;
    const cos = Math.cos(-parentTransform.rotation);
    const sin = Math.sin(-parentTransform.rotation);
    const sx = parentTransform.scaleX || 1;
    const sy = parentTransform.scaleY || 1;
    node.position.set((dx * cos - dy * sin) / sx, (dx * sin + dy * cos) / sy, node.position.z);
    node.rotation.z = body.rotation - parentTransform.rotation;
  }

  /**
   * The wireframe for the debug overlay, in the layout `PhysicsDebugOverlay`
   * already speaks: three floats per point, two points per segment, plus an RGBA
   * colour per point.
   *
   * Sensors draw green and sleeping bodies dim, because "is that collider even
   * there?" and "why did this stop moving?" are the two questions the overlay
   * exists to answer.
   */
  buildDebugBuffers(): { vertices: Float32Array; colors: Float32Array } {
    this.refreshShapes();
    const vertices: number[] = [];
    const colors: number[] = [];
    for (const entry of this.orderedColliders({ includeSensors: true })) {
      const parts =
        entry.shape.kind === 'circle' ? [circleAsPolygon(entry.shape)] : entry.shape.worldParts;
      const tint = entry.sensor
        ? [0.5, 0.95, 0.4]
        : entry.body.sleeping
          ? [0.45, 0.5, 0.55]
          : [0.12, 0.74, 0.89];
      for (const part of parts) {
        for (let i = 0, j = part.length - 1; i < part.length; j = i++) {
          vertices.push(part[j].x, part[j].y, 0, part[i].x, part[i].y, 0);
          colors.push(tint[0], tint[1], tint[2], 1, tint[0], tint[1], tint[2], 1);
        }
      }
    }
    return { vertices: new Float32Array(vertices), colors: new Float32Array(colors) };
  }

  /** Release every registration. Called when the scene stops. */
  clear(): void {
    this.bodies.clear();
    this.colliders.clear();
    this.contacts.clear();
    this.touching.clear();
    this.joints.clear();
    this.jointedPairs.clear();
    this.signalQueue.length = 0;
    this.staticBody.colliders = [];
  }

  // --- step internals ---

  /**
   * Attach every collider to the nearest ancestor body (Unity's compound-body
   * rule), or to the implicit world body when there is none — which is how a
   * `core:Collider2D` with no `core:PhysicsBody2D` becomes static level geometry
   * with one component and zero scripts.
   */
  private rebindColliders(): void {
    this.staticBody.colliders = [];
    for (const body of this.bodies.values()) {
      body.colliders = [];
    }
    for (const entry of this.colliders.values()) {
      const body = this.findOwningBody(entry.source.node) ?? this.staticBody;
      entry.body = body;
      body.colliders.push(entry);
    }
    for (const body of this.bodies.values()) {
      body.colliders.sort((a, b) => a.order - b.order);
      this.recomputeMass(body);
    }
    this.staticBody.colliders.sort((a, b) => a.order - b.order);
  }

  private findOwningBody(node: NodeBase | null): BodyEntry | null {
    let current: NodeBase | null = node;
    while (current) {
      const body = this.bodies.get(current);
      if (body) {
        return body;
      }
      current = current.parentNode ?? null;
    }
    return null;
  }

  /** Pull authored config and any externally-written transform onto the bodies. */
  private syncFromNodes(): void {
    for (const body of this.bodies.values()) {
      const source = body.source;
      if (source) {
        const config = source.getBodyConfig();
        const nextType = source.getBodyType();
        if (nextType !== body.bodyType) {
          body.bodyType = nextType;
          this.recomputeMass(body);
          body.sleeping = false;
        }
        body.gravityScale = config.gravityScale;
        body.linearDamping = config.linearDamping;
        body.angularDamping = config.angularDamping;
        body.bullet = config.bullet;
        body.canSleep = config.canSleep;
        body.emitContacts = config.emitContacts;
        if (config.fixedRotation !== body.fixedRotation) {
          body.fixedRotation = config.fixedRotation;
          this.recomputeMass(body);
          if (config.fixedRotation) {
            body.w = 0;
          }
        }
      }

      // Static and kinematic bodies are driven by whatever moves their node
      // (a script, an animation clip, a live inspector edit); read them every
      // step so a moving platform actually pushes.
      if (body.bodyType !== 'dynamic' || body.transformDirty) {
        const transform = readWorldTransform2D(body.node);
        if (body.bodyType === 'kinematic' && !body.transformDirty) {
          // Derive the velocity a kinematic body implies, so contacts see it move.
          body.vx = 0;
          body.vy = 0;
        }
        body.x = transform.x;
        body.y = transform.y;
        body.rotation = transform.rotation;
        body.transformDirty = false;
      }
    }
  }

  /** Rebuild baked shapes whose config changed, then refresh world vertices. */
  private refreshShapes(): void {
    for (const entry of this.colliders.values()) {
      const source = entry.source;
      const node = source.node;
      if (!node) {
        continue;
      }

      const revision = source.getColliderRevision();
      if (revision !== entry.revision) {
        entry.revision = revision;
        const material = source.getColliderMaterial();
        entry.friction = material.friction;
        entry.restitution = material.restitution;
        entry.density = material.density;
        entry.sensor = source.isSensor();
        entry.group = source.getColliderGroup();
        entry.shape = this.bakeShape(entry);
        this.recomputeMass(entry.body);
      }

      this.refreshColliderWorldShape(entry);
    }
  }

  /**
   * Lift one collider's baked shape into world space at its body's current pose.
   *
   * Split out of {@link refreshShapes} because character movement moves a single
   * body many times within one call and has to re-test after each nudge; walking
   * every collider in the scene for that would make a slide cost O(world) per
   * substep.
   */
  private refreshColliderWorldShape(entry: ColliderEntry): void {
    const body = entry.body;
    // The collider's own node may sit below the body's node; compose the
    // difference so a compound body's child colliders follow the parent.
    const local = this.colliderLocalTransform(entry);
    const cos = Math.cos(body.rotation);
    const sin = Math.sin(body.rotation);
    const offsetX = local.x * cos - local.y * sin;
    const offsetY = local.x * sin + local.y * cos;
    const worldTransform: ShapeTransform2D = {
      x: body.x + offsetX,
      y: body.y + offsetY,
      rotation: body.rotation + local.rotation,
      scaleX: 1,
      scaleY: 1,
    };

    if (entry.shape.kind === 'circle') {
      const rotated = transformPolygon([{ x: entry.shape.cx, y: entry.shape.cy }], worldTransform);
      entry.shape.worldCx = rotated[0].x;
      entry.shape.worldCy = rotated[0].y;
      entry.bounds = {
        minX: entry.shape.worldCx - entry.shape.radius,
        minY: entry.shape.worldCy - entry.shape.radius,
        maxX: entry.shape.worldCx + entry.shape.radius,
        maxY: entry.shape.worldCy + entry.shape.radius,
      };
      return;
    }

    entry.shape.worldParts = entry.shape.parts.map(part => transformPolygon(part, worldTransform));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const part of entry.shape.worldParts) {
      const bounds = polygonBounds(part);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
    }
    entry.bounds = { minX, minY, maxX, maxY };
    entry.shape.worldCx = (minX + maxX) / 2;
    entry.shape.worldCy = (minY + maxY) / 2;
  }

  /**
   * The collider node's transform relative to its body's node. Zero for the
   * common case where they are the same node; a real offset for compound bodies
   * and for colliders parented under a moving rig.
   */
  private colliderLocalTransform(entry: ColliderEntry): ShapeTransform2D {
    const node = entry.source.node;
    const body = entry.body;
    if (!node || node === body.node) {
      return { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
    }
    const world = readWorldTransform2D(node);
    const dx = world.x - body.x;
    const dy = world.y - body.y;
    const cos = Math.cos(-body.rotation);
    const sin = Math.sin(-body.rotation);
    return {
      x: dx * cos - dy * sin,
      y: dx * sin + dy * cos,
      rotation: world.rotation - body.rotation,
      scaleX: 1,
      scaleY: 1,
    };
  }

  /** Bake a collider's authored shape into body-local convex parts. */
  private bakeShape(entry: ColliderEntry): BakedShape {
    const source = entry.source;
    const node = source.node;
    const size = source.getColliderSize();
    const offset = source.getColliderOffset();
    // World scale is baked in: the solver works in world units, so a node scaled
    // 2x has a collider twice the size, matching what the sprite shows.
    const scale = node ? readWorldTransform2D(node) : { scaleX: 1, scaleY: 1 };
    const sx = Math.abs(scale.scaleX) || 1;
    const sy = Math.abs(scale.scaleY) || 1;

    switch (source.getColliderShape()) {
      case 'circle': {
        // A non-uniformly scaled circle is an ellipse, which this solver has no
        // shape for; take the larger axis so the collider never under-covers.
        return circleShape(offset.x * sx, offset.y * sy, Math.abs(size.radius) * Math.max(sx, sy));
      }
      case 'capsule': {
        // Godot's convention: `height` is the total height including both caps.
        // Routed through `decomposeConvex` like an authored polygon so the
        // winding and cleaning guarantees are the same for every polygon path,
        // not something the stadium builder has to be trusted to get right.
        const parts = decomposeConvex(
          capsulePolygon(
            Math.abs(size.height) * sy,
            Math.abs(size.radius) * Math.max(sx, sy),
            CAPSULE_CAP_SEGMENTS,
            { x: offset.x * sx, y: offset.y * sy }
          )
        );
        return parts.length > 0 ? polygonShape(parts) : emptyShape();
      }
      case 'polygon': {
        const authored = source.getColliderPolygon();
        const scaled = authored.map(p => ({
          x: (p.x + offset.x) * sx,
          y: (p.y + offset.y) * sy,
        }));
        const parts = decomposeConvex(scaled);
        return parts.length > 0 ? polygonShape(parts) : emptyShape();
      }
      default: {
        const hw = (Math.abs(size.width) / 2) * sx;
        const hh = (Math.abs(size.height) / 2) * sy;
        if (hw <= 0 || hh <= 0) {
          return emptyShape();
        }
        return polygonShape([boxPolygon(hw, hh, { x: offset.x * sx, y: offset.y * sy })]);
      }
    }
  }

  /**
   * Mass and rotational inertia from the body's colliders.
   *
   * An authored `mass` overrides the derived one but keeps the *shape's* inertia
   * distribution, scaled to the new mass — otherwise setting a mass would also
   * silently change how readily the body spins.
   */
  private recomputeMass(body: BodyEntry): void {
    if (body.bodyType !== 'dynamic') {
      body.mass = 0;
      body.invMass = 0;
      body.inertia = 0;
      body.invInertia = 0;
      return;
    }

    let mass = 0;
    let inertia = 0;
    for (const collider of body.colliders) {
      if (collider.sensor) {
        continue; // sensors detect; they have no substance
      }
      mass += collider.shape.area * collider.density;
      inertia += collider.shape.inertiaPerDensity * collider.density;
    }

    const authored = body.source?.getBodyConfig().mass ?? 0;
    if (authored > 0) {
      const scale = mass > 0 ? authored / mass : 0;
      inertia = scale > 0 ? inertia * scale : authored;
      mass = authored;
    }
    if (mass <= 0) {
      // A dynamic body with no solid collider still needs to fall.
      mass = 1;
      inertia = 1;
    }

    body.mass = mass;
    body.invMass = 1 / mass;
    body.inertia = body.fixedRotation ? 0 : inertia;
    body.invInertia = body.fixedRotation || inertia <= 0 ? 0 : 1 / inertia;
  }

  private integrateVelocities(dt: number): void {
    for (const body of this.orderedBodies()) {
      if (body.bodyType !== 'dynamic' || body.sleeping) {
        body.forceX = 0;
        body.forceY = 0;
        body.torque = 0;
        continue;
      }
      body.vx += (this.gravityX * body.gravityScale + body.forceX * body.invMass) * dt;
      body.vy += (this.gravityY * body.gravityScale + body.forceY * body.invMass) * dt;
      if (!body.fixedRotation) {
        body.w += body.torque * body.invInertia * dt;
      }
      // Exponential damping, evaluated implicitly so a large damping value slows
      // a body down instead of flipping its velocity.
      body.vx *= 1 / (1 + dt * body.linearDamping);
      body.vy *= 1 / (1 + dt * body.linearDamping);
      body.w *= 1 / (1 + dt * body.angularDamping);
      body.forceX = 0;
      body.forceY = 0;
      body.torque = 0;
    }
  }

  /** Uniform grid: cheap to build, and 2D playables rarely exceed a few hundred colliders. */
  private broadphase(): [ColliderEntry, ColliderEntry][] {
    const grid = new Map<string, ColliderEntry[]>();
    const entries = [...this.colliders.values()].sort((a, b) => a.order - b.order);
    for (const entry of entries) {
      if (!entry.source.enabled || !entry.source.node || entry.shape.kind === 'empty') {
        continue;
      }
      const minCol = Math.floor(entry.bounds.minX / BROADPHASE_CELL);
      const maxCol = Math.floor(entry.bounds.maxX / BROADPHASE_CELL);
      const minRow = Math.floor(entry.bounds.minY / BROADPHASE_CELL);
      const maxRow = Math.floor(entry.bounds.maxY / BROADPHASE_CELL);
      for (let col = minCol; col <= maxCol; col++) {
        for (let row = minRow; row <= maxRow; row++) {
          const key = `${col},${row}`;
          const bucket = grid.get(key);
          if (bucket) {
            bucket.push(entry);
          } else {
            grid.set(key, [entry]);
          }
        }
      }
    }

    const seen = new Set<string>();
    const pairs: [ColliderEntry, ColliderEntry][] = [];
    for (const bucket of grid.values()) {
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const a = bucket[i];
          const b = bucket[j];
          if (!this.shouldCollide(a, b) || !boundsOverlap(a.bounds, b.bounds)) {
            continue;
          }
          const key = pairKey(a, b);
          if (seen.has(key)) {
            continue; // both in more than one cell
          }
          seen.add(key);
          pairs.push(a.order < b.order ? [a, b] : [b, a]);
        }
      }
    }
    // Stable order regardless of Map iteration, so a run reproduces.
    pairs.sort((p, q) => p[0].order - q[0].order || p[1].order - q[1].order);
    return pairs;
  }

  private shouldCollide(a: ColliderEntry, b: ColliderEntry): boolean {
    if (a.body === b.body) {
      return false; // a compound body does not collide with itself
    }
    if (this.jointedPairs.has(bodyPairKey(a.body, b.body))) {
      return false;
    }
    if (a.body.bodyType !== 'dynamic' && b.body.bodyType !== 'dynamic') {
      return false; // two immovable things never resolve
    }
    // Sleeping pairs deliberately stay in the broadphase: dropping them would
    // lose their `touching` entry and fire a spurious exit/enter pair the moment
    // a stack settles. The solve skips them instead (see `isPairAsleep`).
    return true;
  }

  private narrowphase(pairs: readonly [ColliderEntry, ColliderEntry][]): void {
    const nowTouching = new Map<string, [ColliderEntry, ColliderEntry]>();
    const nextContacts = new Map<string, ContactPair>();

    for (const [a, b] of pairs) {
      const partManifolds = collideShapeParts(a.shape, b.shape);
      const key = pairKey(a, b);
      if (partManifolds.length === 0) {
        continue;
      }
      nowTouching.set(key, [a, b]);

      const isSensorPair = a.sensor || b.sensor;
      if (isSensorPair) {
        continue; // detected, never resolved
      }

      for (const partManifold of partManifolds) {
        const manifold = partManifold.manifold;
        const contactKey = key + ':' + partManifold.partA + ':' + partManifold.partB;
        const previous = this.contacts.get(contactKey);
        const pair: ContactPair = {
          a,
          b,
          partA: partManifold.partA,
          partB: partManifold.partB,
          normalX: manifold.normalX,
          normalY: manifold.normalY,
          friction: Math.sqrt(Math.max(0, a.friction) * Math.max(0, b.friction)),
          restitution: Math.max(a.restitution, b.restitution),
          points: manifold.contacts.map(contact => {
            // Warm start: carry the impulse of the point with the same feature id.
            const carried = previous?.points.find(p => p.featureId === contact.featureId);
            return {
              featureId: contact.featureId,
              normalImpulse: carried?.normalImpulse ?? 0,
              tangentImpulse: carried?.tangentImpulse ?? 0,
              rax: 0,
              ray: 0,
              rbx: 0,
              rby: 0,
              normalMass: 0,
              tangentMass: 0,
              bias: 0,
              penetration: contact.penetration,
              x: contact.x,
              y: contact.y,
            };
          }),
          approachSpeed: [],
          prepAx: 0,
          prepAy: 0,
          prepBx: 0,
          prepBy: 0,
        };
        this.prepareContact(pair);
        nextContacts.set(contactKey, pair);
      }
      // A *new* contact wakes both bodies — a sleeping box under a falling one
      // must not sleep through the impact. An existing contact must NOT wake
      // them, or a resting body would be woken by the very contact holding it up
      // and nothing would ever sleep.
      if (!this.touching.has(key)) {
        this.wakeBody(a.body);
        this.wakeBody(b.body);
      }

      // A sleeping body touched by an awake one has to wake, even on an old
      // contact. Bodies in a stack reach the sleep threshold at different times,
      // and an awake box resting on a sleeping one would otherwise push impulses
      // into a body that is frozen in place: the velocity accumulates invisibly
      // and the stack fires apart the moment that body wakes. (Box2D solves this
      // by sleeping whole islands at once; waking on contact is the cheap
      // equivalent and converges in a few steps.)
      this.wakeIfTouchedByAwake(a.body, b.body);
    }

    this.emitTransitions(nowTouching);
    this.contacts.clear();
    for (const [key, pair] of nextContacts) {
      this.contacts.set(key, pair);
    }
    this.touching = nowTouching;
  }

  private emitTransitions(nowTouching: ReadonlyMap<string, [ColliderEntry, ColliderEntry]>): void {
    for (const [key, pair] of nowTouching) {
      if (!this.touching.has(key)) {
        this.queueContactSignal(pair[0], pair[1], true);
      }
    }
    for (const [key, pair] of this.touching) {
      if (nowTouching.has(key)) {
        continue;
      }
      // Both colliders may since have been unregistered (a freed node); their
      // `node` is checked in queueContactSignal, so a stale pair reports nothing
      // rather than throwing.
      this.queueContactSignal(pair[0], pair[1], false);
    }
  }

  /**
   * Sensors always report `body-entered` / `body-exited` (Godot's Area2D role);
   * solid pairs report `contact-started` / `contact-ended` only when the body
   * opted in with `emitContacts`, because most games never read them and a
   * signal per contact per step is the kind of cost that hides.
   */
  private queueContactSignal(a: ColliderEntry, b: ColliderEntry, entered: boolean): void {
    const nodeA = a.source.node;
    const nodeB = b.source.node;
    if (!nodeA || !nodeB) {
      return;
    }

    const sensorPair = a.sensor || b.sensor;
    const name = sensorPair
      ? entered
        ? 'body-entered'
        : 'body-exited'
      : entered
        ? 'contact-started'
        : 'contact-ended';

    const emitFor = (from: ColliderEntry, self: NodeBase, other: NodeBase): void => {
      if (!sensorPair && !from.body.emitContacts) {
        return;
      }
      if (sensorPair && !from.sensor) {
        return; // only the sensor side reports an area event
      }
      this.signalQueue.push({ node: self, name, args: [other] });
    };

    emitFor(a, nodeA, nodeB);
    emitFor(b, nodeB, nodeA);
  }

  /** Per-contact solver constants: lever arms, effective masses, bias, restitution. */
  private prepareContact(pair: ContactPair): void {
    const a = pair.a.body;
    const b = pair.b.body;
    const nx = pair.normalX;
    const ny = pair.normalY;
    const tx = -ny;
    const ty = nx;

    pair.approachSpeed = [];
    pair.prepAx = a.x;
    pair.prepAy = a.y;
    pair.prepBx = b.x;
    pair.prepBy = b.y;
    for (const point of pair.points) {
      point.rax = point.x - a.x;
      point.ray = point.y - a.y;
      point.rbx = point.x - b.x;
      point.rby = point.y - b.y;

      const rnA = point.rax * ny - point.ray * nx;
      const rnB = point.rbx * ny - point.rby * nx;
      const normalMass =
        a.invMass + b.invMass + a.invInertia * rnA * rnA + b.invInertia * rnB * rnB;
      point.normalMass = normalMass > 0 ? 1 / normalMass : 0;

      const rtA = point.rax * ty - point.ray * tx;
      const rtB = point.rbx * ty - point.rby * tx;
      const tangentMass =
        a.invMass + b.invMass + a.invInertia * rtA * rtA + b.invInertia * rtB * rtB;
      point.tangentMass = tangentMass > 0 ? 1 / tangentMass : 0;

      // Restitution only above a threshold: without it a resting body keeps
      // re-bouncing off gravity's per-step velocity and never settles.
      const relative = relativeNormalVelocity(a, b, point, nx, ny);
      pair.approachSpeed.push(relative < -RESTITUTION_THRESHOLD ? relative : 0);
      point.bias = 0;
    }
  }

  private warmStart(): void {
    for (const pair of this.orderedContacts()) {
      if (isPairAsleep(pair)) {
        continue;
      }
      const a = pair.a.body;
      const b = pair.b.body;
      const tx = -pair.normalY;
      const ty = pair.normalX;
      for (const point of pair.points) {
        const px = pair.normalX * point.normalImpulse + tx * point.tangentImpulse;
        const py = pair.normalY * point.normalImpulse + ty * point.tangentImpulse;
        applyImpulseAt(a, -px, -py, point.rax, point.ray);
        applyImpulseAt(b, px, py, point.rbx, point.rby);
      }
    }
  }

  private solveVelocities(dt: number): void {
    for (const pair of this.orderedContacts()) {
      if (isPairAsleep(pair)) {
        continue;
      }
      const a = pair.a.body;
      const b = pair.b.body;
      const nx = pair.normalX;
      const ny = pair.normalY;
      const tx = -ny;
      const ty = nx;

      // Friction first for every point, clamped against the normal impulse
      // accumulated so far (Coulomb). This is the usual ordering and behaves
      // better for stacks than interleaving the two constraints.
      for (const point of pair.points) {
        const relativeTangent = relativeVelocityAlong(a, b, point, tx, ty);
        let tangentImpulse = -relativeTangent * point.tangentMass;
        const maxFriction = pair.friction * point.normalImpulse;
        const newTangent = clamp(point.tangentImpulse + tangentImpulse, -maxFriction, maxFriction);
        tangentImpulse = newTangent - point.tangentImpulse;
        point.tangentImpulse = newTangent;
        applyImpulseAt(a, -tx * tangentImpulse, -ty * tangentImpulse, point.rax, point.ray);
        applyImpulseAt(b, tx * tangentImpulse, ty * tangentImpulse, point.rbx, point.rby);
      }

      if (pair.points.length === 2 && this.solveNormalBlock(pair, dt)) {
        continue;
      }
      for (let i = 0; i < pair.points.length; i++) {
        this.solveNormalPoint(pair, pair.points[i], normalTarget(pair, i, dt));
      }
    }
  }

  /** One point's normal constraint, accumulated and clamped non-negative. */
  private solveNormalPoint(pair: ContactPair, point: ContactPointState, target: number): void {
    const a = pair.a.body;
    const b = pair.b.body;
    const nx = pair.normalX;
    const ny = pair.normalY;
    const relativeNormal = relativeNormalVelocity(a, b, point, nx, ny);
    let normalImpulse = -(relativeNormal - target) * point.normalMass;
    // Accumulated clamp: the total impulse stays non-negative, so a contact can
    // never pull two bodies together.
    const newNormal = Math.max(0, point.normalImpulse + normalImpulse);
    normalImpulse = newNormal - point.normalImpulse;
    point.normalImpulse = newNormal;
    applyImpulseAt(a, -nx * normalImpulse, -ny * normalImpulse, point.rax, point.ray);
    applyImpulseAt(b, nx * normalImpulse, ny * normalImpulse, point.rbx, point.rby);
  }

  /**
   * Solve BOTH points of a two-point manifold at once (Box2D's block solver).
   *
   * Solving them one after the other is what makes a tall stack lean: the first
   * point is over-satisfied, the second corrects, and the leftover torque is
   * always signed the same way, so the bias accumulates upwards through the
   * stack until it topples. Measured before this existed, an eight-box stack
   * placed exactly at rest fell over within five seconds and needed ~30
   * iterations to stand; with it, eight iterations hold it.
   *
   * The 2x2 constraint is a small LCP; the four cases below are its complete
   * enumeration (both points pushing, either one alone, neither). Returns false
   * when the system is too ill-conditioned to trust, and the caller falls back to
   * the point-by-point solve.
   */
  private solveNormalBlock(pair: ContactPair, dt: number): boolean {
    const a = pair.a.body;
    const b = pair.b.body;
    const [p1, p2] = pair.points;
    const nx = pair.normalX;
    const ny = pair.normalY;

    const rn1A = p1.rax * ny - p1.ray * nx;
    const rn1B = p1.rbx * ny - p1.rby * nx;
    const rn2A = p2.rax * ny - p2.ray * nx;
    const rn2B = p2.rbx * ny - p2.rby * nx;

    const invMass = a.invMass + b.invMass;
    const k11 = invMass + a.invInertia * rn1A * rn1A + b.invInertia * rn1B * rn1B;
    const k22 = invMass + a.invInertia * rn2A * rn2A + b.invInertia * rn2B * rn2B;
    const k12 = invMass + a.invInertia * rn1A * rn2A + b.invInertia * rn1B * rn2B;

    // Box2D's conditioning guard: a near-parallel pair makes the 2x2 inverse
    // numerically meaningless, and a wrong impulse is worse than a slow one.
    const determinant = k11 * k22 - k12 * k12;
    if (!(k11 * k11 < 1000 * determinant) || determinant === 0) {
      return false;
    }

    const a1 = p1.normalImpulse;
    const a2 = p2.normalImpulse;
    // Velocity error with the accumulated impulses removed, so the cases below
    // solve for the TOTAL impulse rather than an increment.
    let b1 = relativeNormalVelocity(a, b, p1, nx, ny) - normalTarget(pair, 0, dt);
    let b2 = relativeNormalVelocity(a, b, p2, nx, ny) - normalTarget(pair, 1, dt);
    b1 -= k11 * a1 + k12 * a2;
    b2 -= k12 * a1 + k22 * a2;

    const candidates: [number, number][] = [
      // 1: both points pushing.
      [(-k22 * b1 + k12 * b2) / determinant, (k12 * b1 - k11 * b2) / determinant],
      // 2: only the first.
      [-b1 / k11, 0],
      // 3: only the second.
      [0, -b2 / k22],
      // 4: neither — the pair is separating.
      [0, 0],
    ];

    for (let i = 0; i < candidates.length; i++) {
      const [x1, x2] = candidates[i];
      if (x1 < 0 || x2 < 0) {
        continue;
      }
      // The inactive point must be separating, or this case is not the solution.
      if (i === 1 && k12 * x1 + b2 < 0) {
        continue;
      }
      if (i === 2 && k12 * x2 + b1 < 0) {
        continue;
      }
      if (i === 3 && (b1 < 0 || b2 < 0)) {
        continue;
      }

      const d1 = x1 - a1;
      const d2 = x2 - a2;
      applyImpulseAt(a, -nx * d1, -ny * d1, p1.rax, p1.ray);
      applyImpulseAt(b, nx * d1, ny * d1, p1.rbx, p1.rby);
      applyImpulseAt(a, -nx * d2, -ny * d2, p2.rax, p2.ray);
      applyImpulseAt(b, nx * d2, ny * d2, p2.rbx, p2.rby);
      p1.normalImpulse = x1;
      p2.normalImpulse = x2;
      return true;
    }

    return false;
  }

  private orderedJoints(): JointEntry[] {
    return [...this.joints.values()].sort((a, b) => a.order - b.order);
  }

  /** Per-step joint constants: world lever arms and the effective masses. */
  private prepareJoints(): void {
    for (const joint of this.orderedJoints()) {
      const a = joint.bodyA;
      const b = joint.bodyB;
      const cosA = Math.cos(a.rotation);
      const sinA = Math.sin(a.rotation);
      const cosB = Math.cos(b.rotation);
      const sinB = Math.sin(b.rotation);

      joint.rax = joint.localAX * cosA - joint.localAY * sinA;
      joint.ray = joint.localAX * sinA + joint.localAY * cosA;
      joint.rbx = joint.localBX * cosB - joint.localBY * sinB;
      joint.rby = joint.localBX * sinB + joint.localBY * cosB;

      // 2x2 effective mass of the point constraint, then its inverse.
      const mA = a.invMass;
      const mB = b.invMass;
      const iA = a.invInertia;
      const iB = b.invInertia;
      const k11 = mA + mB + iA * joint.ray * joint.ray + iB * joint.rby * joint.rby;
      const k12 = -iA * joint.rax * joint.ray - iB * joint.rbx * joint.rby;
      const k22 = mA + mB + iA * joint.rax * joint.rax + iB * joint.rbx * joint.rbx;
      const determinant = k11 * k22 - k12 * k12;
      if (Math.abs(determinant) > 1e-12) {
        joint.massXX = k22 / determinant;
        joint.massXY = -k12 / determinant;
        joint.massYY = k11 / determinant;
      } else {
        joint.massXX = 0;
        joint.massXY = 0;
        joint.massYY = 0;
      }

      const angularMass = iA + iB;
      joint.angularMass = angularMass > 0 ? 1 / angularMass : 0;

      // A body driven by a motor must not doze off mid-swing.
      const config = joint.source.getJointConfig();
      this.syncJointedPair(joint, config.collideConnected);
      if (config.motorEnabled && config.motorSpeed !== 0) {
        this.wakeBody(a);
        this.wakeBody(b);
      }
    }
  }

  /** Keep the broadphase skip-set in step with a live `collideConnected` edit. */
  private syncJointedPair(joint: JointEntry, collideConnected: boolean): void {
    const key = bodyPairKey(joint.bodyA, joint.bodyB);
    if (collideConnected) {
      this.jointedPairs.delete(key);
    } else {
      this.jointedPairs.add(key);
    }
  }

  private warmStartJoints(): void {
    for (const joint of this.orderedJoints()) {
      const a = joint.bodyA;
      const b = joint.bodyB;
      const angular = joint.motorImpulse + joint.lowerImpulse - joint.upperImpulse;
      applyImpulseAt(a, -joint.impulseX, -joint.impulseY, joint.rax, joint.ray);
      applyImpulseAt(b, joint.impulseX, joint.impulseY, joint.rbx, joint.rby);
      applyAngularImpulse(a, -angular);
      applyAngularImpulse(b, angular);
    }
  }

  /**
   * Motor, then limits, then the pivot itself.
   *
   * The order matters: the point constraint is the one that must hold exactly (a
   * hinge that comes apart is not a hinge), so it is solved last and gets the
   * final say over whatever the motor and limits asked for.
   */
  private solveJointVelocities(dt: number): void {
    for (const joint of this.orderedJoints()) {
      const a = joint.bodyA;
      const b = joint.bodyB;
      if (!joint.source.enabled) {
        continue;
      }
      const config = joint.source.getJointConfig();

      if (config.motorEnabled && joint.angularMass > 0) {
        const error = b.w - a.w - config.motorSpeed;
        let impulse = -joint.angularMass * error;
        const maxImpulse = config.maxMotorTorque * dt;
        const total = clamp(joint.motorImpulse + impulse, -maxImpulse, maxImpulse);
        impulse = total - joint.motorImpulse;
        joint.motorImpulse = total;
        applyAngularImpulse(a, -impulse);
        applyAngularImpulse(b, impulse);
      } else {
        joint.motorImpulse = 0;
      }

      if (config.limitEnabled && joint.angularMass > 0) {
        const angle = b.rotation - a.rotation - joint.referenceAngle;
        // Each limit is one-sided, and what makes it so is the accumulated
        // clamp, not the bias: while the joint is inside its range the bias term
        // asks for a large impulse, the running total clamps to zero, and the
        // applied increment is therefore nothing. The `max(C, 0) / dt` term is
        // speculative — it lets the joint approach the stop only fast enough to
        // reach it exactly this step, which is what stops a fast swing from
        // overshooting and being yanked back.
        {
          const c = angle - config.lowerAngle;
          let impulse = -joint.angularMass * (b.w - a.w + Math.max(c, 0) / dt);
          const total = Math.max(joint.lowerImpulse + impulse, 0);
          impulse = total - joint.lowerImpulse;
          joint.lowerImpulse = total;
          applyAngularImpulse(a, -impulse);
          applyAngularImpulse(b, impulse);
        }
        {
          const c = config.upperAngle - angle;
          let impulse = -joint.angularMass * (a.w - b.w + Math.max(c, 0) / dt);
          const total = Math.max(joint.upperImpulse + impulse, 0);
          impulse = total - joint.upperImpulse;
          joint.upperImpulse = total;
          applyAngularImpulse(a, impulse);
          applyAngularImpulse(b, -impulse);
        }
      } else {
        joint.lowerImpulse = 0;
        joint.upperImpulse = 0;
      }

      // Point constraint: drive the relative velocity at the pivot to zero.
      const vax = a.vx - a.w * joint.ray;
      const vay = a.vy + a.w * joint.rax;
      const vbx = b.vx - b.w * joint.rby;
      const vby = b.vy + b.w * joint.rbx;
      const cdotX = vbx - vax;
      const cdotY = vby - vay;
      const impulseX = -(joint.massXX * cdotX + joint.massXY * cdotY);
      const impulseY = -(joint.massXY * cdotX + joint.massYY * cdotY);
      joint.impulseX += impulseX;
      joint.impulseY += impulseY;
      applyImpulseAt(a, -impulseX, -impulseY, joint.rax, joint.ray);
      applyImpulseAt(b, impulseX, impulseY, joint.rbx, joint.rby);
    }
  }

  /**
   * Pull the two anchor points back together.
   *
   * Velocity-only hinges drift: every step leaves a little positional error that
   * the next step's velocity solve has no term for, and over a few seconds a
   * flipper visibly walks off its pivot.
   */
  private solveJointPositions(): void {
    for (const joint of this.orderedJoints()) {
      const a = joint.bodyA;
      const b = joint.bodyB;
      const totalInvMass = a.invMass + b.invMass;
      if (totalInvMass <= 0) {
        continue;
      }

      const cosA = Math.cos(a.rotation);
      const sinA = Math.sin(a.rotation);
      const cosB = Math.cos(b.rotation);
      const sinB = Math.sin(b.rotation);
      const ax = a.x + joint.localAX * cosA - joint.localAY * sinA;
      const ay = a.y + joint.localAX * sinA + joint.localAY * cosA;
      const bx = b.x + joint.localBX * cosB - joint.localBY * sinB;
      const by = b.y + joint.localBX * sinB + joint.localBY * cosB;

      const errorX = bx - ax;
      const errorY = by - ay;
      const error = Math.hypot(errorX, errorY);
      if (error < PENETRATION_SLOP) {
        continue;
      }

      const correction = Math.min(error, MAX_POSITION_CORRECTION) * JOINT_POSITION_BIAS;
      const nx = errorX / error;
      const ny = errorY / error;
      a.x += (nx * correction * a.invMass) / totalInvMass;
      a.y += (ny * correction * a.invMass) / totalInvMass;
      b.x -= (nx * correction * b.invMass) / totalInvMass;
      b.y -= (ny * correction * b.invMass) / totalInvMass;
    }
  }

  private integratePositions(dt: number): void {
    for (const body of this.orderedBodies()) {
      if (body.bodyType !== 'dynamic' || body.sleeping) {
        continue;
      }
      body.x += body.vx * dt;
      body.y += body.vy * dt;
      if (!body.fixedRotation) {
        body.rotation += body.w * dt;
      }
    }
  }

  /**
   * Push `bullet` bodies back to their first touch this step.
   *
   * Only circle-shaped bullets against static geometry are swept — that is the
   * pinball/projectile case the flag exists for, and a general swept solve for
   * every pair is a different (much larger) piece of engineering.
   */
  private applyContinuousCollision(dt: number): void {
    for (const body of this.orderedBodies()) {
      if (body.bodyType !== 'dynamic' || !body.bullet || body.sleeping) {
        continue;
      }
      const dx = body.vx * dt;
      const dy = body.vy * dt;
      const travel = Math.hypot(dx, dy);
      const collider = body.colliders.find(c => !c.sensor && c.shape.kind === 'circle');
      if (!collider || travel < collider.shape.radius) {
        continue; // a step shorter than the ball cannot tunnel
      }

      const startX = body.x - dx;
      const startY = body.y - dy;
      let earliest: number | null = null;
      for (const other of this.colliders.values()) {
        if (other.body === body || other.sensor || other.body.bodyType === 'dynamic') {
          continue;
        }
        for (const part of other.shape.worldParts) {
          const t = sweepCircleAgainstPolygon(startX, startY, dx, dy, collider.shape.radius, part);
          if (t !== null && (earliest === null || t < earliest)) {
            earliest = t;
          }
        }
      }

      if (earliest !== null && earliest < 1) {
        // Stop just short of the surface; the next step's discrete solve gives
        // it the bounce, with the correct normal and restitution.
        body.x = startX + dx * earliest;
        body.y = startY + dy * earliest;
      }
    }
  }

  /**
   * Non-linear Gauss-Seidel position correction: push overlapping bodies apart
   * without touching their velocities.
   *
   * The separation is **re-derived from the current positions on every
   * iteration**, not reused from the manifold. That is not a refinement, it is
   * what makes a stack work: correcting the box-on-box contact moves the lower
   * box down, so by the time the same iteration reaches the floor contact the
   * measured overlap is already wrong. Applying the stale value three times over
   * pumped a four-box stack apart in under a second — the lower box swung
   * between y = 16 and y = 0 with a growing amplitude until the stack scattered.
   *
   * Since this phase only translates bodies (rotations are left alone), the
   * current separation is the measured one plus how far the two bodies have
   * moved along the normal since it was measured.
   */
  private solvePositions(): void {
    for (const pair of this.orderedContacts()) {
      if (isPairAsleep(pair)) {
        continue;
      }
      const a = pair.a.body;
      const b = pair.b.body;
      const totalInvMass = a.invMass + b.invMass;
      if (totalInvMass <= 0) {
        continue;
      }
      const driftX = b.x - pair.prepBx - (a.x - pair.prepAx);
      const driftY = b.y - pair.prepBy - (a.y - pair.prepAy);
      const drift = driftX * pair.normalX + driftY * pair.normalY;

      for (const point of pair.points) {
        const overlap = point.penetration - drift;
        const correction = Math.min(
          (Math.max(overlap - PENETRATION_SLOP, 0) * BAUMGARTE) / totalInvMass,
          MAX_POSITION_CORRECTION / totalInvMass
        );
        if (correction <= 0) {
          continue;
        }
        a.x -= pair.normalX * correction * a.invMass;
        a.y -= pair.normalY * correction * a.invMass;
        b.x += pair.normalX * correction * b.invMass;
        b.y += pair.normalY * correction * b.invMass;
      }
    }
  }

  /**
   * Put whole contact **islands** to sleep, never individual bodies.
   *
   * This is not an optimization detail, it is a correctness requirement. A body
   * that sleeps stops integrating but still takes part in its neighbours'
   * contacts; if the box under a stack sleeps one step before the box above it,
   * the awake box solves against a partner that cannot move, and the asymmetry
   * injects a little energy every step. Measured on a three-box stack: box 0
   * slept at step 31, and by step 60 the stack was oscillating at 160 px/s and
   * diverging. Islands remove the asymmetry by construction — every body a
   * sleeper touches is asleep too.
   *
   * Islands are rebuilt each step by union-find over the current contacts, which
   * is cheap at 2D-playable scale and needs no persistent island bookkeeping.
   */
  private updateSleep(dt: number): void {
    const dynamicBodies = this.orderedBodies().filter(body => body.bodyType === 'dynamic');
    if (dynamicBodies.length === 0) {
      return;
    }

    const parent = new Map<BodyEntry, BodyEntry>();
    for (const body of dynamicBodies) {
      parent.set(body, body);
    }
    const find = (body: BodyEntry): BodyEntry => {
      let root = body;
      while (parent.get(root) !== root) {
        root = parent.get(root) as BodyEntry;
      }
      // Path compression, so a long stack does not walk the chain every step.
      let cursor = body;
      while (parent.get(cursor) !== root) {
        const next = parent.get(cursor) as BodyEntry;
        parent.set(cursor, root);
        cursor = next;
      }
      return root;
    };
    for (const pair of this.contacts.values()) {
      const a = pair.a.body;
      const b = pair.b.body;
      if (a.bodyType !== 'dynamic' || b.bodyType !== 'dynamic') {
        continue; // a static neighbour never joins an island
      }
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) {
        parent.set(rootA, rootB);
      }
    }

    const islands = new Map<BodyEntry, BodyEntry[]>();
    for (const body of dynamicBodies) {
      const root = find(body);
      const island = islands.get(root);
      if (island) {
        island.push(body);
      } else {
        islands.set(root, [body]);
      }
    }

    for (const island of islands.values()) {
      const canSleep = island.every(body => body.canSleep);
      const allSlow =
        canSleep &&
        island.every(
          body =>
            Math.hypot(body.vx, body.vy) < SLEEP_LINEAR_THRESHOLD &&
            Math.abs(body.w) < SLEEP_ANGULAR_THRESHOLD
        );

      if (!allSlow) {
        for (const body of island) {
          body.sleepTimer = 0;
          body.sleeping = false;
        }
        continue;
      }

      // The island is only as rested as its most recently disturbed member.
      let minTimer = Infinity;
      for (const body of island) {
        body.sleepTimer += dt;
        minTimer = Math.min(minTimer, body.sleepTimer);
      }
      if (minTimer < SLEEP_TIME) {
        continue;
      }
      for (const body of island) {
        body.sleeping = true;
        body.vx = 0;
        body.vy = 0;
        body.w = 0;
      }
    }
  }

  /** Wake the sleeping side of a pair whose other side is awake and dynamic. */
  private wakeIfTouchedByAwake(a: BodyEntry, b: BodyEntry): void {
    const aAwake = a.bodyType === 'dynamic' && !a.sleeping;
    const bAwake = b.bodyType === 'dynamic' && !b.sleeping;
    if (aAwake && b.sleeping) {
      this.wakeBody(b);
    }
    if (bAwake && a.sleeping) {
      this.wakeBody(a);
    }
  }

  private wakeBody(body: BodyEntry): void {
    if (body.bodyType !== 'dynamic') {
      return;
    }
    body.sleeping = false;
    body.sleepTimer = 0;
  }

  /**
   * Write solved poses back onto the nodes.
   *
   * Play mode runs an isolated clone of the scene, so this never touches the
   * authored graph, undo/redo or collab — the same contract every play-mode
   * script write already has.
   */
  private writeBackToNodes(): void {
    for (const body of this.orderedBodies()) {
      if (body.bodyType !== 'dynamic' || body.sleeping) {
        continue;
      }
      this.writeBodyToNode(body);
    }
  }

  private flushSignals(): void {
    if (this.signalQueue.length === 0) {
      return;
    }
    const queued = this.signalQueue.splice(0, this.signalQueue.length);
    for (const entry of queued) {
      entry.node.emit(entry.name, ...entry.args);
    }
  }

  private orderedBodies(): BodyEntry[] {
    return [...this.bodies.values()].sort((a, b) => a.order - b.order);
  }

  private orderedContacts(): ContactPair[] {
    return [...this.contacts.values()].sort(
      (p, q) =>
        p.a.order - q.a.order || p.b.order - q.b.order || p.partA - q.partA || p.partB - q.partB
    );
  }

  private orderedColliders(options: Physics2DQueryOptions): ColliderEntry[] {
    return [...this.colliders.values()]
      .filter(entry => {
        if (!entry.source.enabled || !entry.source.node || entry.shape.kind === 'empty') {
          return false;
        }
        if (!options.includeSensors && entry.sensor) {
          return false;
        }
        return options.group === undefined || entry.group === options.group;
      })
      .sort((a, b) => a.order - b.order);
  }
}

// --- free helpers -----------------------------------------------------------

function makeStaticWorldBody(): BodyEntry {
  return {
    node: null as unknown as NodeBase,
    source: null,
    bodyType: 'static',
    x: 0,
    y: 0,
    rotation: 0,
    vx: 0,
    vy: 0,
    w: 0,
    forceX: 0,
    forceY: 0,
    torque: 0,
    mass: 0,
    invMass: 0,
    inertia: 0,
    invInertia: 0,
    prevX: 0,
    prevY: 0,
    prevRotation: 0,
    gravityScale: 0,
    linearDamping: 0,
    angularDamping: 0,
    fixedRotation: true,
    bullet: false,
    canSleep: false,
    emitContacts: false,
    sleepTimer: 0,
    sleeping: false,
    colliders: [],
    order: -1,
    transformDirty: false,
  };
}

/**
 * The implicit world body sits at the origin with no rotation, so a collider
 * belonging to it composes its own world transform directly — which is exactly
 * what `colliderLocalTransform` computes against a zero body.
 */
function emptyShape(): BakedShape {
  return {
    kind: 'empty',
    cx: 0,
    cy: 0,
    radius: 0,
    parts: [],
    worldParts: [],
    worldCx: 0,
    worldCy: 0,
    area: 0,
    inertiaPerDensity: 0,
    centroidX: 0,
    centroidY: 0,
  };
}

function circleShape(cx: number, cy: number, radius: number): BakedShape {
  const area = Math.PI * radius * radius;
  return {
    kind: 'circle',
    cx,
    cy,
    radius,
    parts: [],
    worldParts: [],
    worldCx: cx,
    worldCy: cy,
    area,
    // Disc about its centre, plus the parallel-axis shift to the body origin.
    inertiaPerDensity: area * (0.5 * radius * radius + cx * cx + cy * cy),
    centroidX: cx,
    centroidY: cy,
  };
}

function polygonShape(parts: Point2D[][]): BakedShape {
  let area = 0;
  let inertia = 0;
  let cxSum = 0;
  let cySum = 0;
  for (const part of parts) {
    const partArea = polygonArea(part);
    const centroid = polygonCentroid(part);
    area += partArea;
    cxSum += centroid.x * partArea;
    cySum += centroid.y * partArea;
    inertia += polygonInertiaAboutOrigin(part);
  }
  return {
    kind: 'polygon',
    cx: 0,
    cy: 0,
    radius: 0,
    parts,
    worldParts: parts.map(part => part.map(p => ({ x: p.x, y: p.y }))),
    worldCx: 0,
    worldCy: 0,
    area,
    inertiaPerDensity: inertia,
    centroidX: area > 0 ? cxSum / area : 0,
    centroidY: area > 0 ? cySum / area : 0,
  };
}

/** Second moment of area of a simple polygon about the origin, per unit density. */
function polygonInertiaAboutOrigin(points: readonly Point2D[]): number {
  let numerator = 0;
  let denominator = 0;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = points[j];
    const b = points[i];
    const cross = Math.abs(a.x * b.y - b.x * a.y);
    numerator += cross * (a.x * a.x + a.x * b.x + b.x * b.x + a.y * a.y + a.y * b.y + b.y * b.y);
    denominator += cross;
  }
  return denominator > 0 ? numerator / 12 : 0;
}

/** One convex-part pair's manifold, tagged with which parts produced it. */
interface PartManifold {
  manifold: Manifold2D;
  partA: number;
  partB: number;
}

/**
 * Every convex-part manifold between two colliders.
 *
 * A concave collider is several convex pieces and routinely touches on more than
 * one at once - a U resting on both its legs is the whole point of authoring a
 * concave shape. Returning only the deepest would make the contact identity flip
 * between legs from step to step, which resets warm starting and leaves the shape
 * visibly buzzing on the floor.
 *
 * The cost of admitting them all is the classic **internal-edge** artifact: the
 * seam where two decomposed parts meet is not a real surface, and a body sliding
 * across it can catch on the seam's normal. {@link isInternalEdgeContact} filters
 * those out by dropping any manifold whose every contact point lies inside
 * another part of the same collider - a point strictly inside the shape's own
 * volume cannot be on its boundary, so it can only be a seam.
 */
function collideShapeParts(a: BakedShape, b: BakedShape): PartManifold[] {
  const out: PartManifold[] = [];

  if (a.kind === 'circle' && b.kind === 'circle') {
    const manifold = collideCircles(a.worldCx, a.worldCy, a.radius, b.worldCx, b.worldCy, b.radius);
    if (manifold) {
      out.push({ manifold, partA: 0, partB: 0 });
    }
    return out;
  }

  if (a.kind === 'circle') {
    b.worldParts.forEach((part, partB) => {
      const manifold = collideCirclePolygon(a.worldCx, a.worldCy, a.radius, part);
      if (manifold && !isInternalEdgeContact(manifold, b, partB)) {
        out.push({ manifold, partA: 0, partB });
      }
    });
    return out;
  }

  if (b.kind === 'circle') {
    a.worldParts.forEach((part, partA) => {
      const manifold = collideCirclePolygon(b.worldCx, b.worldCy, b.radius, part);
      if (manifold && !isInternalEdgeContact(manifold, a, partA)) {
        // The helper answers circle-to-polygon; here the circle is B.
        out.push({
          manifold: { ...manifold, normalX: -manifold.normalX, normalY: -manifold.normalY },
          partA,
          partB: 0,
        });
      }
    });
    return out;
  }

  a.worldParts.forEach((partA, indexA) => {
    b.worldParts.forEach((partB, indexB) => {
      const manifold = collidePolygons(partA, partB);
      if (
        manifold &&
        !isInternalEdgeContact(manifold, a, indexA) &&
        !isInternalEdgeContact(manifold, b, indexB)
      ) {
        out.push({ manifold, partA: indexA, partB: indexB });
      }
    });
  });
  return out;
}

/**
 * True when every contact point sits inside a *different* part of the same
 * decomposed collider - i.e. the manifold was generated against a seam between
 * two convex pieces rather than against the shape's real boundary.
 */
function isInternalEdgeContact(
  manifold: Manifold2D,
  shape: BakedShape,
  partIndex: number
): boolean {
  if (shape.worldParts.length < 2) {
    return false;
  }
  return manifold.contacts.every(contact => {
    for (let i = 0; i < shape.worldParts.length; i++) {
      if (i === partIndex) {
        continue;
      }
      if (pointInPolygon(contact.x, contact.y, shape.worldParts[i])) {
        return true;
      }
    }
    return false;
  });
}

function shapesOverlap(a: BakedShape, b: BakedShape): boolean {
  return collideShapeParts(a, b).length > 0;
}

function raycastShape(
  shape: BakedShape,
  ox: number,
  oy: number,
  dx: number,
  dy: number
): number | null {
  if (shape.kind === 'circle') {
    // A zero-radius sweep is a ray.
    return sweepCircleAgainstPolygon(ox, oy, dx, dy, 0, circleAsPolygon(shape));
  }
  let best: number | null = null;
  for (const part of shape.worldParts) {
    const t = sweepCircleAgainstPolygon(ox, oy, dx, dy, 0, part);
    if (t !== null && (best === null || t < best)) {
      best = t;
    }
  }
  return best;
}

/** A circle collider as a polygon, for the query paths that only speak polygons. */
function circleAsPolygon(shape: BakedShape): Point2D[] {
  const segments = 16;
  const out: Point2D[] = new Array(segments);
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    out[i] = {
      x: shape.worldCx + Math.cos(angle) * shape.radius,
      y: shape.worldCy + Math.sin(angle) * shape.radius,
    };
  }
  return out;
}

/**
 * The normal velocity a contact point is driven towards.
 *
 * A *speculative* contact (see CONTACT_MARGIN) is not touching yet, so it must
 * not be pushed apart — it may approach, but only fast enough to close the
 * remaining gap in exactly this step. A penetrating contact instead targets the
 * restitution bounce sampled before the solve.
 */
function normalTarget(pair: ContactPair, index: number, dt: number): number {
  const separation = -pair.points[index].penetration;
  return separation > 0 ? -separation / dt : -pair.restitution * pair.approachSpeed[index];
}

/** Both sides asleep (or immovable): the pair contributes nothing to a solve. */
function isPairAsleep(pair: ContactPair): boolean {
  const a = pair.a.body;
  const b = pair.b.body;
  const aInert = a.bodyType !== 'dynamic' || a.sleeping;
  const bInert = b.bodyType !== 'dynamic' || b.sleeping;
  return aInert && bInert;
}

function boundsOverlap(a: Bounds2D, b: Bounds2D): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Stable identity for an unordered pair of bodies. */
function bodyPairKey(a: BodyEntry, b: BodyEntry): string {
  return a.order < b.order ? `${a.order}/${b.order}` : `${b.order}/${a.order}`;
}

function pairKey(a: ColliderEntry, b: ColliderEntry): string {
  return a.order < b.order ? `${a.order}:${b.order}` : `${b.order}:${a.order}`;
}

function relativeVelocityAlong(
  a: BodyEntry,
  b: BodyEntry,
  point: ContactPointState,
  dx: number,
  dy: number
): number {
  const vax = a.vx - a.w * point.ray;
  const vay = a.vy + a.w * point.rax;
  const vbx = b.vx - b.w * point.rby;
  const vby = b.vy + b.w * point.rbx;
  return (vbx - vax) * dx + (vby - vay) * dy;
}

function relativeNormalVelocity(
  a: BodyEntry,
  b: BodyEntry,
  point: ContactPointState,
  nx: number,
  ny: number
): number {
  return relativeVelocityAlong(a, b, point, nx, ny);
}

function applyImpulseAt(body: BodyEntry, ix: number, iy: number, rx: number, ry: number): void {
  // A sleeping body does not integrate its position, so letting it accumulate
  // velocity here would store energy that is released all at once on waking.
  // The solver wakes such bodies (see `wakeIfTouchedByAwake`); this keeps the
  // invariant true locally even if some future path forgets to.
  if (body.sleeping || (body.invMass <= 0 && body.invInertia <= 0)) {
    return;
  }
  body.vx += ix * body.invMass;
  body.vy += iy * body.invMass;
  body.w += (rx * iy - ry * ix) * body.invInertia;
}

/** Express a world point in a body's own frame. */
function toLocalAnchor(body: BodyEntry, worldX: number, worldY: number): Point2D {
  const dx = worldX - body.x;
  const dy = worldY - body.y;
  const cos = Math.cos(-body.rotation);
  const sin = Math.sin(-body.rotation);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/** Angular-only impulse, for the motor and limit constraints. */
function applyAngularImpulse(body: BodyEntry, impulse: number): void {
  if (body.sleeping || body.invInertia <= 0) {
    return;
  }
  body.w += impulse * body.invInertia;
}

/**
 * Signed difference from `from` to `to`, taken the short way round.
 * Interpolating raw angles makes a body that crosses +-PI spin the long way.
 */
function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  } else if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function makeHandle(entry: BodyEntry): PhysicsBody2DHandle {
  return {
    node: entry.node,
    get bodyType() {
      return entry.bodyType;
    },
    get velocityX() {
      return entry.vx;
    },
    get velocityY() {
      return entry.vy;
    },
    get angularVelocity() {
      return entry.w;
    },
    get isSleeping() {
      return entry.sleeping;
    },
    setVelocity(vx: number, vy: number) {
      entry.vx = vx;
      entry.vy = vy;
      entry.sleeping = false;
      entry.sleepTimer = 0;
    },
    setAngularVelocity(w: number) {
      entry.w = w;
      entry.sleeping = false;
      entry.sleepTimer = 0;
    },
    applyImpulse(ix: number, iy: number) {
      entry.vx += ix * entry.invMass;
      entry.vy += iy * entry.invMass;
      entry.sleeping = false;
      entry.sleepTimer = 0;
    },
    applyForce(fx: number, fy: number) {
      entry.forceX += fx;
      entry.forceY += fy;
      entry.sleeping = false;
      entry.sleepTimer = 0;
    },
    teleport(x: number, y: number, rotation?: number) {
      entry.x = x;
      entry.y = y;
      if (typeof rotation === 'number') {
        entry.rotation = rotation;
      }
      entry.vx = 0;
      entry.vy = 0;
      entry.w = 0;
      // Collapse the interpolation window onto the new pose. A teleport is a
      // discontinuity, and blending across it would draw the body sliding to
      // where it was moved instead of appearing there.
      entry.prevX = entry.x;
      entry.prevY = entry.y;
      entry.prevRotation = entry.rotation;
      entry.sleeping = false;
      entry.sleepTimer = 0;
    },
    wake() {
      entry.sleeping = false;
      entry.sleepTimer = 0;
    },
  };
}
