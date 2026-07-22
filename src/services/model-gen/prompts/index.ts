/**
 * Prompt modules for the Model Lab pipeline. Each builder returns a `{ system, systemStableChars,
 * user }` triple: the **system** half is the request-stable prefix (role + contract + rubrics) and
 * `systemStableChars` is its length, so the Anthropic cache hint keeps that big prefix cached across
 * the many calls of one job; the **user** half carries the per-call volatile payload (assessment,
 * spec, previous error). Keep the exported strings lean and in a stable order — reordering or
 * padding them busts the cache prefix.
 */

import type { Assessment, SculptSpec } from '@/services/model-gen/SculptSpec';

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
