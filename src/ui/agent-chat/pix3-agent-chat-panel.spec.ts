import { beforeAll, describe, expect, it } from 'vitest';

import type { LlmMessage } from '@/services/llm/LlmTypes';

type PanelModule = typeof import('./pix3-agent-chat-panel');

let panel: PanelModule;

beforeAll(async () => {
  panel = await import('./pix3-agent-chat-panel');
});

const userText = (text: string): LlmMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

describe('transcript images', () => {
  it('carries the saved file path of a tool preview into its display item', () => {
    const items = panel.toDisplayItems(
      [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              mimeType: 'image/webp',
              data: 'UFJFVklFVw==',
              sourcePath: 'references/mockup.png',
            },
            // A screenshot previews no file: nothing to expand but its own pixels.
            { type: 'image', mimeType: 'image/jpeg', data: 'U0hPVA==' },
          ],
        },
      ],
      {},
      false
    );

    expect(items.map(item => item.kind)).toEqual(['image', 'image']);
    expect(items[0].kind === 'image' && items[0].path).toBe('references/mockup.png');
    expect(items[1].kind === 'image' && items[1].path).toBeUndefined();
  });
});

describe('harness nudges', () => {
  it('classifies a nudge as its own display item, not as the user speaking', () => {
    const items = panel.toDisplayItems(
      [
        userText('add a snake'),
        userText(
          '[Pix3] You repeated an identical read_errors call and got the identical result. ' +
            'Repeating it again will not change anything.'
        ),
      ],
      {},
      false
    );

    expect(items.map(item => item.kind)).toEqual(['text', 'notice']);
    const notice = items[1];
    expect(notice.kind === 'notice' && notice.label).toBe('Cycle detected — correction');
    // The `[Pix3]` marker is scaffolding for the model; the expanded body should not repeat it.
    expect(notice.kind === 'notice' && notice.text.startsWith('You repeated')).toBe(true);
  });

  it('labels each nudge family the harness can emit', () => {
    expect(panel.nudgeLabel('You have run out of tool iterations for this turn.')).toBe(
      'Iteration cap reached'
    );
    expect(panel.nudgeLabel('Only 2 tool iterations left before this turn is force-stopped.')).toBe(
      'Iteration budget — wrap up'
    );
    expect(panel.nudgeLabel('You are stuck: the same error three times.')).toBe(
      'Stuck — change approach'
    );
    expect(panel.nudgeLabel('You changed game logic but never ran the game to prove it.')).toBe(
      'Unverified change — verify first'
    );
    expect(panel.nudgeLabel('Context is filling (82% of the window).')).toBe(
      'Context pressure — land the work'
    );
    expect(panel.nudgeLabel('The earlier conversation was compacted to free context.')).toBe(
      'Context compacted — handoff'
    );
    // Unknown wording still gets a heading rather than rendering as a wall of text.
    expect(panel.nudgeLabel('Something new the harness started saying.')).toBe('Harness note');
  });

  it('never treats an assistant message as a nudge', () => {
    expect(panel.isNudgeText('assistant', '[Pix3] quoting the harness back at us')).toBe(false);
    expect(panel.isNudgeText('user', '  [Pix3] leading whitespace still counts')).toBe(true);
  });
});

describe('long-reply clamping', () => {
  it('clamps by either length or line count', () => {
    expect(panel.isLongText('short answer')).toBe(false);
    expect(panel.isLongText('x'.repeat(701))).toBe(true);
    expect(panel.isLongText('line\n'.repeat(13))).toBe(true);
    expect(panel.isLongText('line\n'.repeat(5))).toBe(false);
  });
});

describe('tool grouping', () => {
  const toolUse = (id: string, name: string): LlmMessage => ({
    role: 'assistant',
    content: [{ type: 'tool-use', id, name, input: {} }],
  });
  const toolResult = (id: string): LlmMessage => ({
    role: 'user',
    content: [{ type: 'tool-result', toolUseId: id, content: 'ok', isError: false }],
  });
  const assistantText = (text: string): LlmMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  });

  /** A research phase: N single-tool hops, each with its own turn metric (debug mode on). */
  const researchHops = (names: readonly string[]) => {
    const messages: LlmMessage[] = [];
    const turnMetrics: Record<number, { elapsedMs: number; outputTokens: number }> = {};
    names.forEach((name, i) => {
      turnMetrics[messages.length] = { elapsedMs: 1000, outputTokens: 10 };
      messages.push(toolUse(`t${i}`, name));
      messages.push(toolResult(`t${i}`));
    });
    return { messages, turnMetrics };
  };

  it('merges tool hops separated only by metrics into one group', () => {
    const { messages, turnMetrics } = researchHops(['engine_search', 'engine_read']);
    const items = panel.toDisplayItems(messages, turnMetrics, true);
    // The raw items really do interleave: tool, metrics, tool, metrics.
    expect(items.map(item => item.kind)).toEqual(['tool', 'metrics', 'tool', 'metrics']);

    const rows = panel.buildRenderRows(items);
    expect(rows).toHaveLength(1);
    const group = rows[0];
    expect(group.kind).toBe('toolgroup');
    if (group.kind !== 'toolgroup') throw new Error('expected a toolgroup');
    expect(group.tools).toHaveLength(2);
    expect(group.metrics).toHaveLength(2);
  });

  it('still breaks a group on an assistant reply between the hops', () => {
    const { messages, turnMetrics } = researchHops(['engine_search']);
    messages.push(assistantText('found it'));
    const second = researchHops(['engine_read']);
    // Re-key the second hop's metric onto its real message index.
    turnMetrics[messages.length] = second.turnMetrics[0];
    messages.push(...second.messages);

    const rows = panel.buildRenderRows(panel.toDisplayItems(messages, turnMetrics, true));
    expect(rows.map(row => row.kind)).toEqual(['toolgroup', 'text', 'toolgroup']);
  });

  it('leaves a single hop as one group with its single metric', () => {
    const { messages, turnMetrics } = researchHops(['fs_read']);
    const rows = panel.buildRenderRows(panel.toDisplayItems(messages, turnMetrics, true));
    expect(rows).toHaveLength(1);
    const group = rows[0];
    if (group.kind !== 'toolgroup') throw new Error('expected a toolgroup');
    expect(group.tools).toHaveLength(1);
    // A one-metric group folds to that exact metric, so its line renders as it always did.
    expect(panel.aggregateTurnMetrics(group.metrics)).toBe(group.metrics[0]);
  });

  it('keeps a standalone metrics row when no tool group is open', () => {
    const rows = panel.buildRenderRows(
      panel.toDisplayItems([assistantText('just talking')], { 0: { elapsedMs: 500 } }, true)
    );
    expect(rows.map(row => row.kind)).toEqual(['text', 'metrics']);
  });

  it('sums the folded metrics of a merged group', () => {
    const folded = panel.aggregateTurnMetrics([
      { elapsedMs: 800, inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 },
      { elapsedMs: 1200, inputTokens: 200, outputTokens: 20 },
    ]);
    expect(folded?.elapsedMs).toBe(2000);
    expect(folded?.inputTokens).toBe(300);
    expect(folded?.outputTokens).toBe(30);
    expect(folded?.cacheReadTokens).toBe(80);
    // Nothing reported it, so it stays absent rather than printing a misleading zero.
    expect(folded?.cacheCreationTokens).toBeUndefined();
  });
});

describe('tool categories', () => {
  it('files the engine-source tools under research, not "other"', () => {
    expect(panel.toolCategory('engine_search')).toBe('research');
    expect(panel.toolCategory('engine_read')).toBe('research');
    expect(panel.toolCategory('read_skill')).toBe('research');
    expect(panel.toolCategory('ask_advisor')).toBe('research');
    expect(panel.toolCategory('fs_read')).toBe('read');
    expect(panel.toolCategory('fs_list')).toBe('read');
    expect(panel.toolCategory('run_command')).toBe('test');
  });
});

describe('tool histogram', () => {
  const entry = (name: string, i: number) => ({
    call: { type: 'tool-use' as const, id: `h${i}`, name, input: {} },
    result: null,
  });

  it('counts by tool name, biggest first', () => {
    const tools = [
      ...Array.from({ length: 3 }, (_, i) => entry('engine_search', i)),
      ...Array.from({ length: 5 }, (_, i) => entry('engine_read', 10 + i)),
    ];
    expect(panel.toolHistogram(tools)).toEqual([
      { name: 'engine_read', count: 5 },
      { name: 'engine_search', count: 3 },
    ]);
  });

  it('folds the tail into a single "other" row and never exceeds the row cap', () => {
    const tools = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, i) => entry(name, i));
    const bars = panel.toolHistogram(tools);
    expect(bars).toHaveLength(5);
    expect(bars[4]).toEqual({ name: 'other', count: 3 });
  });
});
