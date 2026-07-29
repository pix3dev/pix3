import {
  getNodePropertySchema,
  getPropertyDefinition,
  NetworkedNodeBehavior,
  Script,
  setNodePropertyValue,
} from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import {
  ARENA_COLORS,
  arenaAvatars,
  arenaMatch,
  arenaSession,
  peerName,
  type ArenaAvatar,
} from './arena-shared';

/**
 * One avatar — the local player's or a peer's.
 *
 * The same script runs on both, and the *only* difference is who moves it: the owner reads input and
 * writes `node.position`, which `core:ReplicatedTransform` publishes; a remote avatar's position is
 * written by that same component from the interpolated wire samples, so this script must never touch
 * it. Getting that backwards is the classic replication bug — the node fights the network and jitters
 * — so ownership is checked once per frame and nothing else here writes a transform.
 */
export class PlayerAvatar extends Script implements ArenaAvatar {
  private netNode: NetworkedNodeBehavior | null = null;
  /** Set by ArenaController on the avatar it instantiated, before the entity exists. */
  private local = false;
  private spawnX = 0;
  private spawnY = 0;
  private emoteTimer = 0;
  private nameTimer = 0;
  private appliedColorFor = -1;
  private lastName = '';

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      moveSpeed: 420,
      boundsX: 760,
      boundsY: 410,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Avatar', step: 10 },
      getValue: (c: unknown) => (c as PlayerAvatar).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as PlayerAvatar).config[name] = Number(v);
      },
    });

    return {
      nodeType: 'PlayerAvatar',
      properties: [
        num('moveSpeed', 'Move Speed (px/s)'),
        num('boundsX', 'Half Width Bound'),
        num('boundsY', 'Half Height Bound'),
      ],
      groups: { Avatar: { label: 'Player Avatar', expanded: true } },
    };
  }

  // ── ArenaAvatar ────────────────────────────────────────────────────────────

  get clientId(): number {
    const owner = this.netNode?.ownerId ?? 0;
    if (owner !== 0) {
      return owner;
    }
    return this.local ? arenaSession.clientId : 0;
  }

  get isMine(): boolean {
    // `local` covers the window between instantiate and the server minting the entity, and the
    // offline case where no entity is ever minted at all.
    return this.local || (this.netNode?.isMine ?? false);
  }

  getPosition(): { x: number; y: number } {
    const node = this.node;
    return { x: node?.position.x ?? 0, y: node?.position.y ?? 0 };
  }

  showEmote(text: string): void {
    const label = this.findChild('Emote');
    if (!label) {
      return;
    }
    this.setLabelText(label, text);
    label.visible = true;
    this.emoteTimer = 2.5;
  }

  setIt(isIt: boolean): void {
    const ring = this.findChild('It Ring');
    if (ring) {
      ring.visible = isIt;
    }
  }

  /** Teleports back to the spawn point. `core:ReplicatedTransform` sends this as a snap, not a slide. */
  respawn(): void {
    this.node?.position.set(this.spawnX, this.spawnY, this.node.position.z);
  }

  /** Called by ArenaController on the avatar it just instantiated for this client. */
  markLocal(): void {
    this.local = true;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  onStart(): void {
    this.netNode = this.node?.getComponent(NetworkedNodeBehavior) ?? null;
    const node = this.node;
    if (node) {
      this.spawnX = node.position.x;
      this.spawnY = node.position.y;
    }
    arenaAvatars.add(this);
    this.setIt(false);
    this.refreshIdentity();
  }

  onDetach(): void {
    arenaAvatars.delete(this);
    super.onDetach();
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node) {
      return;
    }

    if (this.emoteTimer > 0) {
      this.emoteTimer -= dt;
      if (this.emoteTimer <= 0) {
        const label = this.findChild('Emote');
        if (label) {
          label.visible = false;
        }
      }
    }

    // Names and colors depend on the roster, which arrives asynchronously; 4 Hz is invisible to the
    // eye and keeps this off the per-frame path.
    this.nameTimer -= dt;
    if (this.nameTimer <= 0) {
      this.nameTimer = 0.25;
      this.refreshIdentity();
      this.setIt(arenaMatch.itClientId !== 0 && arenaMatch.itClientId === this.clientId);
    }

    if (!this.isMine) {
      return;
    }

    const input = this.input;
    let dx = input?.getAxis('Horizontal') ?? 0;
    let dy = input?.getAxis('Vertical') ?? 0;
    if (input) {
      if (input.getButton('Key_KeyA') || input.getButton('Key_ArrowLeft')) dx -= 1;
      if (input.getButton('Key_KeyD') || input.getButton('Key_ArrowRight')) dx += 1;
      if (input.getButton('Key_KeyS') || input.getButton('Key_ArrowDown')) dy -= 1;
      if (input.getButton('Key_KeyW') || input.getButton('Key_ArrowUp')) dy += 1;
    }

    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared > 1) {
      const length = Math.sqrt(lengthSquared);
      dx /= length;
      dy /= length;
    }
    if (dx === 0 && dy === 0) {
      return;
    }

    const speed = Number(this.config.moveSpeed) || 420;
    const boundsX = Number(this.config.boundsX) || 760;
    const boundsY = Number(this.config.boundsY) || 410;
    const x = clamp(node.position.x + dx * speed * dt, -boundsX, boundsX);
    const y = clamp(node.position.y + dy * speed * dt, -boundsY, boundsY);
    node.position.set(x, y, node.position.z);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Paints the body by owner and writes the display name, both only when they actually changed. */
  private refreshIdentity(): void {
    const clientId = this.clientId;
    const network = this.scene?.network;

    if (clientId !== this.appliedColorFor) {
      this.appliedColorFor = clientId;
      const body = this.findChild('Body');
      if (body) {
        setNodeColor(body, ARENA_COLORS[Math.abs(clientId) % ARENA_COLORS.length]);
      }
    }

    const label = this.findChild('Name');
    if (!label) {
      return;
    }
    const name = this.isMine
      ? `${peerName(network?.peers ?? [], clientId)} (you)`
      : peerName(network?.peers ?? [], clientId);
    if (name !== this.lastName) {
      this.lastName = name;
      this.setLabelText(label, name);
    }
  }

  private findChild(name: string): NodeBase | null {
    return (this.node?.children.find(child => (child as NodeBase).name === name) as NodeBase) ?? null;
  }

  private setLabelText(label: NodeBase, text: string): void {
    setSchemaProperty(label, 'label', text);
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function setNodeColor(node: NodeBase, color: string): void {
  setSchemaProperty(node, 'color', color);
}

/**
 * Writes a node property through its schema.
 *
 * A node's backing field is often private (ColorRect2D keeps its material to itself), and the schema
 * setter is the supported way in — it is the same path the inspector uses, so it also runs the
 * node's own side effects.
 */
function setSchemaProperty(node: NodeBase, name: string, value: unknown): void {
  const definition = getPropertyDefinition(getNodePropertySchema(node), name);
  if (definition) {
    setNodePropertyValue(node, definition, value);
  }
}
