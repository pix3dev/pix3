/**
 * `batch` — several tool calls issued as one, expanded by the chat loop.
 *
 * The measured shape of a turn (`.plans/agent-one-shot-generation.md`) is one tool call per model
 * round trip: `{0:1, 1:54}` before the P0 work and `{0:1, 1:60}` after it, and a direct probe of the
 * bridge lane showed the model will not emit several `tool_use` blocks even when told to. So the
 * batching has to come from a tool the model calls deliberately, not from hoping it batches.
 *
 * **Why the chat loop expands it instead of a registry handler.** Declared as an ordinary tool,
 * `batch` would walk past every scar in the loop at once: the loop-breaker's signature would become
 * `batch:{the whole JSON}` (a repeated inner call invisible), `tuningKnobSignature` would return
 * null (re-tuning one knob would stop counting), `isGameLogicMutation('batch')` would be false (the
 * verify-gate bypassed), and `VISUAL_TOOLS` would not see the nested names (the Flow screenshot
 * refusal bypassed the same way). Each of those counters exists because a real run needed it. So the
 * spec is declared in the registry — it has to reach `specs()` and the cacheable prefix — but its
 * handler throws, and the loop expands the call into virtual inner calls that each go through the
 * same per-call block. One `tool-result` goes back into history, so `tool_use`/`tool_result` pairing
 * is untouched for every provider.
 */

/** Ceiling on steps in one batch. */
export const MAX_BATCH_STEPS = 24;

/** Wall-clock budget for a whole batch; steps after it are skipped, not run. */
export const BATCH_BUDGET_MS = 60_000;

/** Total size of the batch result handed back to the model. */
export const BATCH_RESULT_CHARS = 24_000;

/**
 * Tools that may never appear in a batch.
 *
 * The rule in one line: **did you already decide to make all of these calls before seeing any of
 * their results?** If yes, they are one batch — reading the results afterwards is fine and normal.
 * If the answer to call 1 is what picks call 2, they are separate.
 *
 * That test replaced "a step whose result you must read does not go in a batch", which was measured
 * to be exactly backwards for the most common case: an agent that already knew it wanted four
 * specific files read them one per round trip, because a read is by definition a step whose result
 * you read. Four known paths are four independent decisions already made — one batch.
 *
 * - `ask_user` ends the turn legitimately — inside a batch there is no turn left to end.
 * - `ask_advisor` is a second model call; its answer exists to be read.
 * - `viewport_screenshot` / `analyze_image` produce pictures, and nothing inside a batch can look at
 *   them.
 * - every `generate_*` spends 10–60 s of network, and eval S2 established that the CONTENT of what
 *   comes back has to be judged by the model, not assumed.
 * - `batch` itself: nesting would multiply the budget and make the step numbering meaningless.
 */
export const NEVER_BATCHABLE: ReadonlySet<string> = new Set([
  'batch',
  'ask_user',
  'ask_advisor',
  'viewport_screenshot',
  'analyze_image',
  'generate_asset',
  'generate_sfx',
  'generate_model_3d',
  'generate_scene_3d',
  'skin_ui',
]);

/**
 * Read-only tools that name what they want up front, so a run of them is a run of decisions already
 * made. Used by the loop to notice a batchable stretch and say so once per turn.
 *
 * `engine_search` is deliberately absent: a search is the case where the ANSWER picks the next query,
 * and nudging an agent to batch its searches would be telling it to guess four queries blind.
 */
export const INDEPENDENT_READ_TOOLS: ReadonlySet<string> = new Set([
  'fs_read',
  'fs_list',
  'engine_read',
  'node_inspect',
  'find_nodes',
  'read_skill',
]);

/** How many single reads in a row before the loop points at `batch`. */
export const READ_RUN_NUDGE_AT = 3;

export const readRunNudge = (tools: readonly string[]): string =>
  `[Pix3] You just spent ${tools.length} round trips on ${tools.join(', ')} — reads of paths you had already chosen. That is one \`batch\` call: if you decided on all of them before seeing any result, they belong in one. The results come back per step, so you lose nothing by grouping them.`;

export interface BatchStep {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** Optional human label, echoed in the result and in the progress indicator. */
  readonly label?: string;
}

export interface BatchPlan {
  readonly steps: readonly BatchStep[];
  readonly onError: 'stop' | 'continue';
}

/**
 * A `$ref` is recognised only when it is the WHOLE argument — `"$0.nodeId"`, never
 * `"prefix-$0.nodeId"`. Interpolation would be one more thing for a cheap model to get subtly wrong,
 * and the case that actually matters is the id born in one step and needed by the next.
 */
const REF_PATTERN = /^\$(\d+|prev)((?:\.[A-Za-z0-9_]+)+)$/;

export const parseBatchPlan = (input: unknown): BatchPlan | { error: string } => {
  const raw = (input ?? {}) as { steps?: unknown; onError?: unknown };
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    return { error: '`steps` must be a non-empty array of { tool, args } objects.' };
  }
  if (raw.steps.length > MAX_BATCH_STEPS) {
    return {
      error: `A batch may hold at most ${MAX_BATCH_STEPS} steps; this one has ${raw.steps.length}. Split it.`,
    };
  }
  if (raw.onError !== undefined && raw.onError !== 'stop' && raw.onError !== 'continue') {
    return { error: '`onError` must be "stop" or "continue".' };
  }

  const steps: BatchStep[] = [];
  for (const [index, entry] of raw.steps.entries()) {
    if (!entry || typeof entry !== 'object') {
      return { error: `steps[${index}] must be an object { tool, args }.` };
    }
    const step = entry as { tool?: unknown; args?: unknown; label?: unknown };
    if (typeof step.tool !== 'string' || step.tool.length === 0) {
      return { error: `steps[${index}].tool must be a tool name.` };
    }
    if (NEVER_BATCHABLE.has(step.tool)) {
      return {
        error: `${step.tool} cannot be batched: you need its answer before you can choose what to do next (or it returns an image, or it costs a network round trip). Call it on its own. The test for everything else: if you already decided to make all the calls before seeing any of their results, they belong in one batch — reads included.`,
      };
    }
    if (step.args !== undefined && (typeof step.args !== 'object' || Array.isArray(step.args))) {
      return { error: `steps[${index}].args must be an object.` };
    }
    steps.push({
      tool: step.tool,
      args: (step.args ?? {}) as Record<string, unknown>,
      ...(typeof step.label === 'string' && step.label ? { label: step.label } : {}),
    });
  }
  return { steps, onError: raw.onError === 'continue' ? 'continue' : 'stop' };
};

/**
 * Substitute `$N.path` / `$prev.path` references against the results of earlier steps.
 *
 * `resolved` is indexed by step; an entry is `undefined` when that step failed or returned something
 * that is not an object. A reference that cannot be resolved is reported rather than silently left
 * as the literal string — passing `"$0.nodeId"` to `set_property` as a node id would fail deep
 * inside a tool with a confusing message.
 */
export const resolveStepRefs = (
  args: Record<string, unknown>,
  resolved: ReadonlyArray<unknown>,
  stepIndex: number
): { args: Record<string, unknown> } | { error: string } => {
  let failure: string | null = null;

  const lookup = (reference: string): unknown => {
    const match = REF_PATTERN.exec(reference);
    if (!match) return reference;
    const target = match[1] === 'prev' ? stepIndex - 1 : Number(match[1]);
    if (!Number.isInteger(target) || target < 0 || target >= stepIndex) {
      failure ??= `${reference} points at step ${match[1]}, which has not run before step ${stepIndex}.`;
      return reference;
    }
    let value: unknown = resolved[target];
    for (const key of match[2].slice(1).split('.')) {
      if (value === null || typeof value !== 'object') {
        failure ??= `${reference} cannot be read: step ${target} returned no object at that path.`;
        return reference;
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (value === undefined) {
      failure ??= `${reference} is not present in the result of step ${target}.`;
      return reference;
    }
    return value;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return lookup(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        out[key] = walk(inner);
      }
      return out;
    }
    return value;
  };

  const next = walk(args) as Record<string, unknown>;
  return failure === null ? { args: next } : { error: failure };
};

export interface BatchStepReport {
  readonly step: number;
  readonly tool: string;
  readonly label?: string;
  readonly ok: boolean;
  /** The tool's own result text, possibly shortened — see {@link compactBatchReport}. */
  result: string;
  /** Present when the text was shortened, saying how many characters were dropped. */
  truncated?: number;
}

/**
 * Fit the per-step reports into {@link BATCH_RESULT_CHARS}.
 *
 * Per-step results are kept rather than reduced to a whitelist of keys, because a whitelist decides
 * for the model which fields mattered and a batched `fs_read` would lose its file silently. What is
 * bounded instead is length: every step gets an equal share, over-budget text is cut with the number
 * of dropped characters stated, and a FAILED step is never cut — the error is the one thing the
 * model must read in full to recover.
 */
export const compactBatchReport = (
  reports: BatchStepReport[],
  budget = BATCH_RESULT_CHARS
): BatchStepReport[] => {
  const total = reports.reduce((sum, report) => sum + report.result.length, 0);
  if (total <= budget) return reports;

  const failed = reports.filter(report => !report.ok);
  const failedChars = failed.reduce((sum, report) => sum + report.result.length, 0);
  const survivors = reports.filter(report => report.ok);
  if (survivors.length === 0) return reports;

  const share = Math.max(200, Math.floor(Math.max(budget - failedChars, 0) / survivors.length));
  return reports.map(report => {
    if (!report.ok || report.result.length <= share) return report;
    const dropped = report.result.length - share;
    return {
      ...report,
      result: `${report.result.slice(0, share)}… [${dropped} characters dropped to fit the batch result — run this step on its own to read it in full]`,
      truncated: dropped,
    };
  });
};
