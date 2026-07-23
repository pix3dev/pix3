/**
 * Prompt modules for the Scene lane pipeline. Each builder returns a `{ system, systemStableChars,
 * user }` triple: the **system** half is the request-stable prefix (role + node cheat-sheet + rules)
 * so the Anthropic cache hint keeps that big prefix cached across the many calls of one job; the
 * **user** half carries the per-call volatile payload (brief, LevelSpec, palette, current YAML,
 * feedback). Keep the exported strings lean and in a stable order — reordering or padding busts the
 * cache prefix. Mirrors {@link import('../prompts')} for the model lane.
 */

import type { ModelGenMode, PassId } from '@/services/model-gen/model-gen-types';
import type { LevelSpec } from '@/services/model-gen/scene/LevelSpec';
import type { InventorySummary } from '@/services/model-gen/scene/scene-gen-types';

const JSON_ONLY = 'Respond with only the JSON, no prose, no code fences.';
const YAML_ONLY =
  'Output ONLY the .pix3scene YAML document. No prose, no markdown fences, no explanation.';

/**
 * Compact node/type cheat-sheet: the palette of node types a `.pix3scene` may use plus their key
 * properties and the transform format. Shared (stable) prefix for every codegen call of a job.
 */
export const SCENE_NODE_CHEATSHEET = [
  'A .pix3scene is a YAML document:',
  '  version: "1.0"',
  '  metadata: {}            # optional',
  '  description: "…"        # optional',
  '  root:                   # an array of node definitions',
  '    - id: <unique-string> # every node needs a unique id',
  '      type: <NodeType>    # one of the allowed types below (omit ONLY for a prefab instance)',
  '      name: <optional>',
  '      properties: { … }',
  '      children: [ … ]     # nested node definitions',
  '',
  'A prefab/sub-scene is referenced by instance (NO type):',
  "    - id: <unique> \n      instance: 'res://path/to/prefab.pix3scene'",
  '',
  '3D transform lives in properties.transform:',
  '  transform: { position: [x,y,z], rotationEuler: [x,y,z] (degrees), scale: [x,y,z] }',
  '',
  'Allowed node types and their key properties:',
  '- Node3D / Group            : structural container (transform only).',
  '- GeometryMesh              : a primitive. properties.geometry = box|sphere|cylinder|cone|torus|plane;',
  '                              properties.size = [x,y,z]; properties.material = { type, color:"#RRGGBB",',
  '                              roughness:0..1, metalness:0..1, map?, aoMap? }.',
  "- MeshInstance              : a GLB model. properties.src = 'res://….glb'.",
  '- InstancedMesh3D           : many copies of one mesh (properties.maxInstances).',
  '- Camera3D                  : properties = { projection:perspective|orthographic, fov, near, far }.',
  '- DirectionalLightNode      : { color:"#RRGGBB", intensity, castShadow }.',
  '- PointLightNode            : { color, intensity, distance, decay }.',
  '- SpotLightNode             : { color, intensity, distance, angle, penumbra }.',
  '- AmbientLightNode          : { color, intensity }.',
  '- HemisphereLightNode       : { skyColor, groundColor, intensity }.',
  '- Sprite3D / AnimatedSprite3D / Particles3D / PostProcess / AudioPlayer : as needed.',
  '',
  'Scale conventions: metres, Y-up. A door ≈ 2m tall; a human ≈ 1.8m. Keep sizes physically sane.',
].join('\n');

/** Hard rules the generated YAML must satisfy (also enforced by the deterministic validate gate). */
export const SCENE_YAML_RULES = [
  'Hard rules:',
  '- Use ONLY the allowed node types above. Never invent a type; never use Layout2D.',
  "- Every res:// reference (MeshInstance.src, prefab instance, material map/aoMap, textures) MUST be",
  '  an id/path from the provided palette. Never reference an asset that is not in the palette.',
  '- Every node needs a unique id across the whole document.',
  '- Use the transform format exactly: properties.transform.position/rotationEuler(deg)/scale.',
  '- Build the WHOLE scene as one document (whole-file regeneration each pass).',
].join('\n');

/**
 * Authoring-sugar note for repetition. `Scatter` is expanded deterministically into a `Group` of real
 * nodes BEFORE validation, so it never reaches the saved file — but it lets the model express dozens
 * of scattered props in one node instead of listing each by hand. Included as a stable prefix so the
 * cache prefix is unchanged across codegen calls; the dressing pass leans on it most.
 */
export const SCENE_SCATTER_SUGAR = [
  'Repetition sugar (OPTIONAL): to place MANY copies of one palette asset with varied transforms, you',
  'MAY emit a single meta-node instead of listing each copy by hand:',
  '  - id: <unique>',
  '    type: Scatter',
  '    properties:',
  "      asset: 'res://path/from/palette.glb'   # a palette .glb/.gltf, or a .pix3scene prefab",
  '      count: 12                              # how many copies',
  '      seed: 7                                # any integer — makes the layout deterministic',
  '      area: { center: [x,y,z], size: [sx,sz] }   # copies scatter within this XZ rectangle',
  '      yRange: [min,max]                      # optional vertical jitter (defaults to center.y)',
  '      scaleRange: [min,max]                  # optional uniform scale jitter (defaults to 1)',
  '      rotationYRange: [minDeg,maxDeg]        # optional Y-rotation jitter (defaults to 0..360)',
  '      idPrefix: rock                         # optional child id prefix (defaults to the node id)',
  'The tool expands this into a Group of concrete nodes; asset/count are REQUIRED. Use real palette',
  'assets only. Prefer Scatter over hand-listing when placing repeated props.',
].join('\n');

const LEVEL_SPEC_SYSTEM = [
  'You are a level designer planning a 3D scene for the Pix3 engine. Given a brief and the available',
  'asset palette, produce a "level spec": the zones/areas, how the palette dresses them, the lighting',
  'plan and the camera intent. Only plan with assets that exist in the palette.',
  '',
  SCENE_NODE_CHEATSHEET,
  '',
  'Return a JSON object with exactly these fields:',
  '  title: string',
  '  brief: string                — restate the brief you are building to',
  '  zones: Array<{ id: string; name: string; purpose: string;',
  '                 approxBoundsMeters?: [number,number,number]; paletteAssetIds?: string[] }>',
  '  lightingPlan: string         — how the scene is lit (mood, key/fill, time of day)',
  '  cameraIntent: string         — where the camera sits and what it frames',
  '  paletteAssetIds: string[]    — palette ids the level may use (must all exist in the palette)',
  '  paletteGaps?: Array<{ need: string; suggestedPrompt: string }>',
  '                               — assets the brief calls for that the palette LACKS. For each gap,',
  '                                 "need" names the missing asset and "suggestedPrompt" is a concise,',
  '                                 ready-to-use prompt to generate that single 3D model. Populate this',
  '                                 only when the brief implies an asset absent from the palette; leave',
  '                                 it empty ([]) or omit it when the palette already covers the brief.',
  '  notes?: string',
  '',
  'Quality gate (your response is rejected if it fails): title and brief non-empty; zones non-empty,',
  'each with id/name/purpose; every paletteAssetIds entry must be a real palette id.',
  '',
  JSON_ONLY,
].join('\n');

const SCENE_FACTORY_SYSTEM = [
  'You are an expert Pix3 level builder. You author a complete .pix3scene YAML document that realizes',
  'a level spec using the available asset palette.',
  '',
  SCENE_NODE_CHEATSHEET,
  '',
  SCENE_YAML_RULES,
  '',
  SCENE_SCATTER_SUGAR,
  '',
  YAML_ONLY,
].join('\n');

const SCENE_REVIEW_SYSTEM = [
  'You are a meticulous level-design reviewer. You are given a comparison sheet of one or more RENDERED',
  'viewpoints of a procedurally generated 3D scene (a top-down layout view and a 3/4 perspective view,',
  'plus any reference/concept images). Judge how well the scene realizes the brief and level spec for',
  'THIS build pass only, using the rubric provided in the user message. Be honest and calibrated —',
  'cheap approval is worse than useless. Ignore issues a later pass will address.',
  '',
  'Return a JSON object with exactly these fields:',
  '  globalScore: number      — overall fidelity for this pass, 0.0 (wrong) to 1.0 (matches the intent)',
  '  featureScores: Array<{ feature: string; score: number(0..1) }>  — per-aspect breakdown',
  '  decision: "continue" | "refine-code" | "refine-spec" | "stop"',
  '  rationale: string        — one or two sentences justifying the score and decision',
  '',
  'decision meanings:',
  '  "continue"    — good enough for this pass; advance to the next.',
  '  "refine-code" — close but fixable by regenerating the scene YAML for this pass.',
  '  "refine-spec" — the level plan itself is off; regenerate with plan-level feedback.',
  '  "stop"        — a fundamental mismatch that more building will not fix.',
  '',
  JSON_ONLY,
].join('\n');

/** One entry of a mode's ordered scene pass plan. */
export interface ScenePassPlanEntry {
  id: PassId;
  label: string;
  /** The codegen instruction for this pass (what to add / refine). */
  goal: string;
  /** What the vision review judges for this pass. */
  reviewRubric: string;
}

/** The `quality`-mode scene passes, in order. */
const QUALITY_SCENE_PASSES: readonly ScenePassPlanEntry[] = [
  {
    id: 'layout',
    label: 'Layout',
    goal: 'Establish the ground plane and block out each zone as GeometryMesh primitives (boxes/planes) at the correct footprint, position and scale. No hero assets yet — just readable massing of the zones from the level spec.',
    reviewRubric:
      'Layout legibility vs the brief — are the zones present, correctly sized and sensibly arranged on the ground plane?',
  },
  {
    id: 'placement',
    label: 'Placement',
    goal: 'Place the hero assets and architecture: instantiate the palette GLB models (MeshInstance) and prefabs (instance) that each zone calls for, at plausible positions/rotations/scales. Keep the blockout ground.',
    reviewRubric:
      'Major placement vs the level spec — are the key assets present in the right zones at a sane scale (door ≈ 2m)?',
  },
  {
    id: 'dressing',
    label: 'Set dressing',
    goal: 'Add props and repetition to make the zones feel populated: repeat palette assets with VARIED transforms (position/rotation/scale jitter) so nothing looks tiled. Use only palette assets.',
    reviewRubric:
      'Set dressing vs the brief — asset variety, believable repetition without obvious tiling, and zone coverage.',
  },
  {
    id: 'lighting',
    label: 'Lighting',
    goal: 'Light the scene per the lighting plan: add light nodes (Directional/Point/Spot) plus an Ambient or Hemisphere fill, and add a Camera3D that frames the scene per the camera intent.',
    reviewRubric:
      'Lighting mood and camera framing vs the brief — depth, contrast, and a camera that reads the scene well.',
  },
  {
    id: 'polish',
    label: 'Polish',
    goal: 'Clean up: remove redundant/overlapping nodes, fix any scale outliers, ensure unique ids and a sane node count, and confirm the camera framing. Preserve the achieved look.',
    reviewRubric:
      'Final composition vs the brief with no regressions — scale sanity, clean layout, and overall polish.',
  },
];

/** The `fast`-mode scene passes, in order. */
const FAST_SCENE_PASSES: readonly ScenePassPlanEntry[] = [
  QUALITY_SCENE_PASSES[0],
  {
    id: 'dressing',
    label: 'Placement & dressing',
    goal: 'In one pass, place the hero palette assets/prefabs into their zones AND dress them with varied repetition, so the scene is populated and reads as the intended level. Use only palette assets.',
    reviewRubric:
      'Combined placement + dressing vs the brief — key assets present, sane scale, and believable variety.',
  },
  {
    id: 'polish',
    label: 'Polish',
    goal: 'Add lighting per the lighting plan (light nodes + ambient/hemisphere fill) and a Camera3D framing the scene per the camera intent, then clean up scale/id/count issues. Preserve the look.',
    reviewRubric:
      'Lighting, camera framing and final composition vs the brief with no regressions.',
  },
];

/** The ordered scene pass plan for a generation mode. Returns a fresh array each call. */
export function getScenePassPlan(mode: ModelGenMode): ScenePassPlanEntry[] {
  return mode === 'fast' ? [...FAST_SCENE_PASSES] : [...QUALITY_SCENE_PASSES];
}

/** Lookup the quality-mode entry for a pass id (the edit plan reuses these well-defined goals). */
function qualityPass(id: PassId): ScenePassPlanEntry {
  const found = QUALITY_SCENE_PASSES.find(pass => pass.id === id);
  if (!found) {
    throw new Error(`No quality scene pass "${id}".`);
  }
  return found;
}

/**
 * The pass plan for EDITING an existing scene. Layout and placement are skipped — the base scene
 * already has structure — so an edit run only dresses, (re)lights and polishes. `quality` runs the
 * full dressing → lighting → polish; `fast` collapses to dressing → polish (lighting folds into the
 * polish pass, as in the fast fresh plan). Returns a fresh array each call.
 */
export function getSceneEditPassPlan(mode: ModelGenMode): ScenePassPlanEntry[] {
  if (mode === 'fast') {
    return [qualityPass('dressing'), qualityPass('polish')];
  }
  return [qualityPass('dressing'), qualityPass('lighting'), qualityPass('polish')];
}

/** Codegen of the {@link LevelSpec} JSON from the brief + the asset palette. */
export function buildLevelSpecPrompt(
  brief: string,
  inventory: InventorySummary
): { system: string; systemStableChars: number; user: string } {
  const user = [
    'Brief:',
    brief.trim(),
    '',
    'Available asset palette:',
    formatPalette(inventory),
    '',
    'Produce the level spec JSON for this brief.',
  ].join('\n');
  return { system: LEVEL_SPEC_SYSTEM, systemStableChars: LEVEL_SPEC_SYSTEM.length, user };
}

/**
 * Codegen of the full `.pix3scene` YAML for ONE pass. The system half is the same stable cheat-sheet
 * + rules prefix as the other codegen calls (so the cache prefix is identical across the job); the
 * user half carries the level spec, palette, this pass's goal, the CURRENT YAML to evolve
 * (`previousYaml`, null for the first pass), and any `feedback` (validation errors or a review note).
 */
export function buildScenePassPrompt(
  levelSpec: LevelSpec,
  inventory: InventorySummary,
  pass: ScenePassPlanEntry,
  previousYaml: string | null,
  feedback: string | null,
  isEdit = false
): { system: string; systemStableChars: number; user: string } {
  const evolve = buildEvolveSection(previousYaml, isEdit);
  const intent = isEdit
    ? [
        '',
        'You are EDITING an existing scene, not authoring a new one. The level spec above describes the',
        'CHANGES to apply per the brief. Preserve the existing node ids and overall structure; add or',
        'adjust nodes only as the pass goal and brief require. Do not delete or renumber unrelated nodes.',
      ].join('\n')
    : '';
  const fix = feedback?.trim()
    ? ['', 'Address this feedback (validation errors or a review note):', feedback.trim()].join('\n')
    : '';
  const user = [
    `Build pass: ${pass.label}.`,
    `Goal for this pass: ${pass.goal}`,
    intent,
    '',
    isEdit ? 'Changes to apply (per the brief):' : 'Level spec:',
    JSON.stringify(levelSpec, null, 2),
    '',
    'Available asset palette:',
    formatPalette(inventory),
    evolve,
    fix,
    '',
    'Output only the full .pix3scene YAML document.',
  ].join('\n');
  return { system: SCENE_FACTORY_SYSTEM, systemStableChars: SCENE_FACTORY_SYSTEM.length, user };
}

/** The "here is the current YAML" section — worded for a fresh author vs. an edit of an existing scene. */
function buildEvolveSection(previousYaml: string | null, isEdit: boolean): string {
  if (previousYaml?.trim()) {
    const heading = isEdit
      ? 'Existing scene YAML (MODIFY it per the goal + brief; keep ids/structure intact):'
      : 'Current scene YAML (from the previous pass — EVOLVE it, do not start over):';
    return ['', heading, previousYaml.trim()].join('\n');
  }
  return ['', 'There is no scene yet — this is the first pass. Author the document from scratch.'].join(
    '\n'
  );
}

/**
 * Vision review of the rendered viewpoints for one pass. System is stable (generic reviewer contract
 * + JSON schema, reusable by {@link import('../model-gen-review').coerceReviewResult}); the per-pass
 * rubric and the level context ride in the user half.
 */
export function buildSceneReviewPrompt(
  levelSpec: LevelSpec,
  pass: ScenePassPlanEntry
): { system: string; systemStableChars: number; user: string } {
  const user = [
    `Level: ${levelSpec.title}.`,
    `Brief: ${levelSpec.brief}`,
    `Build pass under review: ${pass.label}.`,
    `Review rubric for this pass: ${pass.reviewRubric}`,
    '',
    'Judge the rendered viewpoints against the brief and level spec, and return the review JSON.',
  ].join('\n');
  return { system: SCENE_REVIEW_SYSTEM, systemStableChars: SCENE_REVIEW_SYSTEM.length, user };
}

/** Compact palette listing for the prompts: one line per item (id, category, size, path). */
function formatPalette(inventory: InventorySummary): string {
  if (inventory.items.length === 0) {
    return '(the project has no usable model/prefab/texture assets — build with GeometryMesh primitives only)';
  }
  const lines = inventory.items.map(item => {
    const caption = item.caption ? ` — ${item.caption}` : '';
    return `- ${item.id} [${item.category}, ${formatBytes(item.bytes)}] ${item.path}${caption}`;
  });
  const header = `Counts: ${inventory.counts.model} models, ${inventory.counts.prefab} prefabs, ${inventory.counts.texture} textures.`;
  return [header, ...lines].join('\n');
}

/** Human-readable byte size for the palette listing. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
