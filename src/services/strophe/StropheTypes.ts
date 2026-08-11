/**
 * Wire contracts for the Strophe generation API (`https://strophe.app/api/v1`).
 *
 * These mirror `GET /api/v1/openapi.json` (Strophe API 1.0.0) field-for-field — deliberately, so a
 * drift in their schema shows up as a TypeScript error here rather than as a runtime surprise deep
 * in a provider. Anything Pix3-shaped (capabilities, our error kinds) is derived in the providers,
 * not baked in here.
 *
 * Strophe built this API from our request spec (`.plans/strophe-api-spec.md`), so most of it maps
 * onto our existing provider contracts directly. The gaps that shape the adapters — one artifact per
 * generation, no `seed`, no transparency flag, no output-format control — are recorded in
 * `.plans/strophe-integration-feedback.md`.
 */

/** Output modality of a family / generation. `text` exists in their enum but no family exposes it. */
export type StropheOutputType = 'image' | 'video' | '3d' | 'audio' | 'text';

/** Lifecycle of one generation. `ready` is success; the three terminal failures are distinct. */
export type StropheGenerationState =
  | 'queued'
  | 'running'
  | 'finalizing'
  | 'ready'
  | 'failed'
  | 'cancelled';

/** Terminal states — polling stops here. */
export const STROPHE_TERMINAL_STATES: readonly StropheGenerationState[] = [
  'ready',
  'failed',
  'cancelled',
];

export interface StrophePrice {
  readonly credits: number;
  /** e.g. `'generation'`. */
  readonly unit: string;
}

/**
 * One tunable parameter of a family, as declared by the catalog. Shape is close enough to our own
 * `PropertyDefinition` that the settings/generation UI can be driven from it without hardcoding.
 */
export interface StropheParameter {
  readonly name: string;
  readonly type: 'string' | 'enum' | 'number' | 'integer' | 'boolean';
  /** Allowed values for `type: 'enum'`, else null. */
  readonly values?: readonly string[] | null;
  readonly default?: unknown;
  readonly min?: number | null;
  readonly max?: number | null;
  readonly step?: number | null;
  readonly maxLength?: number | null;
  readonly required?: boolean;
  /** True for knobs the provider considers advanced (we can collapse these in UI). */
  readonly advanced?: boolean;
  /** When set, the parameter only applies to these variant ids. */
  readonly onlyVariants?: readonly string[] | null;
}

/** Min/max count of each input modality a variant accepts. */
export interface StropheVariantInputs {
  readonly images?: { readonly min: number; readonly max: number };
  readonly videos?: { readonly min: number; readonly max: number };
  readonly model3d?: { readonly min: number; readonly max: number };
  readonly audios?: { readonly min: number; readonly max: number };
}

export interface StropheVariant {
  readonly id: string;
  readonly name?: string;
  /** e.g. `['t2i']`, `['i2i']`, `['i23d']`. */
  readonly tasks?: readonly string[];
  readonly price?: StrophePrice;
  /** Axis values this variant corresponds to, e.g. `{ version: 'schnell' }`. */
  readonly axes?: Readonly<Record<string, string>>;
  readonly autoSelected?: boolean;
  readonly requiresPrompt?: boolean;
  readonly inputs?: StropheVariantInputs;
}

/** A selectable axis (quality/size/format tier) whose values pick a variant. */
export interface StropheAxis {
  readonly name: string;
  readonly default?: string;
  readonly values: readonly string[];
}

export interface StropheFamilySummary {
  readonly id: string;
  readonly name: string;
  readonly outputType: StropheOutputType;
  readonly category?: string;
  readonly tasks?: readonly string[];
  readonly price?: StrophePrice;
  /** Rough wall-clock estimate in SECONDS. Our only source for a progress bar (no `progress` field). */
  readonly generationTime?: number;
  readonly maxInputs?: {
    readonly images?: number;
    readonly videos?: number;
    readonly model3d?: number;
    readonly audios?: number;
  };
  /** True for post-processing nodes (bg-remove, upscale, vectorize) rather than generators. */
  readonly utility?: boolean;
  readonly unstable?: boolean;
  readonly available: boolean;
  readonly lockReason?: string | null;
}

export interface StropheFamilyDetail extends StropheFamilySummary {
  readonly axes?: readonly StropheAxis[];
  readonly variants?: readonly StropheVariant[];
  readonly parameters?: readonly StropheParameter[];
}

/**
 * Body of `POST /generations` and `POST /generations/estimate`.
 *
 * Their schema is `additionalProperties: false`, so this really is the whole surface — note the
 * absence of `seed`, `count`/`n`, output format, and any client `metadata` slot.
 */
export interface StropheGenerationRequest {
  readonly familyId: string;
  /** Pick an exact variant. Mutually exclusive with {@link axes}. */
  readonly modelId?: string;
  /** Pick a variant by axis values, e.g. `{ version: 'pro' }`. Mutually exclusive with `modelId`. */
  readonly axes?: Readonly<Record<string, string>>;
  readonly prompt?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** Uploaded file ids; ORDER IS MEANINGFUL for families that take several images. */
  readonly imageIds?: readonly string[];
  readonly videoId?: string;
  readonly videoIds?: readonly string[];
  readonly model3dIds?: readonly string[];
  readonly audioIds?: readonly string[];
  /** Hard per-request ceiling; exceeding it fails with `cost_above_limit` instead of charging. */
  readonly maxCredits?: number;
}

/** The single artifact a finished generation produces. One generation = one file. */
export interface StropheGenerationResult {
  readonly url: string;
  /** Lifetime of {@link url} — ~24 h. NOT re-signed on re-read, so download promptly. */
  readonly expiresInSeconds: number;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  /** Seconds, for audio/video. */
  readonly duration?: number;
  /**
   * Request fields this result can be fed straight back into (e.g. `['imageIds']`) — lets a chain
   * such as generate → background-remove run entirely server-side, with no download/re-upload.
   */
  readonly reusableAs: readonly string[];
}

/** Failure classes a generation can end with (distinct from transport-level error codes). */
export type StropheFailureCode =
  | 'file_size'
  | 'image_size'
  | 'image_format'
  | 'content_policy'
  | 'prompt_validation'
  | 'parameter_validation'
  | 'feature_limitation'
  | 'model_unavailable'
  | 'insufficient_credits'
  | 'authentication'
  | 'timeout'
  | 'provider_error'
  | 'internal_error'
  | 'user_cancellation';

export interface StropheGenerationFailure {
  readonly code: StropheFailureCode;
  readonly reason: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly hint: string;
  readonly details?: Readonly<Record<string, string | number>>;
}

export interface StropheGeneration {
  readonly generationId: string;
  readonly state: StropheGenerationState;
  readonly familyId: string;
  readonly modelId?: string;
  readonly outputType: StropheOutputType;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly creditsReserved: number;
  readonly creditsCharged: number;
  /** Server-suggested delay before the next poll. */
  readonly pollAfterSeconds?: number;
  readonly result?: StropheGenerationResult;
  /** Text output for text-producing families. */
  readonly text?: string;
  readonly error?: StropheGenerationFailure;
}

export interface StropheGenerationStarted {
  readonly generationId: string;
  readonly state: 'queued';
  readonly creditsReserved: number;
  readonly pollAfterSeconds?: number;
  /** True when an `Idempotency-Key` replay returned an existing generation (nothing was charged). */
  readonly replayed: boolean;
}

export interface StropheEstimate {
  readonly credits: number;
  readonly familyId: string;
  readonly modelId: string;
  readonly videoDuration?: number;
  /** Null for team-pool accounts, which do not expose a personal balance. */
  readonly availableCredits: number | null;
  readonly sufficient: boolean;
}

export interface StropheFile {
  readonly fileId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly state: 'ready' | 'processing';
  readonly pollAfterSeconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
}

/** Per-key spend limits, and how much of the daily allowance is already used. */
export interface StropheTokenLimits {
  readonly dailyCredits?: number | null;
  readonly perGenerationCredits?: number | null;
  readonly spentToday?: number;
  readonly resetsAt?: string;
}

export interface StropheAccountToken {
  readonly name?: string;
  readonly scopes: readonly string[];
  readonly limits?: StropheTokenLimits;
}

export interface StropheAccount {
  /** Null for team-pool accounts — show {@link StropheTokenLimits.spentToday} instead. */
  readonly availableCredits: number | null;
  readonly reservedCredits?: number;
  readonly unlimited?: boolean;
  readonly plan?: string;
  readonly team?: { readonly name?: string; readonly poolState?: string };
  readonly token?: StropheAccountToken;
  readonly note?: string;
}

/** Transport-level error codes from the `{ error: { … } }` envelope. */
export type StropheErrorCode =
  | 'unauthorized'
  | 'invalid_token'
  | 'insufficient_scope'
  | 'access_denied'
  | 'team_required'
  | 'rate_limited'
  | 'too_many_concurrent'
  | 'service_unavailable'
  | 'internal_error'
  | 'invalid_request'
  | 'payload_too_large'
  | 'unsupported_content_type'
  | 'not_found'
  | 'invalid_cursor'
  | 'idempotency_conflict'
  | 'idempotency_in_progress'
  | 'unsupported_file_format'
  | 'file_fetch_failed'
  | 'file_processing_failed'
  | 'account_blocked'
  | 'family_not_found'
  | 'family_unavailable'
  | 'subscription_required'
  | 'team_expired'
  | 'insufficient_credits'
  | 'credit_reservation_failed'
  | 'file_not_found'
  | 'file_not_ready'
  | 'file_metadata_missing'
  | 'variant_not_resolved'
  | 'invalid_parameters'
  | 'price_unavailable'
  | 'cost_above_limit'
  | 'spend_limit_exceeded'
  | 'queue_unavailable'
  | 'generation_not_found'
  | 'not_cancellable'
  | 'cancel_conflict';

/**
 * A Strophe API failure, carrying their machine-readable code so callers can branch on it (top up
 * credits vs. re-enter the key vs. retry) instead of parsing prose.
 */
export class StropheError extends Error {
  constructor(
    /** Their `error.code`, or a synthetic `'network'` / `'aborted'` / `'generation_failed'`. */
    readonly code: StropheErrorCode | 'network' | 'aborted' | 'generation_failed',
    message: string,
    readonly options: {
      readonly status?: number;
      readonly retryable?: boolean;
      readonly retryAfterSeconds?: number;
      readonly requestId?: string;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'StropheError';
  }

  /** True when the caller may retry the same request as-is. */
  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  /** True when the user must top up credits or raise a spend limit before this can succeed. */
  get isBillingBlock(): boolean {
    return (
      this.code === 'insufficient_credits' ||
      this.code === 'cost_above_limit' ||
      this.code === 'spend_limit_exceeded' ||
      this.code === 'credit_reservation_failed'
    );
  }

  /** True when the key is missing, wrong, revoked, or lacks the needed scope/plan. */
  get isAuthProblem(): boolean {
    return (
      this.code === 'unauthorized' ||
      this.code === 'invalid_token' ||
      this.code === 'insufficient_scope' ||
      this.code === 'team_required' ||
      this.code === 'subscription_required' ||
      this.code === 'team_expired' ||
      this.code === 'account_blocked' ||
      this.code === 'access_denied'
    );
  }
}
