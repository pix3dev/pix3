/**
 * Deterministic scatter expander for the Scene lane. `Scatter` is Model-Lab authoring *sugar*: the
 * codegen may emit ONE compact meta-node ({@link SCATTER_NODE_TYPE}) instead of hand-listing dozens
 * of near-identical props. This module walks a parsed `.pix3scene` doc and REPLACES each `Scatter`
 * node with a plain `Group` whose children are `count` concrete nodes (`MeshInstance` for a
 * `.glb/.gltf` asset, else a prefab `instance:` node), each with a jittered-but-DETERMINISTIC
 * transform driven by a seeded PRNG (no `Math.random`). It runs in the pass loop AFTER codegen parses
 * the YAML but BEFORE the validation gate, so `Scatter` NEVER reaches the saved file — the persisted
 * scene contains only real node types and carries zero Model-Lab runtime dependency.
 *
 * Pure (no DI, no I/O) so it is trivially unit-testable and callable from anywhere.
 */

/** The authoring-sugar node type this module expands away. Never a real runtime node type. */
export const SCATTER_NODE_TYPE = 'Scatter';

/** Result of {@link expandScatterDirectives}: the transformed doc, count expanded, and any warnings. */
export interface ScatterExpansion {
  doc: unknown;
  expandedCount: number;
  warnings: string[];
}

interface ExpandContext {
  expandedCount: number;
  warnings: string[];
}

const DEFAULT_SCALE_RANGE: [number, number] = [1, 1];
const DEFAULT_ROTATION_Y_RANGE: [number, number] = [0, 360];

/**
 * Walk the whole doc (root array + every node's `children`, recursively) and replace each
 * `type: 'Scatter'` node with a concrete `Group`. A malformed directive (missing a usable `asset` or
 * `count`) is LEFT in place and a warning is pushed — the downstream validation gate then rejects the
 * leftover unknown `Scatter` type, surfacing the problem rather than silently dropping content.
 * Returns the transformed doc plus how many directives were expanded and the warnings collected.
 */
export function expandScatterDirectives(doc: unknown): ScatterExpansion {
  const ctx: ExpandContext = { expandedCount: 0, warnings: [] };
  if (!isRecord(doc)) {
    return { doc, expandedCount: 0, warnings: [] };
  }

  const root = (doc as { root?: unknown }).root;
  if (Array.isArray(root)) {
    (doc as Record<string, unknown>).root = root.map(node => transformNode(node, ctx));
  }

  return { doc, expandedCount: ctx.expandedCount, warnings: ctx.warnings };
}

// -- internals ---------------------------------------------------------------

/** Transform one node: expand it when it is a `Scatter`, else recurse into its `children`. */
function transformNode(node: unknown, ctx: ExpandContext): unknown {
  if (!isRecord(node)) {
    return node;
  }
  if (node.type === SCATTER_NODE_TYPE) {
    return expandOne(node, ctx);
  }
  const children = node.children;
  if (Array.isArray(children)) {
    node.children = children.map(child => transformNode(child, ctx));
  }
  return node;
}

/**
 * Expand a single `Scatter` directive into a `Group` of `count` concrete nodes. Returns the original
 * node unchanged (plus a warning) when the directive is malformed.
 */
function expandOne(node: Record<string, unknown>, ctx: ExpandContext): unknown {
  const id = typeof node.id === 'string' && node.id.trim() ? node.id : '(unknown id)';
  const props = isRecord(node.properties) ? node.properties : {};

  const asset = props.asset;
  const count = props.count;
  if (typeof asset !== 'string' || !asset.trim()) {
    ctx.warnings.push(`Scatter node "${id}" is missing a valid 'asset'; left unexpanded.`);
    return node;
  }
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) {
    ctx.warnings.push(`Scatter node "${id}" is missing a valid positive 'count'; left unexpanded.`);
    return node;
  }

  const total = Math.floor(count);
  const area = isRecord(props.area) ? props.area : {};
  const center = numericTriple(area.center) ?? [0, 0, 0];
  const size = numericPair(area.size) ?? [0, 0];
  const yRange = numericPair(props.yRange);
  const scaleRange = numericPair(props.scaleRange) ?? DEFAULT_SCALE_RANGE;
  const rotationYRange = numericPair(props.rotationYRange) ?? DEFAULT_ROTATION_Y_RANGE;
  const idPrefix =
    typeof props.idPrefix === 'string' && props.idPrefix.trim() ? props.idPrefix.trim() : id;

  const seed = typeof props.seed === 'number' && Number.isFinite(props.seed) ? props.seed : 0;
  const rand = mulberry32(seed >>> 0);

  const [cx, cy, cz] = center;
  const [sx, sz] = size;

  const children: unknown[] = [];
  for (let i = 0; i < total; i++) {
    // Fixed draw order per child keeps output fully deterministic for a given seed + config.
    const px = cx - sx / 2 + rand() * sx;
    const pz = cz - sz / 2 + rand() * sz;
    const py = yRange ? yRange[0] + rand() * (yRange[1] - yRange[0]) : cy;
    const scale = scaleRange[0] + rand() * (scaleRange[1] - scaleRange[0]);
    const rotationY = rotationYRange[0] + rand() * (rotationYRange[1] - rotationYRange[0]);

    const transform = {
      position: [round(px), round(py), round(pz)],
      rotationEuler: [0, round(rotationY), 0],
      scale: [round(scale), round(scale), round(scale)],
    };
    children.push(makeChild(`${idPrefix}-${i}`, asset, transform));
  }

  ctx.expandedCount += 1;
  const group: Record<string, unknown> = { id: node.id, type: 'Group' };
  if (typeof node.name === 'string' && node.name.trim()) {
    group.name = node.name;
  }
  group.children = children;
  return group;
}

/** A concrete scattered node: a `MeshInstance` for a GLB/GLTF asset, else a prefab `instance:` node. */
function makeChild(childId: string, asset: string, transform: Record<string, unknown>): unknown {
  if (/\.(glb|gltf)$/i.test(asset.trim())) {
    return { id: childId, type: 'MeshInstance', properties: { src: asset, transform } };
  }
  return { id: childId, instance: asset, properties: { transform } };
}

/** A seeded PRNG (mulberry32) — deterministic, no dependency on `Math.random`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Round to 4 decimals so the emitted YAML stays clean and the output is byte-stable. */
function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce a value to a numeric [a, b] pair, or undefined if it isn't one. */
function numericPair(value: unknown): [number, number] | undefined {
  if (Array.isArray(value) && value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
    return [value[0], value[1]];
  }
  return undefined;
}

/** Coerce a value to a numeric [x, y, z] triple, or undefined if it isn't one. */
function numericTriple(value: unknown): [number, number, number] | undefined {
  if (
    Array.isArray(value) &&
    value.length >= 3 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1]) &&
    isFiniteNumber(value[2])
  ) {
    return [value[0], value[1], value[2]];
  }
  return undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
