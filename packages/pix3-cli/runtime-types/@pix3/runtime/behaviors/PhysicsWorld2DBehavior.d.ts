import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
/**
 * PhysicsWorld2D (`core:PhysicsWorld2D`) — designer-facing gravity, attached to
 * the scene root.
 *
 * `scene.physics2d.setGravity(...)` covers the scripting case; this covers the
 * case with no script at all, which is the whole point of an engine-level
 * physics system. It writes on start and on every update so an inspector edit
 * during play takes effect immediately (~40 lines, and it strips out of exports
 * that never mention it).
 *
 * Units are design pixels per second squared with **y up**, so earth-ish gravity
 * is a negative y — the default, 1960, is the value a 100 px sprite reads as
 * "roughly a metre-tall object falling" at Pix3's usual scale.
 */
export declare class PhysicsWorld2DBehavior extends Script {
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onStart(): void;
    onUpdate(): void;
    private applyGravity;
}
