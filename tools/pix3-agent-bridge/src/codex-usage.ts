/** `codex exec` reports cumulative usage; the rollout also records the last model request. */
import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from './wire.ts';

export interface CodexTokenUsage {
  input: number;
  output: number;
  cached: number;
}
export interface CodexUsageSnapshot {
  total: CodexTokenUsage;
  contextInput: number;
  contextWindow?: number;
}
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export const parseCodexUsage = (text: string): CodexUsageSnapshot | undefined => {
  for (const line of text.split('\n').reverse()) {
    if (!line.includes('"token_count"')) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event) || event.type !== 'event_msg' || !isRecord(event.payload) ||
      event.payload.type !== 'token_count') continue;
    // A reset/compaction can invalidate the snapshot. Never resurrect older pre-reset context.
    if (!isRecord(event.payload.info)) return undefined;
    const info = event.payload.info;
    if (!isRecord(info.total_token_usage) || !isRecord(info.last_token_usage)) return undefined;
    const total = info.total_token_usage;
    const input = count(total.input_tokens);
    const contextInput = count(info.last_token_usage.input_tokens);
    if (input === undefined || contextInput === undefined) return undefined;
    return {
      total: { input, output: count(total.output_tokens) ?? 0, cached: count(total.cached_input_tokens) ?? 0 },
      contextInput,
      contextWindow: count(info.model_context_window),
    };
  }
  return undefined;
};

/** Reads only this thread, never other conversations' contents. Missing/changed CLI logs are OK. */
export class CodexUsageReader {
  private filename: string | undefined;
  private threadId: string | null = null;
  private readonly sessionsRoot: string;
  constructor(sessionsRoot: string) { this.sessionsRoot = sessionsRoot; }

  read(threadId: string | null): CodexUsageSnapshot | undefined {
    if (!threadId || !/^[a-f0-9-]{36}$/i.test(threadId)) return undefined;
    if (this.threadId !== threadId) {
      this.filename = undefined;
      this.threadId = threadId;
    }
    try {
      this.filename ??= this.find(this.sessionsRoot, threadId, 3);
      if (!this.filename) return undefined;
      const fd = fs.openSync(this.filename, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
        fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
        return parseCodexUsage(buffer.toString('utf8'));
      } finally { fs.closeSync(fd); }
    } catch { return undefined; }
  }

  private find(directory: string, threadId: string, depth: number): string | undefined {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) return filename;
      if (entry.isDirectory() && depth > 0 && /^\d+$/.test(entry.name)) {
        const found = this.find(filename, threadId, depth - 1);
        if (found) return found;
      }
    }
    return undefined;
  }
}
