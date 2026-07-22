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
  | 'done'
  | 'error'
  | 'cancelled';

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
}
