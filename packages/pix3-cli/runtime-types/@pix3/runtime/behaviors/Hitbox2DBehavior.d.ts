import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { Hitbox2DShape, Hitbox2DSource } from '../core/Collision2DService';
import type { Point2D } from '../core/collision-shapes-2d';
/**
 * Hitbox2D (`core:Hitbox2D`) — attaches a queryable 2D collision shape to a
 * node (Unity Collider2D / Cocos Collider component style, filtered by
 * Godot-style string groups). Registers with `scene.collision2d`; gameplay
 * scripts hit-test via `scene.collision2d.overlapCircle(...)` / `raycast(...)`.
 *
 * Shapes: `rect` and `circle` are axis-aligned (rotation ignored, scale honored)
 * — see Collision2DService for that contract. `polygon` is rotation-aware and may
 * be concave, and takes its vertices either from `points` (authored in the
 * viewport's polygon tool) or, with `polygonSource: 'frame'`, from the animation
 * frame currently showing on an `AnimatedSprite2D` — the outline the Sprite
 * Editor traces from the frame's alpha.
 *
 * `debugDraw` renders the shape outline in play mode (Godot's "Visible Collision
 * Shapes").
 */
export declare class Hitbox2DBehavior extends Script implements Hitbox2DSource {
    private debugLine;
    private debugKey;
    /** Last `points` array seen, with its normalized form — avoids re-parsing per query. */
    private polygonCacheInput;
    private polygonCache;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    getHitboxShape(): Hitbox2DShape;
    getHitboxSize(): {
        width: number;
        height: number;
        radius: number;
    };
    getHitboxOffset(): {
        x: number;
        y: number;
    };
    getHitboxGroup(): string;
    /**
     * Node-local vertices. With `polygonSource: 'frame'` this changes every time
     * the sprite advances a frame — deliberately re-read per query rather than
     * cached, because the whole point is that the collider tracks the animation.
     */
    getHitboxPolygon(): readonly Point2D[];
    onStart(): void;
    onUpdate(): void;
    onDetach(): void;
    private syncDebugDraw;
    private removeDebugLine;
}
