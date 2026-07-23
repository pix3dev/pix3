/**
 * Public contract shared between the headless Scene lane pipeline ({@link
 * import('./Scene3DGenService').Scene3DGenService}) and the (separately-owned) panel UI. Kept
 * dependency-free so both can import it without pulling in DI. Mirrors {@link
 * import('../model-gen-types')} — the pass/review/usage/log primitives are reused verbatim so the
 * Phase-3 machinery slots in unchanged; only the inputs (a brief + inventory) and the artifact (a
 * `.pix3scene` YAML document) differ from the model lane.
 */

import type {
  LlmUsageAggregate,
  ModelGenLogEntry,
  ModelGenMode,
  PassRecord,
  PendingReview,
  ReferenceImageInput,
} from '@/services/model-gen/model-gen-types';
import type { LevelSpec } from '@/services/model-gen/scene/LevelSpec';

/** Scene-lane pipeline lifecycle status. */
export type SceneGenStatus =
  | 'idle'
  | 'intake'
  | 'inventory'
  | 'speccing'
  | 'building'
  | 'validating'
  | 'rendering'
  | 'reviewing'
  | 'done'
  | 'error'
  | 'cancelled';

/** Everything the scene pipeline needs to start one generation job. */
export interface SceneGenInput {
  brief: string;
  referenceImages?: ReferenceImageInput[];
  mode?: ModelGenMode;
  /**
   * A `res://` or project-relative path to an existing `.pix3scene` to EDIT. When set, the pipeline
   * loads that scene, seeds the pass loop with it, and runs the lighter edit pass plan (dressing →
   * lighting → polish) so codegen modifies the scene per the brief instead of authoring from scratch.
   */
  baseScenePath?: string;
}

/** One usable building block discovered by the inventory scan (the level "palette"). */
export interface InventoryItem {
  /** Stable slug of the project-relative path — the id the LevelSpec/YAML palette references. */
  id: string;
  /** `res://`-prefixed project-relative path. */
  path: string;
  category: 'model' | 'prefab' | 'texture';
  bytes: number;
  /** Optional one-line vision caption (unused in MVP; a follow-up fills it). */
  caption?: string;
}

/** The inventory scan result: the palette plus per-category counts. */
export interface InventorySummary {
  items: InventoryItem[];
  counts: { model: number; prefab: number; texture: number };
}

/** The full observable state of the Scene lane generation pipeline. */
export interface SceneGenState {
  status: SceneGenStatus;
  stageLabel: string;
  log: readonly ModelGenLogEntry[];
  levelSpec: LevelSpec | null;
  /** The latest VALID scene YAML (what the panel parses + previews), or null. */
  sceneYaml: string | null;
  passes: readonly PassRecord[];
  currentPassId: string | null;
  pendingReview: PendingReview | null;
  inventory: InventorySummary | null;
  /** Bumps whenever a NEW valid `sceneYaml` is ready to preview. */
  sceneRevision: number;
  usage: LlmUsageAggregate;
  error: string | null;
  /** `false` while a job runs. */
  canGenerate: boolean;
  /** The path the current YAML was saved to, or null before a save. */
  savedPath: string | null;
}
