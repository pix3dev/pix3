/**
 * Public contract shared between the headless Model Lab pipeline ({@link
 * import('./Model3DGenService').Model3DGenService}) and the panel UI. Kept dependency-free so both
 * the service and the (separately-owned) panel can import it without pulling in DI.
 */

import type { Assessment, SculptSpec } from '@/services/model-gen/SculptSpec';

export type { Assessment, SculptMaterial, SculptComponent, SculptSpec, SpecValidation } from '@/services/model-gen/SculptSpec';

/** Generation depth: `fast` = fewer passes, `quality` = the full pipeline. */
export type ModelGenMode = 'fast' | 'quality';

/** How involved the subject is — drives the spec's minimum component count. */
export type ComplexityHint = 'simple' | 'moderate' | 'complex';

/** A reference image supplied as base64 WITHOUT the `data:` URI prefix. */
export interface ReferenceImageInput {
  mimeType: string;
  base64: string;
}

/** Everything the pipeline needs to start one generation job. */
export interface ModelGenInput {
  referenceImage?: ReferenceImageInput | null;
  prompt?: string;
  complexity?: ComplexityHint;
  mode?: ModelGenMode;
}

/** Pipeline lifecycle status. */
export type ModelGenStatus =
  | 'idle'
  | 'intake'
  | 'assessing'
  | 'speccing'
  | 'building'
  | 'compiling'
  | 'rendering'
  | 'reviewing'
  | 'done'
  | 'error'
  | 'cancelled';

/**
 * One locked build pass. The first block is the model lane (`form-material` is the `fast`-mode merge
 * of form + material); the second block is the Scene lane (`lighting` is shared between the two).
 */
export type PassId =
  | 'blockout'
  | 'structure'
  | 'form'
  | 'material'
  | 'lighting'
  | 'optimization'
  | 'form-material'
  // Scene lane passes.
  | 'layout'
  | 'placement'
  | 'dressing'
  | 'polish';

/** Per-pass lifecycle in the Phase-3 review loop. */
export type PassStatus = 'pending' | 'running' | 'reviewing' | 'passed' | 'failed' | 'skipped';

/** The observable record for one pass in {@link ModelGenState.passes}. */
export interface PassRecord {
  id: PassId;
  label: string;
  status: PassStatus;
  /** Latest vision fidelity score in [0,1], or null before a review (or when review is disabled). */
  score: number | null;
  /** How many times this pass built its factory (initial build + refines). */
  attempts: number;
  /** The latest reference|render comparison sheet as a PNG data URL, or null. */
  sheetDataUrl: string | null;
  /** The latest review rationale, or null. */
  rationale: string | null;
}

/** What the vision review (or a manual override) decided about a pass. */
export type ReviewDecision = 'continue' | 'refine-code' | 'refine-spec' | 'stop';

/** A review awaiting a manual decision (only present while `pauseForReview` is on). */
export interface PendingReview {
  passId: PassId;
  score: number;
  /** The vision model's own suggested decision (the manual gate may override it). */
  decision: ReviewDecision;
  rationale: string;
  sheetDataUrl: string;
}

/** One line in the streaming pipeline log. */
export interface ModelGenLogEntry {
  id: string;
  level: 'info' | 'llm' | 'warn' | 'error' | 'success';
  text: string;
  at: number;
}

/** Token usage accumulated across every LLM call in a job. */
export interface LlmUsageAggregate {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  calls: number;
}

/** The full observable state of the Model Lab generation pipeline. */
export interface ModelGenState {
  status: ModelGenStatus;
  stageLabel: string;
  log: readonly ModelGenLogEntry[];
  assessment: Assessment | null;
  spec: SculptSpec | null;
  factoryCode: string | null;
  /** Bumps whenever {@link import('./Model3DGenService').Model3DGenService.getModel} has a new Group. */
  modelRevision: number;
  usage: LlmUsageAggregate;
  error: string | null;
  /** `false` while a job runs. */
  canGenerate: boolean;
  /** The pass records for the current/last job (empty before the first Phase-3 pass loop). */
  passes: readonly PassRecord[];
  /** The pass currently building/reviewing, or null when no pass is active. */
  currentPassId: PassId | null;
  /** A review awaiting the user's decision, or null. Only set while `pauseForReview` is on. */
  pendingReview: PendingReview | null;
}
