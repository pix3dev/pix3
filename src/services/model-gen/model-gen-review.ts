/**
 * The vision-review result shape + a tolerant coercion of the raw JSON a vision model returns for a
 * pass review. Kept pure (no DI, no I/O) so it is trivially unit-testable and callable from the
 * orchestrator. Untrusted input is clamped/validated rather than trusted: scores are forced into
 * [0,1], the decision is validated against the enum (defaulting to `continue` on garbage), and
 * feature scores drop any malformed entries.
 */

import type { ReviewDecision } from '@/services/model-gen/model-gen-types';

/** One per-feature fidelity score from the review. */
export interface ReviewFeatureScore {
  feature: string;
  /** In [0,1]. */
  score: number;
}

/** The coerced result of one pass review. */
export interface ReviewResult {
  /** Overall fidelity in [0,1]. */
  globalScore: number;
  featureScores: ReviewFeatureScore[];
  decision: ReviewDecision;
  rationale: string;
}

const DECISIONS: readonly ReviewDecision[] = ['continue', 'refine-code', 'refine-spec', 'stop'];

/** Clamp an untrusted value into [0,1]; non-finite / non-number becomes 0. */
function clamp01(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Narrow an untrusted (LLM-produced) review payload into a {@link ReviewResult}. Never throws: a
 * missing/garbage `decision` defaults to `continue`, scores clamp to [0,1], and `featureScores`
 * keeps only well-formed `{ feature: string, score: number }` entries.
 */
export function coerceReviewResult(raw: unknown): ReviewResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const globalScore = clamp01(record.globalScore);
  const decision = DECISIONS.includes(record.decision as ReviewDecision)
    ? (record.decision as ReviewDecision)
    : 'continue';
  const rationale = typeof record.rationale === 'string' ? record.rationale : '';
  const featureScores: ReviewFeatureScore[] = Array.isArray(record.featureScores)
    ? record.featureScores.flatMap(item => {
        if (!item || typeof item !== 'object') {
          return [];
        }
        const entry = item as Record<string, unknown>;
        if (typeof entry.feature !== 'string' || !entry.feature) {
          return [];
        }
        return [{ feature: entry.feature, score: clamp01(entry.score) }];
      })
    : [];

  return { globalScore, featureScores, decision, rationale };
}
