import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { Collider2DShape, Collider2DSource } from '../core/Physics2DService';
import type { Point2D } from '../core/collision-shapes-2d';
/**
 * Collider2D (`core:Collider2D`) — the shape half of the physics pair.
 *
 * Attaches to the **nearest ancestor** `core:PhysicsBody2D` (Unity's compound
 * rule), or, with no body above it, becomes static world geometry. Shapes are
 * rect, circle, and polygon; an authored polygon may be concave — the service
 * decomposes it into convex parts once, so a traced sprite outline is usable
 * directly.
 *
 * `sensor: true` is Godot's Area2D role: it detects and reports
 * `body-entered` / `body-exited` but never pushes anything.
 *
 * Everything is rotation- and scale-aware, which is the difference between this
 * and `core:Hitbox2D`: the query tier keeps its axis-aligned contract for
 * compatibility, a physics collider cannot.
 */
export declare class Collider2DBehavior extends Script implements Collider2DSource {
    private polygonCacheInput;
    private polygonCache;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
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
    /**
     * A cheap digest of everything that changes the baked shape. The service
     * compares it each step and rebakes when it differs, which is what makes an
     * inspector edit during play apply immediately without re-registration.
     *
     * A frame-sourced polygon folds its vertex count and first vertex into the
     * digest, so advancing an animation frame rebakes without stringifying the
     * whole outline every step.
     */
    getColliderRevision(): string;
    onStart(): void;
    onDetach(): void;
}
