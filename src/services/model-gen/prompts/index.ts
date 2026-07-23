/**
 * Prompt modules for the Model Lab pipeline. Each builder returns a `{ system, systemStableChars,
 * user }` triple: the **system** half is the request-stable prefix (role + contract + rubrics) and
 * `systemStableChars` is its length, so the Anthropic cache hint keeps that big prefix cached across
 * the many calls of one job; the **user** half carries the per-call volatile payload (assessment,
 * spec, previous error). Keep the exported strings lean and in a stable order — reordering or
 * padding them busts the cache prefix.
 */

import type { Assessment, SculptSpec } from '@/services/model-gen/SculptSpec';
import type { ModelGenMode, PassId } from '@/services/model-gen/model-gen-types';

const JSON_ONLY = 'Respond with only the JSON, no prose, no code fences.';

/** The hard contract the generated factory module must satisfy (also enforced post-compile). */
export const CODE_CONTRACT = [
  'Output a single ES module that exports exactly:',
  '  export function createModel(THREE: typeof import("three")): THREE.Group',
  'Hard rules:',
  '- NO imports and NO require() of any kind. `THREE` is the injected parameter — use it for every',
  '  class (THREE.Group, THREE.Mesh, THREE.BoxGeometry, THREE.MeshStandardMaterial, …).',
  '- No DOM access except an OffscreenCanvas/`document.createElement("canvas")` used purely to bake',
  '  a CanvasTexture. No window, fetch, timers, or async — the function must be synchronous and pure.',
  '- Deterministic: never call Math.random(). If you need pseudo-randomness, define a seeded RNG:',
  '    const rng = (() => { let s = 0x9e3779b9 >>> 0; return () => {',
  '      s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);',
  '      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;',
  '      return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();',
  '- Materials: MeshStandardMaterial or MeshPhysicalMaterial ONLY. Never ShaderMaterial /',
  '  RawShaderMaterial — they do not survive GLB export.',
  '- Return one THREE.Group containing the whole model, centered near the origin, Y-up, in metres.',
  '- You may set group.userData.sculptRuntime = { … } (pivots/sockets) — it is preserved.',
].join('\n');

/** Compact geometry playbook. */
export const GEOMETRY_RUBRIC = [
  'Geometry toolkit: box/sphere/cylinder/cone/torus/plane primitives; ExtrudeGeometry (from a',
  'THREE.Shape) for panels, plates and profiles; LatheGeometry for radially-symmetric parts',
  '(bottles, domes, turned wood); TubeGeometry for pipes/cables; instancing / loops for repeated',
  'features (bolts, teeth, slats). Compose parts from several meshes rather than one blob; position',
  'and rotate each part explicitly. Bevel large flat edges lightly for a less CG look.',
].join('\n');

/** Compact PBR playbook. */
export const PBR_RUBRIC = [
  'PBR guidance: metals → metalness 0.9-1.0, roughness 0.2-0.5, colored base tint. Painted/plastic',
  '→ metalness 0, roughness 0.4-0.7. Rough organics (wood, stone, fabric) → metalness 0, roughness',
  '0.7-1.0. Keep base colors physically plausible (no pure #000000 / #ffffff). Use a CanvasTexture',
  'for grain/labels/wear when it adds fidelity; set texture.colorSpace = THREE.SRGBColorSpace.',
].join('\n');

const ASSESS_SYSTEM = [
  'You are a 3D art director analyzing a single reference image so a procedural Three.js pipeline can',
  'reconstruct the subject by code. Report what you see precisely and honestly.',
  '',
  'Only hard-surface OBJECTS are supported. If the main subject is a person, animal or creature, set',
  'category to "character". If you cannot tell what it is, set category to "unknown".',
  '',
  'Return a JSON object with exactly these fields:',
  '  objectClass: string   — a concise noun phrase, e.g. "brass steampunk pocket watch"',
  '  category: "object" | "character" | "unknown"',
  '  complexity: "simple" | "moderate" | "complex"',
  '  detailInventory: string[]  — the distinct visible features/parts worth modelling',
  '  notes?: string        — optional framing / material / scale observations',
  '',
  JSON_ONLY,
].join('\n');

const SPEC_SYSTEM = [
  'You are a 3D reconstruction planner. Given an assessment of a reference image, produce a',
  '"sculpt spec": the component hierarchy and materials a procedural Three.js factory will build.',
  '',
  'Return a JSON object with exactly these fields:',
  '  objectClass: string',
  '  category: "object"           — always "object"; character subjects are unsupported',
  '  complexity: "simple" | "moderate" | "complex"',
  '  summary: string              — one or two sentences describing the build approach',
  '  components: Array<{ id: string; name: string; role?: string; parentId?: string|null;',
  '                      approxSizeMeters?: [number,number,number]; materialId?: string; notes?: string }>',
  '  materials: Array<{ id: string; name: string; baseColorHex: "#RRGGBB";',
  '                     metalness: number(0..1); roughness: number(0..1); notes?: string }>',
  '  detailInventory: string[]',
  '',
  'Quality gate (your response is rejected if it fails): components non-empty and at least',
  '1 for simple / 3 for moderate / 5 for complex; materials non-empty with valid #RRGGBB colors and',
  'metalness/roughness in [0,1]; every component.materialId must reference a declared material id;',
  'detailInventory non-empty.',
  '',
  PBR_RUBRIC,
  '',
  JSON_ONLY,
].join('\n');

const FACTORY_SYSTEM = [
  'You are an expert Three.js technical artist. You write compact, deterministic procedural factories',
  'that reconstruct an object from a sculpt spec.',
  '',
  CODE_CONTRACT,
  '',
  GEOMETRY_RUBRIC,
  '',
  PBR_RUBRIC,
  '',
  'Output ONLY the module source code. No prose, no markdown fences, no explanation.',
].join('\n');

/** Vision assessment of the reference image. */
export function buildAssessPrompt(): { system: string; systemStableChars: number; user: string } {
  return {
    system: ASSESS_SYSTEM,
    systemStableChars: ASSESS_SYSTEM.length,
    user: 'Analyze the attached reference image and return the assessment JSON.',
  };
}

/** Codegen of the structured sculpt spec from the assessment (+ optional user intent). */
export function buildSpecPrompt(
  assessment: Assessment,
  userPrompt: string | undefined
): { system: string; systemStableChars: number; user: string } {
  const intent = userPrompt?.trim()
    ? `\n\nAdditional user intent (honor it where it does not conflict with the reference):\n${userPrompt.trim()}`
    : '';
  const user = [
    'Assessment of the reference image:',
    JSON.stringify(assessment, null, 2),
    intent,
    '',
    'Produce the sculpt spec JSON for this object.',
  ].join('\n');
  return { system: SPEC_SYSTEM, systemStableChars: SPEC_SYSTEM.length, user };
}

/** Codegen of the procedural factory module for a spec; `previousError` triggers a fix pass. */
export function buildFactoryPrompt(
  spec: SculptSpec,
  previousError?: string
): { system: string; systemStableChars: number; user: string } {
  const fix = previousError?.trim()
    ? [
        '',
        'Your previous attempt failed to compile or run with this error:',
        previousError.trim(),
        'Return a corrected full module that fixes it while still satisfying the contract.',
      ].join('\n')
    : '';
  const user = [
    'Build the procedural factory for this sculpt spec:',
    JSON.stringify(spec, null, 2),
    fix,
    '',
    'Output only the module source (a single `export function createModel(THREE)`).',
  ].join('\n');
  return { system: FACTORY_SYSTEM, systemStableChars: FACTORY_SYSTEM.length, user };
}

// -- Phase 3: locked-pass loop -----------------------------------------------

/** One entry of a mode's ordered pass plan. */
export interface PassPlanEntry {
  id: PassId;
  label: string;
  /** The codegen instruction for this pass (what to add / refine). */
  goal: string;
  /** What the vision review judges for this pass. */
  reviewRubric: string;
}

/** The `quality`-mode passes, in order. `fast` mode collapses form+material and drops structure. */
const QUALITY_PASSES: readonly PassPlanEntry[] = [
  {
    id: 'blockout',
    label: 'Blockout',
    goal: 'Rough primitive massing only: place simple boxes/cylinders/spheres at the correct overall proportions, position and scale. No detail, no bevels, one plain material is fine.',
    reviewRubric: 'Overall silhouette and proportions vs the reference — are the big masses the right size and in the right place?',
  },
  {
    id: 'structure',
    label: 'Structure',
    goal: "Separate the blockout into the spec's distinct components with correct parent/child placement and relative scale. Still primitive shapes, but every listed component now exists as its own mesh.",
    reviewRubric: 'Component breakdown vs the reference — are all the major parts present and correctly arranged?',
  },
  {
    id: 'form',
    label: 'Form',
    goal: 'Refine the silhouette: add bevels, curves, chamfers, tapers and profile detail (ExtrudeGeometry/LatheGeometry/TubeGeometry where they help). Make edges read as manufactured, not blocky.',
    reviewRubric: 'Silhouette fidelity and surface form vs the reference — do curves, bevels and contours match?',
  },
  {
    id: 'material',
    label: 'Material',
    goal: "Apply PBR materials per the spec: base colors, metalness and roughness that match the reference, with CanvasTextures for grain/labels/wear where they add fidelity.",
    reviewRubric: 'Material appearance vs the reference — color, metalness/roughness and surface finish per part.',
  },
  {
    id: 'lighting',
    label: 'Lighting',
    goal: 'Bake read-friendly cues into geometry/materials (vertex colors, subtle ambient-occlusion tinting, emissive where the reference glows) so the model reads well under neutral studio light. Do NOT add lights to the group.',
    reviewRubric: 'How the model reads under neutral light — depth, contrast and shading cues vs the reference.',
  },
  {
    id: 'optimization',
    label: 'Optimization',
    goal: 'Clean up: merge redundant meshes, remove hidden/degenerate geometry, keep a sane poly budget, and ensure the group is centered and Y-up. Preserve the achieved look.',
    reviewRubric: 'Final fidelity vs the reference with no regressions from the previous pass.',
  },
];

/** The `fast`-mode passes, in order. */
const FAST_PASSES: readonly PassPlanEntry[] = [
  QUALITY_PASSES[0],
  {
    id: 'form-material',
    label: 'Form & Material',
    goal: 'In one pass, refine the silhouette (bevels/curves/profiles) AND apply PBR materials (base color, metalness, roughness, CanvasTextures) so the model matches the reference in both shape and finish.',
    reviewRubric: 'Combined silhouette + material fidelity vs the reference.',
  },
];

/** The ordered pass plan for a generation mode. */
export function getPassPlan(mode: ModelGenMode): PassPlanEntry[] {
  return mode === 'fast' ? [...FAST_PASSES] : [...QUALITY_PASSES];
}

/**
 * Codegen of the procedural factory for ONE pass. The system half is the same stable code-contract
 * prefix as {@link buildFactoryPrompt} (so the Anthropic cache prefix is identical across every
 * codegen call of the job); the user half carries the spec, this pass's goal, the CURRENT factory
 * code to EVOLVE (`previousCode`, null for the first pass), and any `feedback` (a compile error or a
 * vision refine note). It must return the full `createModel(THREE)` module.
 */
export function buildPassFactoryPrompt(
  spec: SculptSpec,
  pass: PassPlanEntry,
  previousCode: string | null,
  feedback: string | null
): { system: string; systemStableChars: number; user: string } {
  const evolve = previousCode?.trim()
    ? [
        '',
        `Current factory code (from the previous pass — EVOLVE it, do not start over):`,
        previousCode.trim(),
      ].join('\n')
    : [
        '',
        'There is no previous code yet — this is the first pass. Write the module from scratch.',
      ].join('\n');
  const fix = feedback?.trim()
    ? ['', 'Address this feedback (a compile error or a review note):', feedback.trim()].join('\n')
    : '';
  const user = [
    `Build pass: ${pass.label}.`,
    `Goal for this pass: ${pass.goal}`,
    '',
    'Sculpt spec:',
    JSON.stringify(spec, null, 2),
    evolve,
    fix,
    '',
    'Output only the full module source (a single `export function createModel(THREE)`).',
  ].join('\n');
  return { system: FACTORY_SYSTEM, systemStableChars: FACTORY_SYSTEM.length, user };
}

const REVIEW_SYSTEM = [
  'You are a meticulous 3D reconstruction reviewer. You are given a single comparison sheet with two',
  'panels: the LEFT panel is the REFERENCE image; the RIGHT panel is a RENDER of a procedurally',
  'generated Three.js model at the current build pass. Judge how faithfully the render reproduces the',
  'reference for THIS pass only, using the rubric provided in the user message. Be honest and',
  'calibrated — cheap approval is worse than useless. Ignore differences a later pass will address.',
  '',
  'Return a JSON object with exactly these fields:',
  '  globalScore: number      — overall fidelity for this pass, 0.0 (unrecognizable) to 1.0 (matches)',
  '  featureScores: Array<{ feature: string; score: number(0..1) }>  — per-feature breakdown',
  '  decision: "continue" | "refine-code" | "refine-spec" | "stop"',
  '  rationale: string        — one or two sentences justifying the score and decision',
  '',
  'decision meanings:',
  '  "continue"    — good enough for this pass; advance to the next.',
  '  "refine-code" — close but fixable by regenerating the factory code for this pass.',
  '  "refine-spec" — the underlying plan is off; regenerate with plan-level feedback.',
  '  "stop"        — a fundamental mismatch that more code will not fix.',
  '',
  JSON_ONLY,
].join('\n');

/**
 * Vision review of the comparison sheet for one pass. System is stable (generic reviewer contract +
 * JSON schema) so its cache prefix is shared across every review call; the per-pass rubric rides in
 * the user half.
 */
export function buildReviewPrompt(
  spec: SculptSpec,
  pass: PassPlanEntry
): { system: string; systemStableChars: number; user: string } {
  const user = [
    `Subject: ${spec.objectClass}.`,
    `Build pass under review: ${pass.label}.`,
    `Review rubric for this pass: ${pass.reviewRubric}`,
    '',
    'Compare the Reference (left) with the Render (right) and return the review JSON.',
  ].join('\n');
  return { system: REVIEW_SYSTEM, systemStableChars: REVIEW_SYSTEM.length, user };
}
