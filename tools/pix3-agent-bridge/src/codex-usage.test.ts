import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexUsageReader, parseCodexUsage, type CodexUsageSnapshot } from './codex-usage.ts';
import { CodexSession } from './codex-session.ts';
import type { WireMessagesRequest } from './wire.ts';

// Recorded independently from the affected Luna thread: seven internal requests, two editor tools.
const event = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: 277217, cached_input_tokens: 232704, output_tokens: 472 },
  last_token_usage: { input_tokens: 48226, output_tokens: 110 },
  model_context_window: 258400,
} } });
const snapshot = parseCodexUsage(event)!;
const threadId = '01a10baa-fbe7-7272-b214-96911530710b';
const request: WireMessagesRequest = { model: 'gpt-6-luna', max_tokens: 1000,
  messages: [{ role: 'user', content: 'Remove the bumpers' }] };

describe('Codex context accounting', () => {
  it('separates the last context from total usage and tolerates a partial final log line', () => {
    assert.deepEqual(parseCodexUsage(`invalid\n${event}\n{"type":"event_msg"`), {
      total: { input: 277217, output: 472, cached: 232704 }, contextInput: 48226, contextWindow: 258400,
    });
    assert.equal(parseCodexUsage('{"type":"event_msg"}'), undefined);
    assert.equal(parseCodexUsage(`${event}\n${JSON.stringify({
      type: 'event_msg', payload: { type: 'token_count', info: null },
    })}`), undefined);
  });

  it('reads only the matching rollout and degrades gracefully without one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pix3-codex-usage-'));
    try {
      const folder = path.join(root, '2026', '10', '05');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `rollout-date-${threadId}.jsonl`), event);
      const reader = new CodexUsageReader(root);
      assert.equal(reader.read('../outside'), undefined);
      assert.deepEqual(reader.read(threadId), snapshot);
      assert.equal(reader.read('01a10baa-fbe7-7272-b214-96911530710c'), undefined);
      assert.deepEqual(reader.read(threadId), snapshot);
      assert.equal(new CodexUsageReader(path.join(root, 'missing')).read(threadId), undefined);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reports per-response billing deltas while preserving real context across resume', async () => {
    let current: CodexUsageSnapshot | undefined;
    const session = new CodexSession(request, () => {}, {
      binary: 'unused', mcpUrl: 'unused', mcpToken: 'unused', readUsage: () => current,
      spawner: () => {
        current = current ? { ...snapshot, total: { input: 327217, output: 500, cached: 272704 }, contextInput: 50000 } : snapshot;
        return spawn(process.execPath, ['-e', `process.stdin.resume(); process.stdin.on('end', () => {
          console.log(JSON.stringify({type:'thread.started',thread_id:'${threadId}'}));
          console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done'}}));
          console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:277217,output_tokens:472}}));
        });`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      },
    });
    try {
      const first = await session.handleRequest(request, new AbortController().signal);
      assert.deepEqual(first.body.usage, { input_tokens: 44513, cache_read_input_tokens: 232704,
        output_tokens: 472, context_input_tokens: 48226, context_window: 258400 });
      const next = await session.handleRequest({ ...request, messages: [...request.messages,
        { role: 'assistant', content: 'Done' }, { role: 'user', content: 'Continue' }] }, new AbortController().signal);
      assert.deepEqual(next.body.usage, { input_tokens: 10000, cache_read_input_tokens: 40000,
        output_tokens: 28, context_input_tokens: 50000, context_window: 258400 });
    } finally { session.close('test complete'); }
  });

  it('never treats cumulative exec usage as context when rollout telemetry is unavailable', async () => {
    const session = new CodexSession(request, () => {}, {
      binary: 'unused', mcpUrl: 'unused', mcpToken: 'unused', readUsage: () => undefined,
      spawner: () => spawn(process.execPath, ['-e', `process.stdin.resume(); process.stdin.on('end', () => {
        console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:277217,output_tokens:472}}));
      });`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
    });
    try {
      const response = await session.handleRequest(request, new AbortController().signal);
      assert.deepEqual(response.body.usage, { input_tokens: 277217, cache_read_input_tokens: 0,
        output_tokens: 472, context_input_tokens: null });
    } finally { session.close('test complete'); }
  });
});
