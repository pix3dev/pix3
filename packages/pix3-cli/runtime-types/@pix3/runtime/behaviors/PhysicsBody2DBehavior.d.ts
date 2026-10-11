import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { PhysicsBody2DSource, PhysicsBody2DType } from '../core/Physics2DService';
/**
 * PhysicsBody2D (`core:PhysicsBody2D`) — makes a node a rigid body in
 * `scene.physics2d`.
 *
 * Unity's arrangement rather than Godot's: the body is a *component* on the
 * sprite, and shape lives on sibling/descendant `core:Collider2D` components, so
 * a compound body (a flipper with two colliders) needs no new node types. A
 * collider with no body on its node or any ancestor is static world geometry —
 * the designer's "wall" case, one component and no script.
 *
 * Units are design pixels with y up, so gravity is negative-y and an impulse of
 * `(0, 600)` throws a 1-mass body upwards at 600 px/s.
 */
export declare class PhysicsBody2DBehavior extends Script implements PhysicsBody2DSource {
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
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
    onStart(): void;
    onDetach(): void;
}
