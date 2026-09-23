/** Discovery, session pool and MCP relay for the local Codex CLI lane. */
import os from 'node:os';
import path from 'node:path';

import { conversationKey, ConversationStore } from './agy-conversations.ts';
import { CODEX_AGENT_ID, CODEX_LABEL, codexModels, detectCodex, type CodexStatus } from './codex.ts';
import { CodexSession } from './codex-session.ts';
import { generateCodexImage, type CodexImageRequest, type CodexImageResult } from './codex-image.ts';
import { SessionManager, type BridgeResponse, type ManagedSession } from './sessions.ts';
import type { BridgeConfig } from './config.ts';
import type { Logger } from './util.ts';
import { HttpError, type WireMessagesRequest } from './wire.ts';

const STATUS_TTL_MS = 60_000;

export class CodexLane {
  readonly manager: SessionManager;
  private readonly config: BridgeConfig;
  private readonly log: Logger;
  private readonly sessions = new Map<string, CodexSession>();
  private readonly conversations = new ConversationStore(path.join(os.homedir(), '.pix3', 'codex-sessions.json'));
  private status: CodexStatus | null = null;
  private statusAt = 0;
  private pending: Promise<CodexStatus> | null = null;

  constructor(config: BridgeConfig, log: Logger) {
    this.config = config;
    this.log = log;
    this.manager = new SessionManager(log, {
      stallTimeoutMs: config.stallTimeoutMs,
      maxSessions: 2,
      label: '[codex]',
      createSession: (request, logger) => this.createSession(request, logger),
    });
  }

  async getStatus(force = false): Promise<CodexStatus> {
    if (!force && this.status && Date.now() - this.statusAt < STATUS_TTL_MS) return this.status;
    if (this.pending) return this.pending;
    this.pending = detectCodex().catch(error => ({
      available: false, auth: 'unknown' as const, mcp: 'missing' as const, toolsEnabled: false,
      diagnostics: [{ reason: 'detection-failed', severity: 'error' as const,
        message: 'Could not probe Codex CLI.', detail: String(error) }],
    })).then(status => {
      this.status = status;
      this.statusAt = Date.now();
      this.pending = null;
      return status;
    });
    return this.pending;
  }

  async discoveryEntry() {
    const status = await this.getStatus();
    return {
      id: CODEX_AGENT_ID, label: CODEX_LABEL, kind: 'agent-cli' as const,
      available: status.available, auth: status.auth, mcp: status.mcp,
      tools: status.toolsEnabled ? 'enabled' as const : 'disabled' as const,
      imageGeneration: status.imageGenerationEnabled === true,
      ...(status.version ? { version: status.version } : {}),
      ...(status.path ? { path: status.path } : {}),
      ...(status.diagnostics.length ? { diagnostics: status.diagnostics } : {}),
    };
  }

  async listModels() {
    const status = await this.getStatus();
    if (!status.available) throw new HttpError(503, 'Codex CLI is unavailable.');
    if (status.auth === 'missing') throw new HttpError(401, 'Codex CLI is not signed in. Run `codex login`.');
    return codexModels(status.toolsEnabled);
  }

  async handleMessages(request: WireMessagesRequest, signal: AbortSignal): Promise<BridgeResponse> {
    const status = await this.getStatus();
    if (!status.available) throw new HttpError(503, 'Codex CLI is unavailable.');
    if (status.auth === 'missing') throw new HttpError(401, 'Codex CLI is not signed in. Run `codex login`.');
    if (!codexModels(status.toolsEnabled).some(model => model.id === request.model)) {
      throw new HttpError(400, `Unknown Codex model "${request.model}".`);
    }
    return this.manager.handle(request, signal);
  }

  async generateImage(request: CodexImageRequest, signal: AbortSignal): Promise<CodexImageResult> {
    const status = await this.getStatus();
    if (!status.available || !status.path) throw new HttpError(503, 'Codex CLI is unavailable.');
    if (status.auth !== 'ok') throw new HttpError(401, 'Codex CLI is not signed in. Run `codex login`.');
    if (!status.imageGenerationEnabled) throw new HttpError(503,
      'This Codex CLI does not provide native image generation. Update Codex CLI and restart the bridge.');
    return generateCodexImage(status.path, request, signal);
  }

  async handleMcp(sessionId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw new HttpError(404, `No live Codex session "${sessionId}".`);
    if (method === 'tools/list') return session.listTools();
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!name) throw new HttpError(400, 'tools/call needs a tool name.');
      return session.callTool(name, params.arguments ?? {});
    }
    throw new HttpError(400, `Unsupported MCP method "${method}".`);
  }

  closeAll(reason: string): void {
    this.manager.closeAll(reason);
    this.sessions.clear();
  }

  private createSession(request: WireMessagesRequest, log: Logger): ManagedSession {
    const binary = this.status?.path;
    if (!binary) throw new HttpError(503, 'Codex CLI is unavailable.');
    const key = conversationKey(request.messages);
    const remembered = this.conversations.get(key);
    const conversationId = remembered?.model === request.model &&
      remembered.transcriptLen === request.messages.length - 1
      ? remembered.conversationId : undefined;
    const session = new CodexSession(request, log, {
      binary,
      mcpUrl: `http://127.0.0.1:${this.config.port}/agents/${CODEX_AGENT_ID}/mcp`,
      mcpToken: this.config.mcpToken,
      ...(conversationId ? { conversationId } : {}),
      onTurnEnd: (id, transcriptLen, chatKey) => {
        if (id) this.conversations.remember(chatKey, {
          conversationId: id, model: request.model, transcriptLen, updatedAt: Date.now(),
        });
      },
    });
    this.sessions.set(session.id, session);
    for (const [id, candidate] of this.sessions) if (candidate.closed) this.sessions.delete(id);
    return session;
  }
}
