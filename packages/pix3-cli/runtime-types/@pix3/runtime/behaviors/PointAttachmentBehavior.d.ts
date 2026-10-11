import { Script } from '../core/ScriptComponent';
/**
 * Glue this node to a **named frame point** of a parent `AnimatedSprite2D` — the
 * "item in hand" / "muzzle on the barrel" case. Every tick the host node is moved
 * onto the point the current animation frame defines, so it tracks the art
 * through a walk cycle without any per-frame authoring on the child.
 *
 * The point resolves in the sprite's node-local space; this node is expected to
 * be a child of that sprite (the default when you drop an item onto a character),
 * but any node whose parent chain reaches the sprite works — the value is
 * converted through world space.
 *
 * Frames that don't define the point leave the node where it was, so a clip can
 * "hide" a socket for a few frames without the attached node snapping to origin.
 */
export declare class PointAttachmentBehavior extends Script {
    /** Name of the frame point to follow. */
    point: string;
    /** Also copy the point's angle into this node's Z rotation. */
    applyRotation: boolean;
    /** Extra local offset applied after the point, in the sprite's units. */
    offsetX: number;
    offsetY: number;
    /**
     * Node id of the AnimatedSprite2D to read from. Empty = nearest
     * AnimatedSprite2D ancestor, which is what "put the item under the character"
     * means in practice.
     */
    spriteNodeId: string;
    private sprite;
    static getPropertySchema(): {
        nodeType: string;
        properties: import("..").PropertyDefinition[];
        groups: {};
    };
    onStart(): void;
    onUpdate(_dt: number): void;
    private resolveSprite;
}
