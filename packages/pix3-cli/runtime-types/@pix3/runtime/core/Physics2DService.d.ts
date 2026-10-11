import type { NodeBase } from '../nodes/NodeBase';
import { type Point2D } from './collision-shapes-2d';
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
    getColliderSize(): {
        width: number;
        height: number;
        radius: number;
    };
    getColliderOffset(): {
        x: number;
        y: number;
    };
    getColliderPolygon(): readonly Point2D[];
    getColliderMaterial(): {
        friction: number;
        restitution: number;
        density: number;
    };
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
    getJointAnchor(): {
        x: number;
        y: number;
    };
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
export declare class Physics2DService {
    private gravityX;
    private gravityY;
    private readonly bodies;
    private readonly colliders;
    /** Colliders with no body of their own or above them: implicit static geometry. */
    private readonly staticBody;
    private readonly contacts;
    private readonly joints;
    /** Body pairs a joint has asked the broadphase to ignore; see `collideConnected`. */
    private jointedPairs;
    /**
     * Pairs touching as of last step, keyed the same way as {@link contacts}.
     *
     * The colliders are stored, not just the key, because the *exit* transition is
     * precisely the case where the pair has left the broadphase and there is no
     * candidate list left to look them up in — reading the exit off this frame's
     * pairs reports enters and silently drops every exit.
     */
    private touching;
    private readonly signalQueue;
    private orderCounter;
    constructor();
    /** Gravity in design px/s^2. Y is up, so a falling world wants a negative y. */
    setGravity(x: number, y: number): void;
    getGravity(): {
        x: number;
        y: number;
    };
    /** Registered body count (diagnostics, and how `SceneRunner` skips a no-op step). */
    get bodyCount(): number;
    get colliderCount(): number;
    registerBody(source: PhysicsBody2DSource): void;
    unregisterBody(source: PhysicsBody2DSource): void;
    registerCollider(source: Collider2DSource): void;
    unregisterCollider(source: Collider2DSource): void;
    /**
     * Bind a hinge. The pivot is resolved once, at registration: the authored
     * anchor is a point in the joint node's local space, and both bodies remember
     * where that world point sits in their own frame. Re-resolving it per step
     * would make the joint chase whatever drift the solver left behind instead of
     * correcting it.
     */
    registerJoint(source: RevoluteJoint2DSource): void;
    unregisterJoint(source: RevoluteJoint2DSource): void;
    /** Recompute which body pairs the broadphase must skip. */
    private refreshJointedPairs;
    get jointCount(): number;
    /** Handle for a node's body, or null when it has none. */
    getBody(node: NodeBase | null | undefined): PhysicsBody2DHandle | null;
    /**
     * Advance the world by one fixed step. Called from
     * `SceneRunner.runFixedUpdates` via `SceneService.stepPhysics2D`, so it
     * inherits the runner's GameTime scaling (hitstop freezes physics for free)
     * and its `maxFixedStepsPerFrame` clamp.
     */
    step(dt: number): void;
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
    interpolate(alpha: number): void;
    /** Closest collider hit by the world-space segment, or null. */
    raycast(x1: number, y1: number, x2: number, y2: number, options?: Physics2DQueryOptions): Physics2DRaycastHit | null;
    /** Every collider overlapping the world-space circle. */
    overlapCircle(x: number, y: number, radius: number, options?: Physics2DQueryOptions): NodeBase[];
    /** Every collider overlapping the world-space axis-aligned rect. */
    overlapRect(cx: number, cy: number, width: number, height: number, options?: Physics2DQueryOptions): NodeBase[];
    /**
     * Move `node`'s body by `(dx, dy)`, stopping at the first thing it hits.
     *
     * Motion is substepped so no substep advances further than half the body's
     * smallest extent — without that a fast character samples past a thin wall and
     * ends up on the far side of it. After each substep the body is pushed back out
     * of anything it overlaps, and the deepest such push is reported as the hit.
     */
    moveAndCollide(node: NodeBase | null | undefined, dx: number, dy: number, options?: Physics2DQueryOptions): MoveCollide2DResult;
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
    moveAndSlide(node: NodeBase | null | undefined, velocityX: number, velocityY: number, dt: number, options?: MoveAndSlide2DOptions): MoveAndSlide2DResult;
    /**
     * How far one substep of {@link moveAndCollide} may advance: half the body's
     * smallest collider extent, so a substep can never skip clean over the thing it
     * should have hit.
     */
    private bodyStepLimit;
    /**
     * Push `body` out of everything solid it currently overlaps, deepest first.
     * Returns the deepest correction applied, or null when it was already clear.
     */
    private depenetrate;
    /** Push a body's solved pose onto its node, honouring the parent's frame. */
    private writeBodyToNode;
    /**
     * The wireframe for the debug overlay, in the layout `PhysicsDebugOverlay`
     * already speaks: three floats per point, two points per segment, plus an RGBA
     * colour per point.
     *
     * Sensors draw green and sleeping bodies dim, because "is that collider even
     * there?" and "why did this stop moving?" are the two questions the overlay
     * exists to answer.
     */
    buildDebugBuffers(): {
        vertices: Float32Array;
        colors: Float32Array;
    };
    /** Release every registration. Called when the scene stops. */
    clear(): void;
    /**
     * Attach every collider to the nearest ancestor body (Unity's compound-body
     * rule), or to the implicit world body when there is none — which is how a
     * `core:Collider2D` with no `core:PhysicsBody2D` becomes static level geometry
     * with one component and zero scripts.
     */
    private rebindColliders;
    private findOwningBody;
    /** Pull authored config and any externally-written transform onto the bodies. */
    private syncFromNodes;
    /** Rebuild baked shapes whose config changed, then refresh world vertices. */
    private refreshShapes;
    /**
     * Lift one collider's baked shape into world space at its body's current pose.
     *
     * Split out of {@link refreshShapes} because character movement moves a single
     * body many times within one call and has to re-test after each nudge; walking
     * every collider in the scene for that would make a slide cost O(world) per
     * substep.
     */
    private refreshColliderWorldShape;
    /**
     * The collider node's transform relative to its body's node. Zero for the
     * common case where they are the same node; a real offset for compound bodies
     * and for colliders parented under a moving rig.
     */
    private colliderLocalTransform;
    /** Bake a collider's authored shape into body-local convex parts. */
    private bakeShape;
    /**
     * Mass and rotational inertia from the body's colliders.
     *
     * An authored `mass` overrides the derived one but keeps the *shape's* inertia
     * distribution, scaled to the new mass — otherwise setting a mass would also
     * silently change how readily the body spins.
     */
    private recomputeMass;
    private integrateVelocities;
    /** Uniform grid: cheap to build, and 2D playables rarely exceed a few hundred colliders. */
    private broadphase;
    private shouldCollide;
    private narrowphase;
    private emitTransitions;
    /**
     * Sensors always report `body-entered` / `body-exited` (Godot's Area2D role);
     * solid pairs report `contact-started` / `contact-ended` only when the body
     * opted in with `emitContacts`, because most games never read them and a
     * signal per contact per step is the kind of cost that hides.
     */
    private queueContactSignal;
    /** Per-contact solver constants: lever arms, effective masses, bias, restitution. */
    private prepareContact;
    private warmStart;
    private solveVelocities;
    /** One point's normal constraint, accumulated and clamped non-negative. */
    private solveNormalPoint;
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
    private solveNormalBlock;
    private orderedJoints;
    /** Per-step joint constants: world lever arms and the effective masses. */
    private prepareJoints;
    /** Keep the broadphase skip-set in step with a live `collideConnected` edit. */
    private syncJointedPair;
    private warmStartJoints;
    /**
     * Motor, then limits, then the pivot itself.
     *
     * The order matters: the point constraint is the one that must hold exactly (a
     * hinge that comes apart is not a hinge), so it is solved last and gets the
     * final say over whatever the motor and limits asked for.
     */
    private solveJointVelocities;
    /**
     * Pull the two anchor points back together.
     *
     * Velocity-only hinges drift: every step leaves a little positional error that
     * the next step's velocity solve has no term for, and over a few seconds a
     * flipper visibly walks off its pivot.
     */
    private solveJointPositions;
    private integratePositions;
    /**
     * Push `bullet` bodies back to their first touch this step.
     *
     * Only circle-shaped bullets against static geometry are swept — that is the
     * pinball/projectile case the flag exists for, and a general swept solve for
     * every pair is a different (much larger) piece of engineering.
     */
    private applyContinuousCollision;
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
    private solvePositions;
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
    private updateSleep;
    /** Wake the sleeping side of a pair whose other side is awake and dynamic. */
    private wakeIfTouchedByAwake;
    private wakeBody;
    /**
     * Write solved poses back onto the nodes.
     *
     * Play mode runs an isolated clone of the scene, so this never touches the
     * authored graph, undo/redo or collab — the same contract every play-mode
     * script write already has.
     */
    private writeBackToNodes;
    private flushSignals;
    private orderedBodies;
    private orderedContacts;
    private orderedColliders;
}
