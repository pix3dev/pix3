/**
 * One chat, backed by one long-lived `agy` process.
 *
 * The inversion is the same as the Agent-SDK lane's (see `sessions.ts`), but the machinery is much
 * smaller, because `agy` gives the bridge exactly one blocking point and exactly one stream:
 *
 *   1. The process is spawned once per session with `--input-format stream-json
 *      --output-format stream-json`, so turns are NDJSON lines written to its stdin — verified live:
 *      a second turn on the same process still remembered the first.
 *   2. Its stdout is a typed event stream (`init` / `step_update` / `result`). `agent_response`
 *      steps carry the answer, `tool` steps are agy's OWN tools (its shell, its browser) and are
 *      rendered as short markers so the user can see what it did.
 *   3. Editor tools arrive through the MCP shim (`tool-relay.ts`). A parked call is the signal to
 *      answer the HTTP request with `stop_reason: "tool_use"`; the editor's next POST resolves it.
 *
 * Measured details that shape the code below (`.plans/agy-bridge-lane.md` §6):
 *
 *   - **`result.usage` is a running total for the PROCESS, not the size of the prompt.** Its
 *     `input_tokens` is the sum over every step and every turn so far (14007 + 14216 → 28223), so
 *     using it would draw a context bar that doubles on each hop. Prompt size comes from the LAST
 *     step of the turn; output and thinking are summed over the steps of this response.
 *   - **Thinking is not a step.** It shows up as `usage.thinking_tokens` on `agent_response`.
 *   - **agy auto-denies MCP calls unless `--dangerously-skip-permissions` is passed.** That flag is
 *     opt-in (`agy.skipPermissions`), so a session created without it simply advertises no tools.
 *   - **`--print-timeout` defaults to 5 minutes** and would kill a process that is merely waiting
 *     for a human to approve a tool, so the bridge sets it far beyond its own watchdog and keeps
 *     ownership of the deadline.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { agentLaunchEnv } from './executables.ts';
import { conversationKey } from './agy-conversations.ts';
import { looksLikeAuth, looksLikeQuota } from './agy.ts';
import { ToolRelay } from './tool-relay.ts';
import { Deferred } from './util.ts';
import type { Logger } from './util.ts';
import { HttpError, effortOf, extractToolResults, systemToText, toUserContent } from './wire.ts';
import type { WireBlock, WireEffort, WireMessagesRequest, WireToolDefinition } from './wire.ts';
import type { BridgeResponse, ManagedSession } from './sessions.ts';

// -- stream schema ------------------------------------------------------------

export interface AgyUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly thinking_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly total_tokens?: number;
}

export interface AgyStepUpdate {
  readonly conversation_id?: string;
  readonly step_index?: number;
  readonly state?: string;
  readonly step_type?: string;
  readonly text_delta?: string;
  readonly tool_name?: string;
  readonly tool_info?: { readonly name?: string; readonly parameters?: Record<string, unknown> };
  readonly usage?: AgyUsage;
}

export interface AgyResult {
  readonly conversation_id?: string;
  readonly status?: string;
  readonly response?: string;
  readonly error?: string;
  readonly num_turns?: number;
  readonly usage?: AgyUsage;
  readonly denied_actions?: ReadonlyArray<{ readonly action?: string; readonly display_name?: string }>;
}

export type AgyEvent =
  | { readonly event: 'init'; readonly conversation_id?: string; readonly init?: { readonly model?: string } }
  | { readonly event: 'step_update'; readonly step_update?: AgyStepUpdate }
  | { readonly event: 'result'; readonly result?: AgyResult }
  | { readonly event: string; readonly [key: string]: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parse one NDJSON line; anything unparseable is dropped by the caller. */
export const parseAgyEvent = (line: string): AgyEvent | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.event !== 'string') return null;
  return parsed as AgyEvent;
};

// -- process seam -------------------------------------------------------------

/** The slice of a child process this session uses, so tests can drive it without spawning agy. */
export interface AgyProcessHandle {
  readonly pid?: number | undefined;
  write(line: string): void;
  /** Close stdin — agy exits after draining the turns it already has. */
  endInput(): void;
  kill(force: boolean): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
}

export type AgySpawner = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => AgyProcessHandle;

/**
 * Real spawn. No shell and no `windowsVerbatimArguments`: `agy` is a native executable, so Node's
 * own argument quoting is correct and a shell would only add a process to kill.
 */
export const spawnAgy: AgySpawner = (file, args, options) => {
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return {
    pid: child.pid,
    write: line => {
      if (child.stdin.writable) child.stdin.write(line);
    },
    endInput: () => {
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
    },
    kill: force => {
      if (!force) {
        child.kill();
        return;
      }
      // `child.kill()` on Windows is TerminateProcess on the ROOT only, and agy is the parent of
      // every MCP server in the user's config (our shim, their `npx chrome-devtools-mcp`, …).
      // Without a tree kill those survive as orphans holding memory and a stdio pipe.
      if (process.platform === 'win32' && child.pid !== undefined) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          }).unref();
          return;
        } catch {
          /* fall through to the plain kill */
        }
      }
      child.kill('SIGKILL');
    },
    onStdout: listener => child.stdout.on('data', (chunk: string) => listener(chunk)),
    onStderr: listener => child.stderr.on('data', (chunk: string) => listener(chunk)),
    onExit: listener => child.on('exit', (code, signal) => listener(code, signal)),
  };
};

// -- session ------------------------------------------------------------------

/** Hard cap on how long one `/agents/agy/v1/messages` request may wait, matching the SDK lane. */
const RESPONSE_TIMEOUT_MS = 20 * 60 * 1000;
/** See `sessions.ts` — a turn that dies after this long with no output at all looks wedged. */
const WEDGE_MIN_TURN_MS = 120_000;
/** How much of agy's stderr to keep for the "it died quietly" diagnostic. */
const STDERR_TAIL_CHARS = 4000;

export interface AgySessionOptions {
  readonly binary: string;
  /** Pass `--dangerously-skip-permissions`; without it agy denies every editor tool call. */
  readonly allowTools: boolean;
  readonly mcpUrl: string;
  readonly mcpToken: string;
  /** Resume this agy conversation instead of starting a new one. */
  readonly conversationId?: string | undefined;
  /**
   * Called after every answered request with the conversation agy is running, how far this chat has
   * got, and the durable key of the chat, so the lane can keep its resume map in step. Fires on
   * answers rather than on `init`, because a conversation id is only useful together with the
   * transcript length it is at.
   */
  readonly onTurnEnd?: (conversationId: string | null, transcriptLen: number, chatKey: string) => void;
  readonly spawner?: AgySpawner;
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Flattened text of a wire message, used for chat identity only. */
const firstText = (message: { content: unknown } | undefined): string => {
  if (!message) return '';
  const { content } = message;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map(block =>
      typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .join('\n')
    .trim();
};

/** Do two texts start the same way? Enough to tell two chats apart without demanding byte equality. */
const sameOpening = (a: string, b: string): boolean => {
  const length = Math.min(200, a.length, b.length);
  return length === 0 ? a === b : a.slice(0, length) === b.slice(0, length);
};

/** A one-line, human-readable trace of one of agy's OWN tool steps. */
const describeAgyTool = (step: AgyStepUpdate): string => {
  const name = step.tool_name ?? step.tool_info?.name ?? 'tool';
  const params = step.tool_info?.parameters ?? {};
  const summary = Object.entries(params)
    .slice(0, 2)
    .map(([key, value]) => `${key}=${clip(typeof value === 'string' ? value : JSON.stringify(value), 120)}`)
    .join(', ');
  return `[agy] ${name}${summary ? `(${summary})` : ''}`;
};

export class AgySession implements ManagedSession {
  readonly id = randomUUID().slice(0, 8);
  readonly model: string;
  transcriptLen = 0;
  lastActivity = Date.now();
  lastProgress = Date.now();
  closed = false;

  private readonly log: Logger;
  private readonly options: AgySessionOptions;
  private readonly effort: WireEffort | undefined;
  private readonly relay = new ToolRelay();
  private readonly workspace: string;
  private readonly logFile: string;
  private child: AgyProcessHandle | null = null;
  private conversationId: string | null = null;
  /** True until the system prompt has been folded into a user turn. */
  private needsSystemPreamble = true;
  private lastSystem: string;
  private pendingContextRefresh: string | null = null;

  /** Identity of the chat this session serves — see {@link AgySession.matchesChat}. */
  private readonly firstUserText: string;
  /** Flattened text of the last answer this session returned, ditto. */
  private lastAnswerText = '';
  /** Durable resume key of the chat, recomputed per request (it firms up once a reply exists). */
  private chatKey: string;

  private stdoutBuffer = '';
  private stderrTail = '';
  private blocks: WireBlock[] = [];
  private textRun = '';
  private readonly renderedToolSteps = new Set<number>();

  private waiting: Deferred<BridgeResponse> | null = null;
  private waitingTimer: NodeJS.Timeout | null = null;
  private requestLen = 0;
  private turnOutputTokens = 0;
  private turnThinkingTokens = 0;
  private promptTokens = 0;
  private cacheReadTokens = 0;
  private turnStartedAt = 0;
  private producedInTurn = false;
  private wedgedSince: number | null = null;
  /** Set when the client aborted: a late `result` for that turn must not answer a new request. */
  private discardNextResult = false;

  constructor(request: WireMessagesRequest, log: Logger, options: AgySessionOptions) {
    this.log = log;
    this.options = options;
    this.model = request.model;
    this.effort = effortOf(request);
    this.lastSystem = systemToText(request.system);
    this.relay.setTools(options.allowTools ? request.tools : []);
    this.relay.setParkListener(() => this.onToolParked());
    this.firstUserText = firstText(request.messages[0]);
    this.chatKey = conversationKey(request.messages);
    this.workspace = path.join(os.homedir(), '.pix3', 'agy-workspaces', this.id);
    this.logFile = path.join(os.homedir(), '.pix3', 'logs', `agy-${this.id}.log`);
    this.conversationId = options.conversationId ?? null;
    // A resumed conversation already carries the system prompt agy was given the first time round;
    // re-sending it would add ~14K tokens of duplicate instructions to every recovered chat.
    this.needsSystemPreamble = this.conversationId === null;
  }

  /** See {@link ManagedSession.resumesInsteadOfReplay}. */
  get resumesInsteadOfReplay(): boolean {
    return this.options.conversationId !== undefined && this.options.conversationId !== null;
  }

  /**
   * See {@link ManagedSession.matchesChat}.
   *
   * Length alone is not an identity. Measured live: two chats that were both two messages long, on
   * the same model, made the router hand the second chat's follow-up to the first chat's session,
   * which answered it from ITS history. What identifies a chat is what this session actually said:
   * the opening user message must be the same one, and the assistant message the editor is
   * continuing from must be the answer this session gave.
   *
   * The comparison is a prefix of the text, because the editor may annotate a stored message; it is
   * still specific enough to separate two chats, which is all this predicate has to do.
   */
  matchesChat(request: WireMessagesRequest): boolean {
    if (firstText(request.messages[0]) !== this.firstUserText) return false;
    if (!this.lastAnswerText) return true; // nothing said yet — length is all there is to go on
    const previous = request.messages[this.transcriptLen - 1];
    if (!previous || previous.role !== 'assistant') return false;
    return sameOpening(firstText(previous), this.lastAnswerText);
  }

  get busy(): boolean {
    return this.waiting !== null;
  }

  get wedged(): boolean {
    return this.wedgedSince !== null;
  }

  hasPendingToolUse(toolUseId: string): boolean {
    return this.relay.hasPendingToolUse(toolUseId);
  }

  toolsMatch(tools: readonly WireToolDefinition[] | undefined): boolean {
    // Tools are stripped when the permission opt-in is off, so a request that still carries them
    // must not be treated as a mismatch against this session's (deliberately empty) set.
    if (!this.options.allowTools) return true;
    return this.relay.toolsMatch(tools);
  }

  effortMatches(request: WireMessagesRequest): boolean {
    return effortOf(request) === this.effort;
  }

  /** The agy conversation this session is attached to, once `init` has reported it. */
  getConversationId(): string | null {
    return this.conversationId;
  }

  handleRequest(request: WireMessagesRequest, signal: AbortSignal): Promise<BridgeResponse> {
    if (this.closed) throw new HttpError(409, 'Session already closed.');
    if (this.waiting) throw new HttpError(409, 'Session is still processing a previous request.');
    this.lastActivity = Date.now();
    // The key hashes the opening EXCHANGE, so it only firms up once an assistant reply exists;
    // recomputing per request is what makes it stable from the second turn onward.
    this.chatKey = conversationKey(request.messages);
    this.trackSystemDrift(request);

    const last = request.messages[request.messages.length - 1];
    const toolResults = extractToolResults(last);
    if (toolResults.length > 0) {
      // agy is still inside its turn, blocked on the MCP call — unblocking it IS the input.
      const matched = this.relay.resolveResults(toolResults);
      if (matched === 0) {
        throw new HttpError(409, 'No editor tool call is waiting for these results.');
      }
    } else {
      this.sendUserTurn(this.renderUserBlocks(toUserContent(last), request));
    }
    return this.awaitResponse(request, signal);
  }

  handleTranscriptReplay(
    request: WireMessagesRequest,
    transcript: string,
    signal: AbortSignal
  ): Promise<BridgeResponse> {
    this.lastActivity = Date.now();
    this.sendUserTurn(this.renderUserBlocks([{ type: 'text', text: transcript }], request));
    return this.awaitResponse(request, signal);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.log(`[${this.id}] closing (${reason})`);
    this.relay.cancelAll('The session was closed.');
    this.failWaiting(new HttpError(500, `agy session closed: ${reason}`));
    if (this.child) {
      this.child.endInput();
      this.child.kill(false);
    }
    this.cleanupWorkspace();
  }

  /**
   * agy has no `interrupt()`, so a session that stopped answering is killed outright. That is
   * cheaper here than in the SDK lane: the conversation lives on agy's disk, so the next turn
   * resumes it with `--conversation` instead of replaying a transcript.
   */
  forceClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.log(`[${this.id}] force-closing (${reason})`);
    this.relay.cancelAll('The session was closed.');
    this.failWaiting(new HttpError(500, `agy session closed: ${reason}`));
    this.child?.kill(true);
    this.cleanupWorkspace();
  }

  // -- spawning ---------------------------------------------------------------

  private ensureProcess(): AgyProcessHandle {
    if (this.child) return this.child;
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });

    const args = [
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--model',
      this.model,
      ...(this.effort ? ['--effort', this.effort] : []),
      ...(this.options.allowTools ? ['--dangerously-skip-permissions'] : []),
      ...(this.conversationId ? ['--conversation', this.conversationId] : []),
      // Before `-p`: agy parses flags in order and a log file set afterwards never opens.
      '--log-file',
      this.logFile,
      // agy would otherwise kill the process 5 minutes into a turn — including one that is merely
      // waiting for the editor to answer a tool call. The bridge owns this deadline.
      '--print-timeout',
      '24h',
      // `-p` is a Go flag and always needs a value; in stream-json input mode the turns come from
      // stdin, so the value is deliberately empty.
      '-p',
      '',
    ];

    const env = agentLaunchEnv(this.options.binary, {
      PIX3_BRIDGE_SESSION: this.id,
      PIX3_BRIDGE_MCP_URL: this.options.mcpUrl,
      PIX3_BRIDGE_MCP_TOKEN: this.options.mcpToken,
    });

    const spawner = this.options.spawner ?? spawnAgy;
    this.log(
      `[${this.id}] spawning agy (${this.model}${this.effort ? `, effort ${this.effort}` : ''}` +
        `${this.conversationId ? `, resuming ${this.conversationId}` : ''}` +
        `${this.options.allowTools ? `, ${this.relay.getToolNames().length} editor tools` : ', no tools'})`
    );
    const child = spawner(this.options.binary, args, { cwd: this.workspace, env });
    child.onStdout(chunk => this.onStdout(chunk));
    child.onStderr(chunk => this.onStderr(chunk));
    child.onExit((code, signal) => this.onExit(code, signal));
    this.child = child;
    return child;
  }

  private cleanupWorkspace(): void {
    try {
      fs.rmSync(this.workspace, { recursive: true, force: true });
    } catch {
      /* a leftover scratch dir is harmless */
    }
  }

  // -- input ------------------------------------------------------------------

  /**
   * agy reads no instructions file from its cwd — measured: neither `AGENTS.md` nor `GEMINI.md`
   * placed there had any effect, because cwd is not a workspace to it. So the editor's system
   * prompt rides in front of the first user turn, and later drift arrives as `<context-refresh>`
   * exactly as it does in the Agent-SDK lane.
   */
  private renderUserBlocks(blocks: WireBlock[], request: WireMessagesRequest): WireBlock[] {
    const content: WireBlock[] = [];
    if (this.needsSystemPreamble) {
      this.needsSystemPreamble = false;
      const system = systemToText(request.system);
      const rules = this.options.allowTools
        ? 'The project is NOT on this machine\'s filesystem — your own file, terminal and browser ' +
          'tools would only see an empty scratch directory. Use the tools of the MCP server named ' +
          '"pix3" for everything; they run inside the editor.'
        : 'You have no tools in this conversation. Your own file, terminal and browser tools would ' +
          'only see an empty scratch directory, so do not use them — answer from what you are told.';
      content.push({
        type: 'text',
        text:
          `You are running inside the Pix3 editor. ${rules}\n\n` +
          'Treat everything between the <operating-instructions> tags as your system prompt for ' +
          `this whole conversation.\n\n<operating-instructions>\n${system}\n</operating-instructions>`,
      });
    }
    if (this.pendingContextRefresh) {
      content.push({
        type: 'text',
        text: `<context-refresh>\nUpdated live editor context (replaces the earlier snapshot):\n${this.pendingContextRefresh}\n</context-refresh>`,
      });
      this.pendingContextRefresh = null;
    }
    content.push(...blocks);
    return content;
  }

  /** One NDJSON turn on agy's stdin. Only text blocks are accepted by its stream input. */
  private sendUserTurn(blocks: readonly WireBlock[]): void {
    const text = blocks
      .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n\n');
    const child = this.ensureProcess();
    child.write(
      `${JSON.stringify({
        event: 'user',
        message: { role: 'user', content: text || '(empty message)' },
      })}\n`
    );
  }

  private trackSystemDrift(request: WireMessagesRequest): void {
    const system = systemToText(request.system);
    if (system === this.lastSystem) return;
    if (this.needsSystemPreamble) {
      // Nothing has been sent yet — the newest system prompt simply becomes the preamble.
      this.lastSystem = system;
      return;
    }
    let common = 0;
    const max = Math.min(system.length, this.lastSystem.length);
    while (common < max && system[common] === this.lastSystem[common]) common += 1;
    const lineStart = system.lastIndexOf('\n', common);
    this.pendingContextRefresh = system.slice(lineStart >= 0 ? lineStart + 1 : 0).slice(0, 32_000);
    this.lastSystem = system;
  }

  // -- output -----------------------------------------------------------------

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private onStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    const line = chunk.trim();
    if (line) this.log(`[${this.id}] agy: ${clip(line, 400)}`);
  }

  private onLine(line: string): void {
    this.lastProgress = Date.now();
    const event = parseAgyEvent(line);
    if (!event) {
      this.log(`[${this.id}] unparseable stream line: ${clip(line, 200)}`);
      return;
    }
    switch (event.event) {
      case 'init': {
        const id = typeof event.conversation_id === 'string' ? event.conversation_id : '';
        if (id) this.conversationId = id;
        return;
      }
      case 'step_update':
        this.onStep((event as { step_update?: AgyStepUpdate }).step_update ?? {});
        return;
      case 'result':
        this.onResult((event as { result?: AgyResult }).result ?? {});
        return;
      default:
        // A newer agy may grow events we do not know. Logging one and treating it as a heartbeat is
        // strictly better than crashing a chat over a field nobody reads.
        this.log(`[${this.id}] ignoring unknown stream event "${event.event}"`);
    }
  }

  private onStep(step: AgyStepUpdate): void {
    if (step.usage) this.accumulateUsage(step.usage);
    switch (step.step_type) {
      case 'agent_response': {
        if (typeof step.text_delta === 'string' && step.text_delta) {
          this.producedInTurn = true;
          this.textRun += step.text_delta;
        }
        return;
      }
      case 'tool': {
        // Editor tools reach us through the relay and are already represented as `tool_use`; only
        // agy's own steps are worth narrating.
        const server = step.tool_info?.parameters?.ServerName;
        if (step.tool_name === 'call_mcp_tool' && server === 'pix3') return;
        const index = step.step_index ?? -1;
        if (index >= 0 && this.renderedToolSteps.has(index)) return;
        if (index >= 0) this.renderedToolSteps.add(index);
        this.producedInTurn = true;
        this.flushTextRun();
        this.blocks.push({ type: 'text', text: describeAgyTool(step) });
        return;
      }
      case 'user_input':
      case 'checkpoint':
        return;
      default:
        if (step.step_type) this.log(`[${this.id}] ignoring unknown step_type "${step.step_type}"`);
    }
  }

  /**
   * Prompt size is the LAST step's `input_tokens` (each step re-sends the conversation), while
   * produced tokens sum across steps. See the header note: the `result` event's own usage is a
   * running total and cannot be used for either.
   */
  private accumulateUsage(usage: AgyUsage): void {
    if (typeof usage.input_tokens === 'number' && usage.input_tokens > 0) {
      this.promptTokens = usage.input_tokens;
    }
    if (typeof usage.cache_read_tokens === 'number' && usage.cache_read_tokens > 0) {
      this.cacheReadTokens = usage.cache_read_tokens;
    }
    if (typeof usage.output_tokens === 'number') this.turnOutputTokens += usage.output_tokens;
    if (typeof usage.thinking_tokens === 'number') this.turnThinkingTokens += usage.thinking_tokens;
  }

  private onResult(result: AgyResult): void {
    if (this.discardNextResult) {
      this.discardNextResult = false;
      this.resetTurnBuffers();
      return;
    }
    if (result.status && result.status !== 'SUCCESS') {
      const message = result.error ?? `agy stopped with status ${result.status}.`;
      this.failWaiting(this.classifyError(message));
      this.resetTurnBuffers();
      return;
    }
    const deniedMcp = (result.denied_actions ?? []).some(action => action.action === 'mcp');
    if (deniedMcp) {
      this.failWaiting(
        new HttpError(
          502,
          'agy refused to call the editor\'s tools (it denies MCP calls unless started with ' +
            '--dangerously-skip-permissions). Run `pix3-agent-bridge agy setup --allow-tools` and ' +
            'restart the bridge.'
        )
      );
      this.resetTurnBuffers();
      return;
    }
    this.flushTextRun();
    if (this.blocks.length === 0 && typeof result.response === 'string' && result.response.trim()) {
      this.blocks.push({ type: 'text', text: result.response });
    }
    this.respond('end_turn');
  }

  private classifyError(message: string): HttpError {
    if (looksLikeQuota(message)) {
      return new HttpError(429, `agy is out of quota right now: ${clip(message, 400)}`);
    }
    if (looksLikeAuth(message)) {
      return new HttpError(
        401,
        `agy is not signed in: ${clip(message, 300)} — run \`agy\` once in a terminal and complete the sign-in.`
      );
    }
    return new HttpError(502, `agy error: ${clip(message, 400)}`);
  }

  private onExit(code: number | null, signal: string | null): void {
    if (this.closed) return;
    this.closed = true;
    const tail = this.stderrTail.trim();
    this.log(`[${this.id}] agy exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
    this.relay.cancelAll('The agy process exited.');
    this.failWaiting(
      new HttpError(
        502,
        `agy exited unexpectedly (code ${code ?? 'null'}).` +
          (tail ? ` Last output: ${clip(tail, 400)}` : ` See ${this.logFile}.`)
      )
    );
    this.cleanupWorkspace();
  }

  // -- responding -------------------------------------------------------------

  private onToolParked(): void {
    this.producedInTurn = true;
    this.lastProgress = Date.now();
    if (this.waiting && this.relay.hasUnflushed()) this.respond('tool_use');
  }

  private awaitResponse(request: WireMessagesRequest, signal: AbortSignal): Promise<BridgeResponse> {
    const waiting = new Deferred<BridgeResponse>();
    this.waiting = waiting;
    this.requestLen = request.messages.length;
    this.turnStartedAt = Date.now();
    this.producedInTurn = false;
    this.turnOutputTokens = 0;
    this.turnThinkingTokens = 0;
    this.waitingTimer = setTimeout(() => {
      if (this.waiting === waiting) {
        this.waiting = null;
        this.noteTurnFailed('the 20-minute request timeout expired');
        waiting.reject(new HttpError(504, 'Timed out waiting for agy.'));
      }
    }, RESPONSE_TIMEOUT_MS);
    if (signal.aborted) this.onHttpAbort(waiting);
    else signal.addEventListener('abort', () => this.onHttpAbort(waiting), { once: true });
    // A call may already be parked from before this request arrived.
    if (this.relay.hasUnflushed()) this.respond('tool_use');
    return waiting.promise.finally(() => {
      if (this.waitingTimer) clearTimeout(this.waitingTimer);
      this.waitingTimer = null;
      this.lastActivity = Date.now();
    });
  }

  private onHttpAbort(waiting: Deferred<BridgeResponse>): void {
    if (this.waiting !== waiting) return;
    this.log(`[${this.id}] request aborted by client`);
    this.waiting = null;
    this.noteTurnFailed('the client gave up on the request');
    waiting.reject(new HttpError(499, 'Request cancelled.'));
    this.discardNextResult = true;
    this.resetTurnBuffers();
    this.relay.cancelAll('Cancelled by the user.');
  }

  private flushTextRun(): void {
    const text = this.textRun;
    this.textRun = '';
    if (text.trim()) this.blocks.push({ type: 'text', text });
  }

  private resetTurnBuffers(): void {
    this.blocks = [];
    this.textRun = '';
    this.renderedToolSteps.clear();
  }

  private respond(stopReason: 'tool_use' | 'end_turn'): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.flushTextRun();
    const content = [...this.blocks];
    if (stopReason === 'tool_use') content.push(...this.relay.takeUnflushedBlocks());
    if (content.length === 0) content.push({ type: 'text', text: '(no output)' });
    this.blocks = [];
    this.renderedToolSteps.clear();
    this.waiting = null;
    this.turnStartedAt = 0;
    this.wedgedSince = null;
    this.transcriptLen = this.requestLen + 1;
    this.lastAnswerText = content
      .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
      .trim();
    this.options.onTurnEnd?.(this.conversationId, this.transcriptLen, this.chatKey);
    waiting.resolve({
      status: 200,
      body: {
        id: `msg_agy_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content,
        stop_reason: stopReason,
        usage: {
          input_tokens: Math.max(0, this.promptTokens - this.cacheReadTokens),
          output_tokens: Math.max(1, this.turnOutputTokens + this.turnThinkingTokens),
          cache_read_input_tokens: this.cacheReadTokens,
        },
      },
    });
  }

  private noteTurnFailed(cause: string): void {
    const ranFor = this.turnStartedAt > 0 ? Date.now() - this.turnStartedAt : 0;
    this.turnStartedAt = 0;
    if (this.producedInTurn || ranFor < WEDGE_MIN_TURN_MS || this.wedgedSince !== null) return;
    this.wedgedSince = Date.now();
    this.log(
      `[${this.id}] looks wedged: ${Math.round(ranFor / 1000)}s with no output and ${cause}`
    );
  }

  private failWaiting(error: unknown): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = null;
    waiting.reject(error);
  }

  // -- MCP relay (called by the HTTP route the shim posts to) -----------------

  listTools(): { tools: Array<Record<string, unknown>> } {
    return this.relay.listTools();
  }

  callTool(name: string, input: unknown): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    return this.relay.call(name, input);
  }
}
