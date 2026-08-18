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
