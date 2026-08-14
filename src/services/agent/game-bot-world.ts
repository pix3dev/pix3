/**
 * The live half of a bot's contract: what a policy can *see* of the running scene,
 * and the one actuator whose geometry is not a single event — the physical joystick
 * deflection (§5.3 / §5.4.2 of `.plans/agent-gameplay-testing.md`).
 *
 * Split out of `GameTestService` for one reason: this is the part of a bot run that a
 * spec can hold to account without a browser. The rest of the world (a key press, a
 * button click, an axis write) is one call into an existing sink; the code here does
 * geometry — bounding boxes, projections, stick vectors — and geometry that is subtly
 * wrong produces a policy that "does not work" with nothing in the report to point at.
 *
 * Everything here takes the scene through a **structural** handle rather than the
 * `SceneRunner` class, so those specs build a three-method object and real `NodeBase`
 * trees instead of a renderer.
 */

import { Box3, Ray, Vector3 } from 'three';
import { NodeBase } from '@pix3/runtime';
import type { BotHit, BotNodeView, BotPoint } from '@/services/agent/game-bots';
import type { TraceInputSink } from '@/services/agent/game-traces';

/**
 * The slice of the runner the bot world reads. Duck-typed for the same reason
 * `TestableRunner` is: a spec must be able to supply it, and nothing here has any
 * business reaching the rest of a runner.
 */
export interface BotSceneHandle {
  getLiveRootNodes(): readonly NodeBase[];
  getLiveNodeById(id: string): NodeBase | null;
  projectWorldPointToCanvas(x: number, y: number): { x: number; y: number } | null;
}

/** The canvas box the projection is expressed in, as fractions 0..1. */
export interface BotCanvasHandle {
  width: number;
  height: number;
  getBoundingClientRect(): { width: number; height: number };
}

/**
 * Live nodes one sensor call walks. A policy that sweeps a bullet-hell scene every
 * tick must not turn its own sensing into the run's cost.
 */
export const MAX_BOT_SENSE_NODES = 4000;
/**
 * Nodes one `raycast` tests. Lower than the sense cap on purpose: a bounding-box test
 * builds a world-space box per node, which is the most expensive thing a policy can
 * ask for per frame.
 */
export const MAX_BOT_RAYCAST_NODES = 2000;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** The view a policy gets of one live node — the subset documented in `game-bots.ts`. */
export function botNodeView(node: NodeBase): BotNodeView {
  const world = node.getWorldPosition(new Vector3());
  const text = (node as unknown as { text?: unknown }).text;
  return {
    nodeId: node.nodeId,
    name: node.name,
    type: node.type,
    visible: node.visible,
    position: { x: node.position.x, y: node.position.y, z: node.position.z },
    worldPosition: { x: round3(world.x), y: round3(world.y), z: round3(world.z) },
    ...(typeof text === 'string' ? { text } : {}),
  };
}

/** Walk the live graph in tree order, stopping at `limit` visits. */
export function walkLiveNodes(
  scene: BotSceneHandle,
  limit: number,
  visit: (node: NodeBase) => void
): void {
  let seen = 0;
  const descend = (node: NodeBase): void => {
    if (seen >= limit) return;
    seen += 1;
    visit(node);
    for (const child of node.children) {
      if (child instanceof NodeBase) descend(child);
    }
  };
  for (const root of scene.getLiveRootNodes()) descend(root);
}

/**
 * Nodes answering a policy's query, which is one of three things at once: an id, a
 * name, or a type.
 *
 * Not three methods, because a policy does not know which of the three it holds — it
 * got the string from a scene the agent wrote — and making it guess is how a sensor
 * starts returning empty for a node that is right there. An id match short-circuits:
 * ids are unique by construction, so there is nothing to keep walking for.
 */
export function collectBotNodeViews(
  scene: BotSceneHandle,
  query: string,
  max: number
): BotNodeView[] {
  const byId = scene.getLiveNodeById(query);
  if (byId) return [botNodeView(byId)];
  const found: BotNodeView[] = [];
  walkLiveNodes(scene, MAX_BOT_SENSE_NODES, node => {
    if (found.length >= max) return;
    if (node.name === query || node.type === query) found.push(botNodeView(node));
  });
  return found;
}

/** Nearest live node of a type to a point, with the distance that made it nearest. */
export function nearestBotNode(scene: BotSceneHandle, type: string, from: BotPoint): BotHit | null {
  const origin = new Vector3(from.x, from.y, from.z ?? 0);
  const scratch = new Vector3();
  let best: { node: NodeBase; distance: number } | null = null;
  walkLiveNodes(scene, MAX_BOT_SENSE_NODES, node => {
    if (node.type !== type) return;
    const distance = node.getWorldPosition(scratch).distanceTo(origin);
    if (!best || distance < best.distance) best = { node, distance };
  });
  if (!best) return null;
  const winner = best as { node: NodeBase; distance: number };
  const view = botNodeView(winner.node);
  return { node: view, distance: round3(winner.distance), point: view.worldPosition };
}

/**
 * One node's **own** visual extent in world space: the boxes of its direct
 * non-`NodeBase` children (that is where every node type in this runtime keeps its
 * mesh — `Sprite2D` does `this.add(this.mesh)`), never its child *nodes*.
 *
 * `Box3.setFromObject` is recursive, and using it directly here was a real bug caught
 * by this module's spec: every ancestor of a solid node gets a box enclosing it, so a
 * ray hit the scene ROOT — at the same distance as the wall behind it, and visited
 * first — and every raycast answered "Root" instead of naming the obstacle. A pure
 * container has no extent of its own and is correctly not an obstacle.
 */
function ownVisualBox(node: NodeBase, into: Box3, scratch: Box3): Box3 {
  into.makeEmpty();
  for (const child of node.children) {
    if (child instanceof NodeBase) continue;
    scratch.setFromObject(child);
    if (!scratch.isEmpty()) into.union(scratch);
  }
  return into;
}

/**
 * Ray against the live scene, and what it tests is worth stating exactly: each live
 * node's **world-space bounding box**, not its geometry and not its physics collider.
 *
 * Bounding boxes because the alternatives do not answer the question a policy asks. A
 * three.js geometric raycast is wrong for 2D — sprite quads lie in the z=0 plane, so a
 * ray travelling *within* that plane is coplanar with every one of them and hits
 * nothing, which would make the sensor silently useless in exactly the games this
 * harness exists for. Colliders would be the right answer for a physics game and absent
 * in every game without physics. A box is the reading that means the same thing in 2D
 * and 3D: "something of that node is in the way".
 *
 * Each node's box is its OWN extent, not its subtree's — see {@link ownVisualBox} for
 * why that distinction is the whole correctness of this function.
 */
export function raycastBotNodes(
  scene: BotSceneHandle,
  from: BotPoint,
  dir: BotPoint
): BotHit | null {
  const origin = new Vector3(from.x, from.y, from.z ?? 0);
  const direction = new Vector3(dir.x, dir.y, dir.z ?? 0);
  if (direction.lengthSq() === 0) return null;
  direction.normalize();
  const ray = new Ray(origin, direction);
  const box = new Box3();
  const hitPoint = new Vector3();
  let best: { node: NodeBase; distance: number; point: Vector3 } | null = null;

  const scratch = new Box3();
  walkLiveNodes(scene, MAX_BOT_RAYCAST_NODES, node => {
    if (!node.visible) return;
    ownVisualBox(node, box, scratch);
    if (box.isEmpty()) return;
    // A box that already contains the origin is not "in the way" — it is the node the
    // ray starts inside, which is almost always the caster itself.
    if (box.containsPoint(origin)) return;
    if (!ray.intersectBox(box, hitPoint)) return;
    const distance = origin.distanceTo(hitPoint);
    if (!best || distance < best.distance) {
      best = { node, distance, point: hitPoint.clone() };
    }
  });
  if (!best) return null;
  const winner = best as { node: NodeBase; distance: number; point: Vector3 };
  return {
    node: botNodeView(winner.node),
    distance: round3(winner.distance),
    point: {
      x: round3(winner.point.x),
      y: round3(winner.point.y),
      z: round3(winner.point.z),
    },
  };
}

/** A world point as canvas-box fractions, or null when it cannot be projected. */
export function projectToCanvasFraction(
  scene: BotSceneHandle,
  canvas: BotCanvasHandle,
  x: number,
  y: number
): { nx: number; ny: number } | null {
  const backing = scene.projectWorldPointToCanvas(x, y);
  if (!backing) return null;
  const rect = canvas.getBoundingClientRect();
  const width = canvas.width > 0 ? canvas.width : rect.width;
  const height = canvas.height > 0 ? canvas.height : rect.height;
  if (!(width > 0) || !(height > 0)) return null;
  return { nx: backing.x / width, ny: backing.y / height };
}

/**
 * Pointer id the bot's taps and aim use. Distinct from the replay/monkey pointer so a
 * policy tapping while a trace feeds input does not have the two gestures fight over one
 * finger — the runtime is multi-touch now, and two channels sharing an id would cancel
 * each other's press.
 */
export const BOT_POINTER_ID = 20;

/**
 * First id handed to a joystick the physical axis channel deflects. Derived from
 * {@link BOT_POINTER_ID} rather than written as a second number: two hand-maintained
 * pointer ids in two files is a collision waiting for whoever edits one of them.
 */
export const BOT_STICK_POINTER_BASE = BOT_POINTER_ID + 1;

/**
 * The physical answer to `bot.axis(name, value)`: deflect the on-screen joystick that
 * writes that axis, with a real finger.
 *
 * This exists because the runtime has **no keyboard-to-axis binding** — a key raises
 * `Key_<code>` as a button, and the only things that write an axis are the on-screen
 * controls (`Joystick2D`, `Slider2D`, `Checkbox2D`) and whatever a game sets itself. So
 * on the physical channel there is exactly one honest way to move an axis: touch the
 * control that owns it. Which is also the whole point of the channel — "the stick moves
 * the hero" is only a proven statement if the stick was actually pushed.
 *
 * Two axes, one finger. A stick writes a horizontal and a vertical axis, and a policy
 * sets them in two calls; the driver therefore keeps a desired vector per stick and
 * re-aims the same pointer, instead of treating each call as its own gesture. Without
 * that, `axis('Horizontal', 1)` followed by `axis('Vertical', 1)` would send the finger
 * straight right and then straight up, and the stick would never read diagonal.
 */
export class PhysicalAxisDriver {
  private readonly held = new Map<
    string,
    { pointerId: number; vector: { x: number; y: number }; down: boolean }
  >();
  private nextPointerId = BOT_STICK_POINTER_BASE;

  constructor(
    private readonly scene: BotSceneHandle,
    private readonly canvas: BotCanvasHandle,
    private readonly sink: TraceInputSink
  ) {}

  steer(axis: string, value: number): string | null {
    const stick = this.findStick(axis);
    if ('error' in stick) return stick.error;
    const { node, horizontal } = stick;
    const state =
      this.held.get(node.nodeId) ??
      (() => {
        const created = { pointerId: this.nextPointerId++, vector: { x: 0, y: 0 }, down: false };
        this.held.set(node.nodeId, created);
        return created;
      })();

    if (horizontal) state.vector.x = value;
    else state.vector.y = value;

    const magnitude = Math.hypot(state.vector.x, state.vector.y);
    if (magnitude < 1e-3) {
      // Centred: lift the finger rather than pressing the middle of the base. A stick
      // held at its centre and a stick released are the same axis values but not the
      // same state — a held stick keeps the control's `pressed` flag up, and a policy
      // that "stopped moving" would leave the game thinking a finger is still on it.
      if (state.down) {
        const at = this.project(node, 0, 0);
        if (at) this.sink.pointer('up', at.nx, at.ny, state.pointerId);
        state.down = false;
      }
      return null;
    }

    // Clamp to the rim: a magnitude above 1 is clamped by the control anyway, and
    // aiming outside the base would make the initial press land OUTSIDE the radius,
    // which correctly refuses to start the drag at all.
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    const centre = this.project(node, 0, 0);
    const target = this.project(node, state.vector.x * scale, state.vector.y * scale);
    if (!centre || !target) {
      return `joystick "${node.name || node.nodeId}" could not be projected to the canvas (no camera, or a zero-sized canvas).`;
    }
    if (!state.down) {
      // The press has to land inside the base to start the drag — that is the control's
      // own rule — so the finger arrives at the centre and travels out.
      this.sink.pointer('down', centre.nx, centre.ny, state.pointerId);
      state.down = true;
    }
    this.sink.pointer('move', target.nx, target.ny, state.pointerId);
    return null;
  }

  releaseAll(): void {
    for (const [nodeId, state] of this.held) {
      if (!state.down) continue;
      const node = this.scene.getLiveNodeById(nodeId);
      const at = node ? this.project(node, 0, 0) : null;
      this.sink.pointer('up', at?.nx ?? 0.5, at?.ny ?? 0.5, state.pointerId);
    }
    this.held.clear();
  }

  /**
   * The live control that writes this axis, or the sentence explaining why the physical
   * channel cannot move it.
   *
   * The refusals are the useful part. A `Slider2D` writing the axis is a real answer —
   * it just is not one a "set the axis to 0.6" gesture can express, since a slider is
   * dragged along a track rather than deflected — and saying so points at the two things
   * that would work. No control at all is the more common case and means the game sets
   * that axis itself, in which case only `direct-action` can move it, and the caller has
   * to know that the resulting run proves no binding.
   */
  private findStick(axis: string): { node: NodeBase; horizontal: boolean } | { error: string } {
    let stick: { node: NodeBase; horizontal: boolean } | null = null;
    let slider: NodeBase | null = null;
    walkLiveNodes(this.scene, MAX_BOT_SENSE_NODES, node => {
      if (stick) return;
      const candidate = node as unknown as {
        axisHorizontal?: unknown;
        axisVertical?: unknown;
        radius?: unknown;
        axisName?: unknown;
      };
      if (typeof candidate.radius === 'number') {
        if (candidate.axisHorizontal === axis) stick = { node, horizontal: true };
        else if (candidate.axisVertical === axis) stick = { node, horizontal: false };
        if (stick) return;
      }
      if (!slider && candidate.axisName === axis) slider = node;
    });
    if (stick) return stick;
    if (slider) {
      const owner = slider as NodeBase;
      return {
        error: `axis "${axis}" is written by "${owner.name || owner.nodeId}" (${owner.type}), which is dragged along a track rather than deflected — there is no "set this axis to a value" gesture for it. Drive it with game_input {type:'drag'} or an invoke of its own setValue interaction, or run this policy on channel 'direct-action' (which sets the axis directly and proves no binding).`,
      };
    }
    return {
      error: `no live control writes axis "${axis}", and the runtime has no keyboard-to-axis binding — a key raises Key_<code> as a button, not an axis. So on 'physical-input' there is nothing to touch that would move it: either the game sets this axis itself (use press() on the key it actually reads, or channel 'direct-action'), or the joystick that owns it is not in this scene.`,
    };
  }

  /** A point on the stick's base, in canvas-box fractions. `(0,0)` is its centre. */
  private project(node: NodeBase, dirX: number, dirY: number): { nx: number; ny: number } | null {
    const radius = (node as unknown as { radius?: number }).radius ?? 0;
    const centre = node.getWorldPosition(new Vector3());
    return projectToCanvasFraction(
      this.scene,
      this.canvas,
      centre.x + dirX * radius,
      centre.y + dirY * radius
    );
  }
}
