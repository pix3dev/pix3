import { describe, expect, it } from 'vitest';
import {
  BATCH_RESULT_CHARS,
  MAX_BATCH_STEPS,
  compactBatchReport,
  parseBatchPlan,
  resolveStepRefs,
  type BatchStepReport,
} from './tool-batch';

describe('parseBatchPlan', () => {
  it('accepts a plan and defaults onError to stop', () => {
    const plan = parseBatchPlan({
      steps: [
        { tool: 'create_node', args: { type: 'Sprite2D' }, label: 'coin' },
        { tool: 'set_property', args: {} },
      ],
    });

    expect('error' in plan).toBe(false);
    if ('error' in plan) return;
    expect(plan.onError).toBe('stop');
    expect(plan.steps[0]).toEqual({
      tool: 'create_node',
      args: { type: 'Sprite2D' },
      label: 'coin',
    });
    // An omitted `args` is an empty object, not undefined — tools read their own arguments.
    expect(plan.steps[1].args).toEqual({});
  });

  it('refuses the tools whose result has to be read before the next decision', () => {
    for (const tool of [
      'ask_user',
      'ask_advisor',
      'viewport_screenshot',
      'generate_asset',
      'batch',
    ]) {
      const plan = parseBatchPlan({ steps: [{ tool }] });
      expect('error' in plan, tool).toBe(true);
      if (!('error' in plan)) continue;
      expect(plan.error).toContain(tool);
    }
  });

  it('rejects an oversized or empty plan', () => {
    expect(parseBatchPlan({ steps: [] })).toHaveProperty('error');
    const tooMany = {
      steps: Array.from({ length: MAX_BATCH_STEPS + 1 }, () => ({ tool: 'fs_read' })),
    };
    expect(parseBatchPlan(tooMany)).toHaveProperty('error');
  });
});

describe('resolveStepRefs', () => {
  const results = [{ nodeId: 'node-7', nested: { id: 'deep-1' } }, { ok: true }];

  it('substitutes a reference that is the WHOLE argument', () => {
    const out = resolveStepRefs({ nodeId: '$0.nodeId', value: 3 }, results, 2);
    expect(out).toEqual({ args: { nodeId: 'node-7', value: 3 } });
  });

  it('reads $prev and a nested path', () => {
    expect(resolveStepRefs({ id: '$prev.nodeId' }, results, 1)).toEqual({ args: { id: 'node-7' } });
    expect(resolveStepRefs({ id: '$0.nested.id' }, results, 2)).toEqual({ args: { id: 'deep-1' } });
  });

  it('substitutes inside nested objects and arrays', () => {
    const out = resolveStepRefs(
      { config: { target: '$0.nodeId' }, list: ['$0.nodeId'] },
      results,
      2
    );
    expect(out).toEqual({ args: { config: { target: 'node-7' }, list: ['node-7'] } });
  });

  /**
   * Interpolation is deliberately NOT supported: a whole-string rule is one a cheap model has a hard
   * time getting subtly wrong, and the case that matters is an id born in one step and needed by the
   * next. A string that merely contains a reference stays a literal.
   */
  it('leaves a reference embedded in a larger string alone', () => {
    expect(resolveStepRefs({ name: 'node-$0.nodeId' }, results, 2)).toEqual({
      args: { name: 'node-$0.nodeId' },
    });
  });

  it('reports a reference it cannot resolve instead of passing the literal through', () => {
    // Forward reference: step 2 cannot read step 5.
    expect(resolveStepRefs({ id: '$5.nodeId' }, results, 2)).toHaveProperty('error');
    // Present step, absent field.
    expect(resolveStepRefs({ id: '$1.nodeId' }, results, 2)).toHaveProperty('error');
    // A step that failed contributes `undefined`.
    expect(resolveStepRefs({ id: '$0.nodeId' }, [undefined], 1)).toHaveProperty('error');
  });
});

describe('compactBatchReport', () => {
  const report = (step: number, ok: boolean, size: number): BatchStepReport => ({
    step,
    tool: 'fs_read',
    ok,
    result: 'x'.repeat(size),
  });

  it('leaves a report that already fits completely alone', () => {
    const reports = [report(0, true, 100), report(1, true, 100)];
    expect(compactBatchReport(reports)).toEqual(reports);
  });

  /**
   * The failed step is the one thing the model must read in full to recover, so the budget is taken
   * out of the successful steps — never out of the error.
   */
  it('never truncates a failed step, and says how much it dropped from the others', () => {
    const failure = { ...report(2, false, 5_000), result: 'THE REAL ERROR'.repeat(300) };
    const compacted = compactBatchReport(
      [report(0, true, 40_000), report(1, true, 40_000), failure],
      BATCH_RESULT_CHARS
    );

    expect(compacted[2].result).toBe(failure.result);
    expect(compacted[2].truncated).toBeUndefined();
    expect(compacted[0].truncated).toBeGreaterThan(0);
    expect(compacted[0].result).toMatch(/characters dropped/);
    const total = compacted.reduce((sum, entry) => sum + entry.result.length, 0);
    expect(total).toBeLessThan(BATCH_RESULT_CHARS + failure.result.length + 500);
  });
});
