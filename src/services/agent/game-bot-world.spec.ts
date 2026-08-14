import { describe, expect, it } from 'vitest';
import { Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { NodeBase } from '@pix3/runtime';
import {
  BOT_STICK_POINTER_BASE,
  collectBotNodeViews,
  nearestBotNode,
  PhysicalAxisDriver,
  projectToCanvasFraction,
  raycastBotNodes,
  walkLiveNodes,
  type BotCanvasHandle,
  type BotSceneHandle,
} from '@/services/agent/game-bot-world';
import type { TraceInputSink } from '@/services/agent/game-traces';

/**
 * Geometry, against real `NodeBase` trees.
 *
 * This is the half of a bot run that would otherwise only ever be checked by playing a
 * game in a browser — and being subtly wrong here produces a policy that "does not
 * work" with nothing in the report to point at. So the scene is real nodes and a
 * three-method scene handle, and the projection is a deliberately simple one (world
 * units → pixels, one to one) so an expected canvas fraction can be read off by hand.
 */

class TestNode extends NodeBase {}

function makeNode(
  id: string,
  options: {
    name?: string;
    type?: string;
    at?: [number, number, number];
    visible?: boolean;
    /**
     * Adds a 2×2×2 mesh as a CHILD, which is where every node type in this runtime
     * keeps its visual (`Sprite2D` does `this.add(this.mesh)`).
     */
    solid?: boolean;
  } = {}
): TestNode {
  const node = new TestNode({ id, name: options.name ?? id, type: options.type ?? 'Node2D' });
  const [x, y, z] = options.at ?? [0, 0, 0];
  node.position.set(x, y, z);
  if (options.visible === false) node.visible = false;
  if (options.solid) {
    node.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
  }
  node.updateWorldMatrix(true, true);
  return node;
}

/** A scene handle over a list of roots, with a 1:1 world→pixel projection. */
function makeScene(roots: TestNode[], projects = true): BotSceneHandle {
  const byId = new Map<string, NodeBase>();
  const index = (node: NodeBase): void => {
    byId.set(node.nodeId, node);
    for (const child of node.children) {
      if (child instanceof NodeBase) index(child);
    }
  };
  for (const root of roots) index(root);
  return {
    getLiveRootNodes: () => roots,
    getLiveNodeById: id => byId.get(id) ?? null,
    projectWorldPointToCanvas: (x, y) => (projects ? { x: 100 + x, y: 100 - y } : null),
  };
}

const canvas: BotCanvasHandle = {
  width: 200,
  height: 200,
  getBoundingClientRect: () => ({ width: 200, height: 200 }),
};

function makeSink(): TraceInputSink & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    key: (phase, code) => events.push(`key:${phase}:${code}`),
    pointer: (phase, nx, ny, pointerId) =>
      events.push(`pointer:${phase}:${nx.toFixed(3)},${ny.toFixed(3)}:${pointerId}`),
  };
}

// ---------------------------------------------------------------------------

describe('walkLiveNodes', () => {
  it('walks roots and descendants in tree order', () => {
    const root = makeNode('root');
    const a = makeNode('a');
    const b = makeNode('b');
    root.adoptChild(a);
    a.adoptChild(b);
    const seen: string[] = [];
    walkLiveNodes(makeScene([root]), 100, node => seen.push(node.nodeId));
    expect(seen).toEqual(['root', 'a', 'b']);
  });

  it('stops at the visit limit rather than sweeping a bullet-hell scene', () => {
    const root = makeNode('root');
    for (let i = 0; i < 50; i += 1) root.adoptChild(makeNode(`child-${i}`));
    const seen: string[] = [];
    walkLiveNodes(makeScene([root]), 5, node => seen.push(node.nodeId));
    expect(seen).toHaveLength(5);
  });
});

describe('collectBotNodeViews', () => {
  it('answers an id with exactly that node, without walking further', () => {
    const root = makeNode('root', { name: 'Root' });
    root.adoptChild(makeNode('hero', { name: 'Hero' }));
    const views = collectBotNodeViews(makeScene([root]), 'hero', 10);
    expect(views).toHaveLength(1);
    expect(views[0].name).toBe('Hero');
  });

  it('answers a name and a type with the same call', () => {
    const root = makeNode('root', { name: 'Root' });
    root.adoptChild(makeNode('r1', { name: 'Rock', type: 'Sprite2D' }));
    root.adoptChild(makeNode('r2', { name: 'Rock', type: 'Sprite2D' }));
    const scene = makeScene([root]);

    expect(collectBotNodeViews(scene, 'Rock', 10).map(view => view.nodeId)).toEqual(['r1', 'r2']);
    expect(collectBotNodeViews(scene, 'Sprite2D', 10)).toHaveLength(2);
    expect(collectBotNodeViews(scene, 'Nothing', 10)).toEqual([]);
  });

  it('caps what it hands back', () => {
    const root = makeNode('root', { name: 'Root' });
    for (let i = 0; i < 20; i += 1) {
      root.adoptChild(makeNode(`e${i}`, { name: 'Enemy', type: 'Sprite2D' }));
    }
    expect(collectBotNodeViews(makeScene([root]), 'Enemy', 4)).toHaveLength(4);
  });

  it('reports world position, not just local, so a parented node reads correctly', () => {
    const root = makeNode('root', { name: 'Root', at: [10, 5, 0] });
    const hero = makeNode('hero', { name: 'Hero', at: [3, 0, 0] });
    root.adoptChild(hero);
    root.updateWorldMatrix(true, true);

    const view = collectBotNodeViews(makeScene([root]), 'Hero', 1)[0];
    expect(view.position.x).toBe(3);
    expect(view.worldPosition.x).toBe(13);
    expect(view.worldPosition.y).toBe(5);
  });
});

describe('nearestBotNode', () => {
  it('picks the closest node of the type and reports the distance', () => {
    const root = makeNode('root', { name: 'Root' });
    root.adoptChild(makeNode('far', { name: 'Rock', type: 'Rock2D', at: [30, 0, 0] }));
    root.adoptChild(makeNode('near', { name: 'Rock', type: 'Rock2D', at: [6, 0, 0] }));
    root.updateWorldMatrix(true, true);

    const hit = nearestBotNode(makeScene([root]), 'Rock2D', { x: 0, y: 0 });
    expect(hit?.node.nodeId).toBe('near');
    expect(hit?.distance).toBe(6);
    // `point` is the node's own position: a nearest-node reading has no ray to hit.
    expect(hit?.point).toEqual(hit?.node.worldPosition);
  });

  it('answers null when nothing of that type is alive', () => {
    expect(nearestBotNode(makeScene([makeNode('root')]), 'Rock2D', { x: 0, y: 0 })).toBeNull();
  });

  it('measures from the point it was given, not from the origin', () => {
    const root = makeNode('root');
    root.adoptChild(makeNode('a', { type: 'Rock2D', at: [0, 0, 0] }));
    root.adoptChild(makeNode('b', { type: 'Rock2D', at: [20, 0, 0] }));
    root.updateWorldMatrix(true, true);
    const scene = makeScene([root]);

    expect(nearestBotNode(scene, 'Rock2D', { x: 0, y: 0 })?.node.nodeId).toBe('a');
    expect(nearestBotNode(scene, 'Rock2D', { x: 18, y: 0 })?.node.nodeId).toBe('b');
  });
});

describe('raycastBotNodes', () => {
  it('hits a node lying along a ray IN THE 2D PLANE — the case a three.js raycast cannot', () => {
    // The whole reason this is bounding-box based: sprite quads live in the z=0 plane,
    // so a ray travelling within that plane is coplanar with their geometry and a
    // geometric raycast finds nothing.
    const root = makeNode('root');
    root.adoptChild(makeNode('wall', { name: 'Wall', at: [10, 0, 0], solid: true }));
    root.updateWorldMatrix(true, true);

    const hit = raycastBotNodes(makeScene([root]), { x: 0, y: 0 }, { x: 1, y: 0 });
    expect(hit?.node.name).toBe('Wall');
    // The box is 2 units wide around x=10, so the near face is at x=9.
    expect(hit?.distance).toBe(9);
    expect(hit?.point.x).toBe(9);
  });

  it('returns the NEAREST hit when several boxes are on the ray', () => {
    const root = makeNode('root');
    root.adoptChild(makeNode('far', { name: 'Far', at: [30, 0, 0], solid: true }));
    root.adoptChild(makeNode('near', { name: 'Near', at: [10, 0, 0], solid: true }));
    root.updateWorldMatrix(true, true);

    expect(raycastBotNodes(makeScene([root]), { x: 0, y: 0 }, { x: 1, y: 0 })?.node.name).toBe(
      'Near'
    );
  });

  it('misses what is not on the ray, and ignores direction magnitude', () => {
    const root = makeNode('root');
    root.adoptChild(makeNode('wall', { name: 'Wall', at: [10, 0, 0], solid: true }));
    root.updateWorldMatrix(true, true);
    const scene = makeScene([root]);

    expect(raycastBotNodes(scene, { x: 0, y: 0 }, { x: -1, y: 0 })).toBeNull();
    expect(raycastBotNodes(scene, { x: 0, y: 50 }, { x: 1, y: 0 })).toBeNull();
    // Not normalised: a policy should not have to.
    expect(raycastBotNodes(scene, { x: 0, y: 0 }, { x: 17, y: 0 })?.distance).toBe(9);
  });

  it('skips an invisible node — what is not drawn is not in the way', () => {
    const root = makeNode('root');
    root.adoptChild(
      makeNode('ghost', { name: 'Ghost', at: [10, 0, 0], solid: true, visible: false })
    );
    root.updateWorldMatrix(true, true);

    expect(raycastBotNodes(makeScene([root]), { x: 0, y: 0 }, { x: 1, y: 0 })).toBeNull();
  });

  it('does not report the node the ray starts inside — usually the caster itself', () => {
    const root = makeNode('root');
    root.adoptChild(makeNode('me', { name: 'Me', at: [0, 0, 0], solid: true }));
    root.adoptChild(makeNode('wall', { name: 'Wall', at: [10, 0, 0], solid: true }));
    root.updateWorldMatrix(true, true);

    expect(raycastBotNodes(makeScene([root]), { x: 0, y: 0 }, { x: 1, y: 0 })?.node.name).toBe(
      'Wall'
    );
  });

  it('answers null for a zero-length direction instead of dividing by it', () => {
    const root = makeNode('root');
    root.adoptChild(makeNode('wall', { at: [10, 0, 0], solid: true }));
    expect(raycastBotNodes(makeScene([root]), { x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});

describe('projectToCanvasFraction', () => {
  it('turns a world point into canvas-box fractions', () => {
    // The projection here maps world (0,0) to pixel (100,100) on a 200×200 canvas.
    expect(projectToCanvasFraction(makeScene([]), canvas, 0, 0)).toEqual({ nx: 0.5, ny: 0.5 });
    expect(projectToCanvasFraction(makeScene([]), canvas, 50, 0)).toEqual({ nx: 0.75, ny: 0.5 });
  });

  it('answers null when the scene cannot project or the canvas has no size', () => {
    expect(projectToCanvasFraction(makeScene([], false), canvas, 0, 0)).toBeNull();
    const empty: BotCanvasHandle = {
      width: 0,
      height: 0,
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
    };
    expect(projectToCanvasFraction(makeScene([]), empty, 0, 0)).toBeNull();
  });
});

describe('PhysicalAxisDriver', () => {
  /** A stand-in for a live `Joystick2D`: the three fields the driver duck-types on. */
  function makeStick(
    id: string,
    options: { radius?: number; horizontal?: string; vertical?: string; at?: [number, number] } = {}
  ): TestNode {
    const node = makeNode(id, { name: id, type: 'Joystick2D' });
    const [x, y] = options.at ?? [0, 0];
    node.position.set(x, y, 0);
    Object.assign(node, {
      radius: options.radius ?? 40,
      axisHorizontal: options.horizontal ?? 'Horizontal',
      axisVertical: options.vertical ?? 'Vertical',
    });
    node.updateWorldMatrix(true, true);
    return node;
  }

  it('presses at the centre first, then travels out — the control own rule', () => {
    const root = makeNode('root');
    root.adoptChild(makeStick('MoveStick', { radius: 40 }));
    root.updateWorldMatrix(true, true);
    const sink = makeSink();
    const driver = new PhysicalAxisDriver(makeScene([root]), canvas, sink);

    expect(driver.steer('Horizontal', 1)).toBeNull();

    // A press outside the radius does not start the drag at all, so the finger has to
    // land on the base and then move — two events, in that order.
    expect(sink.events).toEqual([
      `pointer:down:0.500,0.500:${BOT_STICK_POINTER_BASE}`,
      `pointer:move:0.700,0.500:${BOT_STICK_POINTER_BASE}`,
    ]);
  });

  it('accumulates the two axes into ONE finger position, so a diagonal is possible', () => {
    const root = makeNode('root');
    root.adoptChild(makeStick('MoveStick', { radius: 40 }));
    root.updateWorldMatrix(true, true);
    const sink = makeSink();
    const driver = new PhysicalAxisDriver(makeScene([root]), canvas, sink);

    driver.steer('Horizontal', 1);
    sink.events.length = 0;
    driver.steer('Vertical', 1);

    // The second call must re-aim the SAME pointer at the combined vector, clamped to
    // the rim (1/√2 each). Treating each call as its own gesture would send the finger
    // straight right and then straight up, and the stick would never read diagonal.
    const at = 1 / Math.SQRT2;
    expect(sink.events).toEqual([
      `pointer:move:${(0.5 + (at * 40) / 200).toFixed(3)},${(0.5 - (at * 40) / 200).toFixed(3)}:${BOT_STICK_POINTER_BASE}`,
    ]);
  });

  it('clamps past the rim instead of aiming outside the base', () => {
    const root = makeNode('root');
    root.adoptChild(makeStick('MoveStick', { radius: 40 }));
    root.updateWorldMatrix(true, true);
    const sink = makeSink();
    const driver = new PhysicalAxisDriver(makeScene([root]), canvas, sink);

    driver.steer('Horizontal', 1);
    const atRim = sink.events[1];
    sink.events.length = 0;
    // A driver handed 1 twice must not drift further out: the clamp is what keeps the
    // aim inside the radius, which is what keeps the drag alive.
    driver.steer('Horizontal', 1);
    expect(sink.events[0]).toBe(atRim);
  });

  it('lifts the finger when the policy centres the stick', () => {
    const root = makeNode('root');
    root.adoptChild(makeStick('MoveStick'));
    root.updateWorldMatrix(true, true);
    const sink = makeSink();
    const driver = new PhysicalAxisDriver(makeScene([root]), canvas, sink);

    driver.steer('Horizontal', 1);
    sink.events.length = 0;
    driver.steer('Horizontal', 0);

    // Not a press at the middle: a held stick keeps the control's `pressed` flag up, so
    // a policy that stopped moving would leave the game thinking a finger is still on it.
    expect(sink.events).toEqual([`pointer:up:0.500,0.500:${BOT_STICK_POINTER_BASE}`]);
    // And centring twice does not send a second release.
    sink.events.length = 0;
    driver.steer('Horizontal', 0);
    expect(sink.events).toEqual([]);
  });

  it('gives each stick its own finger', () => {
    const root = makeNode('root');
    root.adoptChild(makeStick('MoveStick', { at: [-50, 0] }));
    root.adoptChild(makeStick('AimStick', { at: [50, 0], horizontal: 'AimX', vertical: 'AimY' }));
    root.updateWorldMatrix(true, true);
    const sink = makeSink();
    const driver = new PhysicalAxisDriver(makeScene([root]), canvas, sink);

    driver.steer('Horizontal', 1);
    driver.steer('AimX', -1);

    const ids = new Set(sink.events.map(event => event.split(':').pop()));
    expect(ids.size).toBe(2);
  });

  it('releases everything still held', () => {
    const root = makeNode('root');
    root.adoptChild(makeStick('MoveStick'));
    root.updateWorldMatrix(true, true);
    const sink = makeSink();
    const driver = new PhysicalAxisDriver(makeScene([root]), canvas, sink);

    driver.steer('Horizontal', 1);
    sink.events.length = 0;
    driver.releaseAll();
    expect(sink.events).toEqual([`pointer:up:0.500,0.500:${BOT_STICK_POINTER_BASE}`]);

    // Idempotent: the run's teardown calls this from a `finally` that can be reached
    // twice on an error path.
    sink.events.length = 0;
    driver.releaseAll();
    expect(sink.events).toEqual([]);
  });

  it('refuses an axis a slider owns, and says what WOULD work', () => {
    const root = makeNode('root');
    const slider = makeNode('Volume', { name: 'Volume', type: 'Slider2D' });
    Object.assign(slider, { axisName: 'Volume' });
    root.adoptChild(slider);
    root.updateWorldMatrix(true, true);
    const driver = new PhysicalAxisDriver(makeScene([root]), canvas, makeSink());

    const refusal = driver.steer('Volume', 0.6);
    expect(refusal).toContain('Slider2D');
    expect(refusal).toContain('dragged along a track');
    expect(refusal).toContain('direct-action');
  });

  it('refuses an axis no control writes, and names the reason', () => {
    const driver = new PhysicalAxisDriver(makeScene([makeNode('root')]), canvas, makeSink());
    const refusal = driver.steer('Throttle', 1);
    // The load-bearing fact: the runtime has no keyboard-to-axis binding, so there is
    // genuinely nothing to touch. A refusal that did not say so would read as a bug.
    expect(refusal).toContain('no keyboard-to-axis binding');
    expect(refusal).toContain('Throttle');
  });

  it('refuses when the stick cannot be projected, rather than aiming at nothing', () => {
    const root = makeNode('root');
    root.adoptChild(makeStick('MoveStick'));
    root.updateWorldMatrix(true, true);
    const driver = new PhysicalAxisDriver(makeScene([root], false), canvas, makeSink());
    expect(driver.steer('Horizontal', 1)).toContain('could not be projected');
  });
});
