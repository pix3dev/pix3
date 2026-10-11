import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { NodeBase } from '../nodes/NodeBase';
import type { RevoluteJoint2DConfig, RevoluteJoint2DSource } from '../core/Physics2DService';
/**
 * RevoluteJoint2D (`core:RevoluteJoint2D`) — a hinge.
 *
 * Pins this node's body to a point, letting it rotate about it and nothing else.
 * With `connectedNode` empty the hinge is nailed to the world, which is the
 * pinball flipper case: a body on a fixed pivot, an angle range it may swing
 * through, and a motor strong enough to slam it against the upper limit when the
 * player presses the button.
 *
 * A flipper is then a script that flips `motorSpeed` between `+speed` and
 * `-speed`, which is exactly how the same machine is built in Box2D and Godot:
 *
 * ```ts
 * const hinge = this.node.getComponent(RevoluteJoint2DBehavior);
 * hinge.config.motorSpeed = this.input.getButton('flip') ? 20 : -20;
 * ```
 *
 * Config is read live every step, so an inspector edit during play applies
 * immediately and a script needs no handle API.
 *
 * Angles are **degrees** on the authored surface (the whole inspector is), and
 * radians inside the solver.
 */
export declare class RevoluteJoint2DBehavior extends Script implements RevoluteJoint2DSource {
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    getJointAnchor(): {
        x: number;
        y: number;
    };
    getConnectedNode(): NodeBase | null;
    getJointConfig(): RevoluteJoint2DConfig;
    onStart(): void;
    onDetach(): void;
}
