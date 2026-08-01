import { MathUtils } from 'three';
import { Script } from '../core/ScriptComponent';
import { defineProperty } from '../fw/property-schema';
import { Node2D } from '../nodes/Node2D';
import { AnimatedSprite2D } from '../nodes/2D/AnimatedSprite2D';

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
export class PointAttachmentBehavior extends Script {
  /** Name of the frame point to follow. */
  point = '';
  /** Also copy the point's angle into this node's Z rotation. */
  applyRotation = true;
  /** Extra local offset applied after the point, in the sprite's units. */
  offsetX = 0;
  offsetY = 0;
  /**
   * Node id of the AnimatedSprite2D to read from. Empty = nearest
   * AnimatedSprite2D ancestor, which is what "put the item under the character"
   * means in practice.
   */
  spriteNodeId = '';

  private sprite: AnimatedSprite2D | null = null;

  static override getPropertySchema() {
    return {
      nodeType: 'PointAttachmentBehavior',
      properties: [
        defineProperty('point', 'string', {
          ui: { label: 'Point', description: 'Named frame point to follow' },
          getValue: (c: unknown) => (c as PointAttachmentBehavior).point,
          setValue: (c: unknown, v: unknown) => {
            (c as PointAttachmentBehavior).point = String(v ?? '').trim();
          },
        }),
        defineProperty('applyRotation', 'boolean', {
          ui: { label: 'Apply Rotation', description: "Copy the point's angle into this node" },
          getValue: (c: unknown) => (c as PointAttachmentBehavior).applyRotation,
          setValue: (c: unknown, v: unknown) => {
            (c as PointAttachmentBehavior).applyRotation = Boolean(v);
          },
        }),
        defineProperty('offsetX', 'number', {
          ui: { label: 'Offset X', step: 1 },
          getValue: (c: unknown) => (c as PointAttachmentBehavior).offsetX,
          setValue: (c: unknown, v: unknown) => {
            (c as PointAttachmentBehavior).offsetX = Number(v) || 0;
          },
        }),
        defineProperty('offsetY', 'number', {
          ui: { label: 'Offset Y', step: 1 },
          getValue: (c: unknown) => (c as PointAttachmentBehavior).offsetY,
          setValue: (c: unknown, v: unknown) => {
            (c as PointAttachmentBehavior).offsetY = Number(v) || 0;
          },
        }),
        defineProperty('spriteNodeId', 'node', {
          ui: {
            label: 'Sprite',
            description: 'AnimatedSprite2D to read points from (empty = nearest ancestor)',
            nodeTypes: ['AnimatedSprite2D'],
          },
          getValue: (c: unknown) => (c as PointAttachmentBehavior).spriteNodeId,
          setValue: (c: unknown, v: unknown) => {
            const behavior = c as PointAttachmentBehavior;
            behavior.spriteNodeId = String(v ?? '').trim();
            behavior.sprite = null;
          },
        }),
      ],
      groups: {},
    };
  }

  override onStart(): void {
    this.sprite = null;
  }

  override onUpdate(): void {
    const node = this.node;
    if (!node || !(node instanceof Node2D) || this.point.length === 0) {
      return;
    }

    const sprite = this.resolveSprite();
    if (!sprite) {
      return;
    }

    const local = sprite.getFramePoint(this.point);
    if (!local) {
      return;
    }

    const parent = node.parent;
    if (!parent) {
      return;
    }

    if (parent === sprite) {
      // The common case — a direct child shares the sprite's local space.
      node.position.set(local.x + this.offsetX, local.y + this.offsetY, node.position.z);
    } else {
      const world = sprite.getFramePointWorld(this.point);
      if (!world) {
        return;
      }
      parent.updateMatrixWorld(true);
      node.position.set(world.x, world.y, world.z);
      parent.worldToLocal(node.position);
      node.position.x += this.offsetX;
      node.position.y += this.offsetY;
    }

    if (this.applyRotation) {
      node.rotation.z = MathUtils.degToRad(local.angle);
    }
  }

  private resolveSprite(): AnimatedSprite2D | null {
    if (this.sprite) {
      return this.sprite;
    }

    if (this.spriteNodeId) {
      const found = this.findNode(this.spriteNodeId);
      this.sprite = found instanceof AnimatedSprite2D ? found : null;
      return this.sprite;
    }

    let current = this.node?.parent ?? null;
    while (current) {
      if (current instanceof AnimatedSprite2D) {
        this.sprite = current;
        return current;
      }
      current = current.parent;
    }

    return null;
  }
}
