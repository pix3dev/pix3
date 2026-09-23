/** One Pix3 chat served by successive `codex exec --json` turns. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { conversationKey } from './agy-conversations.ts';
import { agentLaunchEnv } from './executables.ts';
import { agyShimPath } from './mcp-shim.ts';
import { ToolRelay } from './tool-relay.ts';
import { Deferred, type Logger } from './util.ts';
import { effortOf, extractToolResults, isRecord, systemToText, toUserContent, HttpError } from './wire.ts';
import type { WireMessagesRequest, WireToolDefinition, WireEffort, WireBlock } from './wire.ts';
import type { BridgeResponse, ManagedSession } from './sessions.ts';

const RESPONSE_TIMEOUT_MS = 20 * 60_000;
const WEDGE_MIN_TURN_MS = 120_000;

export interface CodexSessionOptions {
  readonly binary: string;
  readonly mcpUrl: string;
  readonly mcpToken: string;
  readonly conversationId?: string;
  readonly onTurnEnd?: (conversationId: string | null, transcriptLen: number, chatKey: string) => void;
  readonly spawner?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
}

const messageText = (request: WireMessagesRequest, index: number): string => {
  const message = request.messages[index];
  if (!message) return '';
  return toUserContent(message).map(block => typeof block.text === 'string' ? block.text : '').join('\n');
};

/** TOML string literal for a `codex -c key=value` override. */
const tomlString = (value: string): string => JSON.stringify(value);

export interface CodexLaunchArgsOptions {
  readonly conversationId: string | null;
  readonly model: string;
  readonly effort?: WireEffort;
  readonly toolNames: readonly string[];
}

/** Build the fixed, tool-enabled Codex invocation used for every editor session. */
export const codexLaunchArgs = (options: CodexLaunchArgsOptions): string[] => {
  const config = [
    '-c', 'approval_policy="on-request"',
    '-c', 'sandbox_mode="read-only"',
    '-c', 'features.shell_tool=false',
    '-c', 'tools.view_image=false',
    '-c', 'tools.web_search=false',
    '-c', `mcp_servers.pix3.command=${tomlString(process.execPath)}`,
    '-c', `mcp_servers.pix3.args=[${tomlString(agyShimPath())}]`,
    '-c', 'mcp_servers.pix3.env_vars=["PIX3_BRIDGE_SESSION","PIX3_BRIDGE_MCP_URL","PIX3_BRIDGE_MCP_TOKEN"]',
    '-c', 'mcp_servers.pix3.required=true',
    '-c', 'mcp_servers.pix3.default_tools_approval_mode="auto"',
    ...options.toolNames.flatMap(name => [
      '-c', `mcp_servers.pix3.tools.${tomlString(name)}.approval_mode="auto"`,
    ]),
    '-c', 'mcp_servers.pix3.tool_timeout_sec=1200',
  ];
  return ['exec', ...(options.conversationId ? ['resume', options.conversationId] : []),
    '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox', ...config,
    '-m', options.model,
    ...(options.effort ? ['-c', `model_reasoning_effort=${tomlString(options.effort)}`] : []), '-'];
};

export class CodexSession implements ManagedSession {
  readonly id = randomUUID().slice(0, 8);
  readonly model: string;
  transcriptLen = 0;
  lastActivity = Date.now();
  lastProgress = Date.now();
  closed = false;

  private readonly log: Logger;
  private readonly options: CodexSessionOptions;
  private readonly effort: WireEffort | undefined;
  private readonly relay = new ToolRelay();
  private readonly workspace: string;
  private readonly firstUser: string;
  private readonly resumes: boolean;
  private chatKey: string;
  private conversationId: string | null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private stderrTail = '';
  private textBlocks: string[] = [];
  private lastAnswer = '';
  private lastSystem: string;
  private waiting: Deferred<BridgeResponse> | null = null;
  private requestLen = 0;
  private promptTokens = 0;
  private outputTokens = 0;
  private turnStartedAt = 0;
  private producedInTurn = false;
  private wedgedSince: number | null = null;

  constructor(request: WireMessagesRequest, log: Logger, options: CodexSessionOptions) {
    this.model = request.model;
    this.log = log;
    this.options = options;
    this.effort = effortOf(request);
    this.lastSystem = systemToText(request.system);
    this.firstUser = messageText(request, 0);
    this.chatKey = conversationKey(request.messages);
    this.conversationId = options.conversationId ?? null;
    this.resumes = !!options.conversationId;
    this.workspace = path.join(os.homedir(), '.pix3', 'codex-workspaces', this.id);
    this.relay.setTools(request.tools);
    this.relay.setParkListener(() => this.onToolParked());
  }

  get resumesInsteadOfReplay(): boolean { return this.resumes; }
  get busy(): boolean { return this.waiting !== null; }
  get wedged(): boolean { return this.wedgedSince !== null; }
  hasPendingToolUse(id: string): boolean { return this.relay.hasPendingToolUse(id); }
  toolsMatch(tools: readonly WireToolDefinition[] | undefined): boolean {
    return this.relay.toolsMatch(tools);
  }
  effortMatches(request: WireMessagesRequest): boolean { return effortOf(request) === this.effort; }
  matchesChat(request: WireMessagesRequest): boolean {
    if (messageText(request, 0) !== this.firstUser) return false;
    if (!this.lastAnswer) return true;
    const previous = request.messages[this.transcriptLen - 1];
    if (!previous || previous.role !== 'assistant') return false;
    const content = typeof previous.content === 'string' ? previous.content : previous.content
      .map(block => typeof block.text === 'string' ? block.text : '').join('\n');
    return content.slice(0, 200) === this.lastAnswer.slice(0, 200);
  }

  async handleRequest(request: WireMessagesRequest, signal: AbortSignal): Promise<BridgeResponse> {
    if (this.closed) throw new HttpError(409, 'Codex session closed.');
    if (this.waiting) throw new HttpError(409, 'Codex session is already processing a request.');
    this.lastActivity = Date.now();
    this.chatKey = conversationKey(request.messages);
    const last = request.messages[request.messages.length - 1];
    const results = extractToolResults(last);
    const response = this.awaitResponse(request, signal);
    if (results.length) {
      if (this.relay.resolveResults(results) === 0) {
        this.fail(new HttpError(409, 'No Codex editor tool call is waiting for these results.'));
      }
    } else {
      if (this.child) this.fail(new HttpError(409, 'The previous Codex turn is still running.'));
      else this.start(this.renderPrompt(messageText(request, request.messages.length - 1), request));
    }
    return response;
  }

  handleTranscriptReplay(request: WireMessagesRequest, transcript: string, signal: AbortSignal): Promise<BridgeResponse> {
    const replay = { ...request, system: request.system };
    const response = this.awaitResponse(request, signal);
    this.start(this.renderPrompt(transcript, replay));
    return response;
  }

  close(reason: string): void { this.forceClose(reason); }
  forceClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.relay.cancelAll('Codex session closed.');
    this.fail(new HttpError(500, `Codex session closed: ${reason}`));
    this.killChild();
    this.cleanup();
  }

  listTools(): { tools: Array<Record<string, unknown>> } { return this.relay.listTools(); }
  callTool(name: string, input: unknown) { return this.relay.call(name, input); }

  private renderPrompt(input: string, request: WireMessagesRequest): string {
    const system = systemToText(request.system);
    let preamble = '';
    if (!this.conversationId) {
      preamble = 'You are the assistant inside the Pix3 editor. The project is held in the browser, ' +
        'not in this scratch directory. Use only the pix3 MCP tools for editor work. ' +
        'Do not use shell, file editing, or other local tools. The following are operating instructions for ' +
        `this Pix3 chat:\n<operating-instructions>\n${system}\n</operating-instructions>\n\n`;
    } else if (system !== this.lastSystem) {
      preamble = `<context-refresh>\n${system.slice(-32_000)}\n</context-refresh>\n\n`;
    }
    this.lastSystem = system;
    return `${preamble}${input || '(empty message)'}`;
  }

  private start(prompt: string): void {
    fs.mkdirSync(this.workspace, { recursive: true });
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.textBlocks = [];
    this.promptTokens = 0;
    this.outputTokens = 0;
    const args = codexLaunchArgs({
      conversationId: this.conversationId,
      model: this.model,
      effort: this.effort,
      toolNames: this.relay.getToolNames(),
    });
    const env = agentLaunchEnv(this.options.binary, {
      PIX3_BRIDGE_SESSION: this.id,
      PIX3_BRIDGE_MCP_URL: this.options.mcpUrl,
      PIX3_BRIDGE_MCP_TOKEN: this.options.mcpToken,
    });
    const child = (this.options.spawner ?? ((file, argv, options) => spawn(file, argv, {
      ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })))(this.options.binary, args, { cwd: this.workspace, env });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-4000); });
    child.on('error', error => this.onExit(null, error.message));
    child.on('exit', code => this.onExit(code, null));
    child.stdin.end(prompt);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let end = this.stdoutBuffer.indexOf('\n');
    while (end >= 0) {
      const line = this.stdoutBuffer.slice(0, end).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(end + 1);
      if (line) this.onEvent(line);
      end = this.stdoutBuffer.indexOf('\n');
    }
  }

  private onEvent(line: string): void {
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; }
    if (!isRecord(event)) return;
    this.lastProgress = Date.now();
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      this.conversationId = event.thread_id;
    } else if (event.type === 'item.completed' && isRecord(event.item) &&
      event.item.type === 'agent_message' && typeof event.item.text === 'string') {
      this.textBlocks.push(event.item.text);
      this.producedInTurn = true;
    } else if (event.type === 'turn.completed' && isRecord(event.usage)) {
      this.promptTokens = typeof event.usage.input_tokens === 'number' ? event.usage.input_tokens : 0;
      this.outputTokens = typeof event.usage.output_tokens === 'number' ? event.usage.output_tokens : 0;
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      const detail = isRecord(event.error) && typeof event.error.message === 'string'
        ? event.error.message : JSON.stringify(event).slice(0, 500);
      this.fail(new HttpError(/auth|sign.in|login/i.test(detail) ? 401 : 502, `Codex: ${detail}`));
    }
  }

  private onExit(code: number | null, error: string | null): void {
    if (!this.child) return;
    this.child = null;
    if (this.closed) return;
    if (code !== 0) {
      this.fail(new HttpError(502, `Codex exited (${code ?? 'unknown'}): ${error ?? this.stderrTail.trim().slice(-500)}`));
    } else if (this.relay.hasUnflushed()) {
      this.fail(new HttpError(502, 'Codex exited while an editor tool was still pending.'));
    } else {
      this.respond('end_turn');
    }
    this.lastActivity = Date.now();
  }

  private onToolParked(): void {
    this.lastProgress = Date.now();
    this.producedInTurn = true;
    if (this.waiting) this.respond('tool_use');
  }

  private awaitResponse(request: WireMessagesRequest, signal: AbortSignal): Promise<BridgeResponse> {
    const waiting = new Deferred<BridgeResponse>();
    this.waiting = waiting;
    this.requestLen = request.messages.length;
    this.turnStartedAt = Date.now();
    this.producedInTurn = false;
    const timer = setTimeout(() => {
      if (this.waiting === waiting) {
        this.markWedged();
        this.fail(new HttpError(504, 'Timed out waiting for Codex.'));
      }
    }, RESPONSE_TIMEOUT_MS);
    const abort = () => {
      if (this.waiting !== waiting) return;
      this.markWedged();
      this.fail(new HttpError(499, 'Codex request cancelled.'));
      this.forceClose('client cancelled');
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    if (this.relay.hasUnflushed()) this.respond('tool_use');
    return waiting.promise.finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
  }

  private respond(reason: 'tool_use' | 'end_turn'): void {
    const waiting = this.waiting;
    if (!waiting) return;
    const content: WireBlock[] = this.textBlocks.splice(0).filter(Boolean).map(text => ({ type: 'text', text }));
    if (reason === 'tool_use') content.push(...this.relay.takeUnflushedBlocks());
    if (!content.length) content.push({ type: 'text', text: '(no output)' });
    this.waiting = null;
    this.turnStartedAt = 0;
    this.wedgedSince = null;
    this.transcriptLen = this.requestLen + 1;
    this.lastAnswer = content.filter(block => block.type === 'text').map(block => block.text).filter((text): text is string => typeof text === 'string').join('\n');
    if (this.requestLen === 1) {
      // The durable key includes the opening exchange. The first request has no assistant message
      // yet, so firm up its key from the response before persisting the Codex thread id.
      this.chatKey = conversationKey([
        { role: 'user', content: this.firstUser },
        { role: 'assistant', content },
      ]);
    }
    this.options.onTurnEnd?.(this.conversationId, this.transcriptLen, this.chatKey);
    waiting.resolve({ status: 200, body: {
      id: `msg_codex_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message', role: 'assistant', model: this.model, content, stop_reason: reason,
      usage: { input_tokens: this.promptTokens, output_tokens: Math.max(1, this.outputTokens) },
    } });
  }

  private markWedged(): void {
    if (!this.producedInTurn && Date.now() - this.turnStartedAt >= WEDGE_MIN_TURN_MS) {
      this.wedgedSince = Date.now();
    }
  }
  private fail(error: HttpError): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error);
  }
  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref();
    } else child.kill('SIGKILL');
  }
  private cleanup(): void {
    try { fs.rmSync(this.workspace, { recursive: true, force: true }); } catch { /* scratch only */ }
  }
}
