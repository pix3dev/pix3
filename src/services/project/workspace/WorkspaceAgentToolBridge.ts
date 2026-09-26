import { subscribe } from 'valtio/vanilla';
import { inject, injectable, injectLazy, type LazyService } from '@/fw/di';
import { appState } from '@/state';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { AutosaveService } from '@/services/project/autosave/AutosaveService';
import { MergeLogService } from '@/services/project/coauthoring/MergeLogService';
import { toProjectPath } from '@/services/project/coauthoring/coauthoring-paths';
import { ProjectSyncService } from '@/services/project/ProjectSyncService';
import {
  WorkspaceSessionService,
  type WorkspaceCallContext,
} from '@/services/project/workspace/WorkspaceSessionService';
import type {
  WorkspaceCallContent,
  WorkspaceCallFrame,
  WorkspaceCallResult,
} from '@/services/project/workspace/workspace-protocol';
import type { AgentToolRegistry, AgentToolSpec } from '@/services/agent/AgentToolRegistry';
import type { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';

/**
 * The editor end of the live agent channel (plan §5 D) over a `pix3 serve` workspace: serves the
 * `call` frames that `pix3 mcp --workspace` relays through the server's agent lane.
 *
 * - **Allowlist.** Exactly {@link WORKSPACE_AGENT_TOOLS} (no scene-mutating tool, plan §4.1) plus
 *   the internal `sync_barrier`, `sync_release` and `tools_manifest`. Tools execute through
 *   `AgentToolRegistry.execute` — the same entry the debug bridge uses, no chat session.
 * - **Results** are MCP `CallToolResult`s: the handler's JSON as one text block; images the tool
 *   returned under `__images` become `{type:'image', data, mimeType}` blocks (base64, no `data:`
 *   prefix) — `pix3 mcp` hands them to the agent as real images. `{ok:false}` sets `isError`.
 *   Observing tools carry `_meta.pix3 = {playRevision, stale}`.
 * - **`sync_barrier`** (barrier step 2): holds autosave, stops play, `ProjectSyncService.syncNow()`
 *   (waits for the stabilisation window and the script build), and answers
 *   `{loaded: {path: sha256}, errors: [{file, line?, message, kind}], holdId}` — the open scenes and
 *   built script sources. The hold lasts until `sync_release {holdId}` (the MCP process sends it
 *   after the run) or {@link HOLD_SAFETY_MS}.
 * - **`generate_*` permission** (plan §1.2 "Граница доверия"): the first generation of a
 *   connection — server session + lease + `pix3 mcp` process — asks the human (non-blocking prompt,
 *   {@link PERMISSION_TIMEOUT_MS} to decide, else `permission_denied`). Allowed → up to
 *   {@link GENERATE_SESSION_LIMIT} generations, then it asks again. In memory only: a reconnect, a
 *   new server session, a lease takeover or a new MCP process resets it; Revoke drops it.
 * - **Disconnect**: the human can switch the channel off (status-bar pill); calls are then refused
 *   until it is switched on again.
 */

/** The v1 tool surface. Keep in step with `packages/pix3-cli/src/workspace-agent/tools.ts`. */
export const WORKSPACE_AGENT_TOOLS: readonly string[] = [
  'project_status',
  'play_start',
  'play_stop',
  'play_restart',
  'play_status',
  'game_run',
  'game_input',
  'game_observe',
  'read_errors',
  'read_logs',
  'viewport_screenshot',
  'generate_asset',
  'generate_sfx',
  'get_selection',
];

const INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  'sync_barrier',
  'sync_release',
  'tools_manifest',
]);
const GENERATE_TOOLS: ReadonlySet<string> = new Set(['generate_asset', 'generate_sfx']);
const START_TOOLS: ReadonlySet<string> = new Set(['play_start', 'play_restart', 'game_run']);
const OBSERVING_TOOLS: ReadonlySet<string> = new Set([
  'play_status',
  'game_input',
  'game_observe',
  'viewport_screenshot',
  'read_errors',
  'read_logs',
]);

export const GENERATE_SESSION_LIMIT = 20;
export const PERMISSION_TIMEOUT_MS = 60_000;
export const HOLD_SAFETY_MS = 180_000;
const RUNTIME_ATTACH_TIMEOUT_MS = 5_000;
const PLAY_STOP_TIMEOUT_MS = 3_000;
const MERGE_LOG_TAIL = 10;
/** Answers kept for calls the server re-delivers after a reconnect (same id = same call). */
const COMPLETED_MEMORY = 50;

export type AgentChannelActivity = 'idle' | 'syncing' | 'running';

export interface AgentPermissionPrompt {
  readonly id: number;
  readonly agentName: string | null;
  readonly root: string | null;
  readonly tool: string;
}

export interface AgentChannelState {
  /** False after the human switched the channel off. */
  readonly enabled: boolean;
  /** A call arrived in this server session (the pill is shown from then on). */
  readonly seen: boolean;
  /** Self-declared by the MCP process; never verified. */
  readonly agentName: string | null;
  readonly activity: AgentChannelActivity;
  readonly activeTool: string | null;
  readonly lastCallAt: number | null;
  readonly permission: 'unset' | 'allowed' | 'denied';
  readonly generationsUsed: number;
  readonly prompt: AgentPermissionPrompt | null;
}

export interface SyncBarrierError {
  readonly file: string | null;
  readonly line?: number;
  readonly message: string;
  readonly kind: 'load' | 'compile' | 'pending';
}

/** Every effect of the bridge on the editor — a fake in tests. */
export interface WorkspaceAgentHost {
  executeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  toolSpecs(names: ReadonlySet<string>): Promise<AgentToolSpec[]>;
  isPlaying(): boolean;
  stopPlay(): Promise<void>;
  waitForRuntime(timeoutMs: number): Promise<boolean>;
  holdAutosave(reason: string): () => void;
  /** `syncNow()` + the built scripts: `{path: sha256}` of what the editor has loaded. */
  syncLoaded(): Promise<Record<string, string>>;
  buildError(): Promise<{ file: string | null; line?: number; message: string } | null>;
  mergeLogTail(limit: number): Promise<unknown[]>;
}

type PermissionDecision = 'allow' | 'deny';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const text = (value: string, isError = false): WorkspaceCallResult => ({
  content: [{ type: 'text', text: value }],
  ...(isError ? { isError: true } : {}),
});

const errorResult = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {}
): WorkspaceCallResult => text(JSON.stringify({ error: code, message, ...extra }), true);

/** A tool handler's value as an MCP result: JSON text + `__images` lifted into image blocks. */
export function toCallResult(value: unknown): WorkspaceCallResult {
  const content: WorkspaceCallContent[] = [];
  let payload: unknown = value;
  const images: WorkspaceCallContent[] = [];
  if (isRecord(value) && Array.isArray(value.__images)) {
    const { __images: raw, ...rest } = value;
    payload = rest;
    for (const image of raw as unknown[]) {
      if (isRecord(image) && typeof image.data === 'string' && typeof image.mimeType === 'string') {
        images.push({ type: 'image', data: image.data, mimeType: image.mimeType });
      }
    }
  }
  content.push({
    type: 'text',
    text: typeof payload === 'string' ? payload : JSON.stringify(payload ?? null),
  });
  content.push(...images);
  const failed = isRecord(payload) && payload.ok === false;
  return { content, ...(failed ? { isError: true } : {}) };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

@injectable()
export class WorkspaceAgentToolBridge {
  @inject(WorkspaceSessionService)
  private readonly session!: WorkspaceSessionService;

  @inject(AutosaveService)
  private readonly autosave!: AutosaveService;

  @inject(ProjectSyncService)
  private readonly projectSync!: ProjectSyncService;

  @inject(CommandDispatcher)
  private readonly dispatcher!: CommandDispatcher;

  @inject(GamePlaySessionService)
  private readonly playSession!: GamePlaySessionService;

  @inject(MergeLogService)
  private readonly mergeLog!: MergeLogService;

  /** The tool table pulls most of the editor behind it: loaded on the first call. */
  @injectLazy(() => import('@/services/agent/AgentToolRegistry').then(m => m.AgentToolRegistry))
  private readonly registry!: LazyService<AgentToolRegistry>;

  @injectLazy(() =>
    import('@/services/scripting/ProjectScriptLoaderService').then(
      m => m.ProjectScriptLoaderService
    )
  )
  private readonly scriptLoader!: LazyService<ProjectScriptLoaderService>;

  private hostOverride: WorkspaceAgentHost | null = null;
  private readonly listeners = new Set<() => void>();
  private disposers: Array<() => void> = [];

  private enabled = true;
  private seen = false;
  private agentName: string | null = null;
  private lastCallAt: number | null = null;
  private readonly active = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<WorkspaceCallResult>>();
  private readonly completed = new Map<string, WorkspaceCallResult>();

  /** Connection the permission belongs to: serverSession | leaseId | MCP process session. */
  private permissionKey: string | null = null;
  private permission: 'unset' | 'allowed' | 'denied' = 'unset';
  private generationsUsed = 0;
  private prompt: AgentPermissionPrompt | null = null;
  private promptWaiters: Array<(decision: PermissionDecision | 'timeout') => void> = [];
  private promptTimer: ReturnType<typeof setTimeout> | null = null;
  private nextPromptId = 1;

  private readonly holds = new Map<
    string,
    { release: () => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextHoldId = 1;
  private lastBarrierLoaded: Record<string, string> | null = null;
  /** Server session the channel state belongs to; a new one resets `seen` and the permission. */
  private stateSession: string | null = null;

  /** Register with the workspace session and follow play mode / lease changes. */
  initialize(): void {
    if (this.disposers.length > 0) return;
    this.session.setCallHandler((frame, context) => this.handleCall(frame, context));
    this.disposers.push(() => this.session.setCallHandler(null));
    this.disposers.push(
      subscribe(appState.ui, () => {
        if (!appState.ui.isPlaying && appState.project.coauthoring.playRevision !== null) {
          appState.project.coauthoring.playRevision = null;
        }
      })
    );
    this.disposers.push(
      subscribe(appState.project.workspace, () => {
        const workspace = appState.project.workspace;
        if (
          workspace.lease === 'lost' ||
          workspace.lease === 'none' ||
          workspace.status === 'disconnected'
        ) {
          this.onLeaseGone();
        }
      })
    );
  }

  /** Tests: every effect on the editor goes through this host. */
  setHost(host: WorkspaceAgentHost | null): void {
    this.hostOverride = host;
  }

  getState(): AgentChannelState {
    const activeTools = Array.from(this.active.values());
    const activity: AgentChannelActivity = activeTools.includes('sync_barrier')
      ? 'syncing'
      : activeTools.length > 0
        ? 'running'
        : 'idle';
    return {
      enabled: this.enabled,
      seen: this.seen,
      agentName: this.agentName,
      activity,
      activeTool: activeTools.find(name => name !== 'sync_barrier') ?? activeTools[0] ?? null,
      lastCallAt: this.lastCallAt,
      permission: this.permission,
      generationsUsed: this.generationsUsed,
      prompt: this.prompt,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The human's "Disconnect" / "Reconnect" of the channel (calls are refused while off). */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.resolvePrompt('deny');
      this.revokeGeneration();
    }
    this.notify();
  }

  /** Answer the pending generation prompt. */
  decide(decision: PermissionDecision): void {
    this.resolvePrompt(decision);
  }

  /** Drop the generation permission of this connection (the next generation asks again). */
  revokeGeneration(): void {
    this.permission = 'unset';
    this.generationsUsed = 0;
    this.notify();
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.resolvePrompt('deny');
    for (const hold of this.holds.values()) {
      clearTimeout(hold.timer);
      hold.release();
    }
    this.holds.clear();
    this.listeners.clear();
  }

  // --- calls ------------------------------------------------------------------------------------

  /** Serve one `call` frame. A re-delivered id (reconnect) joins or repeats the first answer. */
  handleCall(
    frame: WorkspaceCallFrame,
    context: WorkspaceCallContext
  ): Promise<WorkspaceCallResult> {
    const done = this.completed.get(frame.id);
    if (done) return Promise.resolve(done);
    const running = this.inflight.get(frame.id);
    if (running) return running;
    const promise = this.serve(frame, context).then(
      result => this.finish(frame.id, result),
      (error: unknown) =>
        this.finish(frame.id, text(error instanceof Error ? error.message : String(error), true))
    );
    this.inflight.set(frame.id, promise);
    return promise;
  }

  private finish(id: string, result: WorkspaceCallResult): WorkspaceCallResult {
    this.inflight.delete(id);
    this.completed.set(id, result);
    if (this.completed.size > COMPLETED_MEMORY) {
      const oldest = this.completed.keys().next().value;
      if (oldest !== undefined) this.completed.delete(oldest);
    }
    return result;
  }

  private async serve(
    frame: WorkspaceCallFrame,
    context: WorkspaceCallContext
  ): Promise<WorkspaceCallResult> {
    this.noteConnection(frame, context);
    const name = frame.name;
    if (!WORKSPACE_AGENT_TOOLS.includes(name) && !INTERNAL_TOOLS.has(name)) {
      return errorResult(
        'unknown_tool',
        `"${name}" is not served over the agent channel (allowed: ${WORKSPACE_AGENT_TOOLS.join(', ')}).`
      );
    }
    if (!this.enabled && name !== 'tools_manifest') {
      return errorResult(
        'agent_disabled',
        'The user switched the agent channel off in the Pix3 editor (status bar → Agent). Ask ' +
          'them to switch it back on.'
      );
    }
    const input = isRecord(frame.input) ? frame.input : {};
    this.active.set(frame.id, name);
    this.lastCallAt = Date.now();
    this.notify();
    try {
      switch (name) {
        case 'tools_manifest':
          return await this.toolsManifest();
        case 'sync_barrier':
          return await this.syncBarrier();
        case 'sync_release':
          return this.syncRelease(input);
        case 'project_status':
          return await this.projectStatus();
        default:
          break;
      }
      if (GENERATE_TOOLS.has(name)) {
        const allowed = await this.requestGeneration(name, frame.agent?.name ?? null, context.root);
        if (allowed !== true) return allowed;
      }
      return await this.execute(name, input);
    } finally {
      this.active.delete(frame.id);
      this.notify();
    }
  }

  private async execute(
    name: string,
    input: Record<string, unknown>
  ): Promise<WorkspaceCallResult> {
    const host = this.host();
    let tool = name;
    let args = input;
    if (name === 'play_restart' && !host.isPlaying()) {
      // The barrier stopped play; a restart of a stopped game is a start.
      tool = 'play_start';
      args = {};
    }
    if (name === 'game_run' && !host.isPlaying()) {
      // Through the channel `game_run` means "run the verified files": start them first.
      const started = toCallResult(await host.executeTool('play_start', {}));
      if (started.isError) return started;
      if (!(await host.waitForRuntime(RUNTIME_ATTACH_TIMEOUT_MS))) {
        return errorResult(
          'load_failed',
          'Play mode started but the game runtime did not attach.',
          {
            errors: [{ file: null, message: 'runtime not attached', kind: 'load' }],
          }
        );
      }
    }
    const result = toCallResult(await host.executeTool(tool, args));
    if (START_TOOLS.has(name) && !result.isError && this.lastBarrierLoaded) {
      appState.project.coauthoring.playRevision = { ...this.lastBarrierLoaded };
    }
    if (OBSERVING_TOOLS.has(name)) {
      const coauthoring = appState.project.coauthoring;
      return {
        ...result,
        _meta: {
          pix3: {
            playRevision: host.isPlaying() ? coauthoring.playRevision : null,
            stale: host.isPlaying() && coauthoring.stale,
          },
        },
      };
    }
    return result;
  }

  // --- internal tools ---------------------------------------------------------------------------

  private async toolsManifest(): Promise<WorkspaceCallResult> {
    const specs = await this.host().toolSpecs(new Set(WORKSPACE_AGENT_TOOLS));
    const tools: AgentToolSpec[] = [
      {
        name: 'project_status',
        description:
          'What the Pix3 editor has open for this project: open scenes, play state and the ' +
          'revision it plays, autosave, external versions not applied yet, unreadable files, merge ' +
          'conflicts and the latest merge-log entries.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      ...specs.filter(spec => spec.name !== 'project_status'),
    ];
    return text(JSON.stringify({ tools }));
  }

  /** Barrier step 2 on the editor side (see the class comment). */
  private async syncBarrier(): Promise<WorkspaceCallResult> {
    const host = this.host();
    const holdId = `hold-${this.nextHoldId++}`;
    const release = host.holdAutosave('The agent is running the game from the files on disk.');
    const timer = setTimeout(() => this.releaseHold(holdId), HOLD_SAFETY_MS);
    this.holds.set(holdId, { release, timer });
    try {
      if (host.isPlaying()) await host.stopPlay();
      const loaded = await host.syncLoaded();
      const errors: SyncBarrierError[] = [];
      const buildError = await host.buildError();
      if (buildError) errors.push({ ...buildError, kind: 'compile' });
      const coauthoring = appState.project.coauthoring;
      for (const merge of Object.values(coauthoring.merges)) {
        if (merge?.status === 'rejected') {
          errors.push({
            file: merge.path,
            message: merge.reason ?? 'The editor could not merge this version.',
            kind: 'load',
          });
        }
      }
      for (const path of coauthoring.unreadablePaths) {
        errors.push({
          file: toProjectPath(path),
          message: 'Not readable as a valid file; the editor keeps its last good version.',
          kind: 'pending',
        });
      }
      this.lastBarrierLoaded = loaded;
      return text(JSON.stringify({ loaded, errors, holdId }));
    } catch (error) {
      this.releaseHold(holdId);
      throw error;
    }
  }

  private syncRelease(input: Record<string, unknown>): WorkspaceCallResult {
    const holdId = typeof input.holdId === 'string' ? input.holdId : '';
    return text(JSON.stringify({ released: this.releaseHold(holdId) }));
  }

  private releaseHold(holdId: string): boolean {
    const hold = this.holds.get(holdId);
    if (!hold) return false;
    this.holds.delete(holdId);
    clearTimeout(hold.timer);
    hold.release();
    return true;
  }

  private async projectStatus(): Promise<WorkspaceCallResult> {
    const host = this.host();
    const project = appState.project;
    const coauthoring = project.coauthoring;
    const scenes = Object.values(appState.scenes.descriptors)
      .filter(descriptor => descriptor?.filePath?.startsWith('res://'))
      .map(descriptor => ({
        path: toProjectPath(descriptor.filePath),
        dirty: descriptor.isDirty === true,
        active: descriptor.id === appState.scenes.activeSceneId,
      }));
    let mergeLog: unknown[] = [];
    try {
      mergeLog = await host.mergeLogTail(MERGE_LOG_TAIL);
    } catch {
      mergeLog = [];
    }
    return text(
      JSON.stringify({
        project: {
          name: project.projectName,
          backend: project.backend,
          root: project.workspace.root,
          lease: project.workspace.lease,
        },
        scenes,
        isPlaying: host.isPlaying(),
        playRevision: host.isPlaying() ? coauthoring.playRevision : null,
        stale: coauthoring.stale,
        autosave: { status: coauthoring.autosaveStatus, reason: coauthoring.autosaveReason },
        scripts: { status: project.scriptsStatus, error: await host.buildError() },
        pendingExternal: coauthoring.pendingExternalPaths,
        unreadable: coauthoring.unreadablePaths,
        merges: Object.values(coauthoring.merges).map(merge => ({
          path: merge.path,
          status: merge.status,
          conflicts: merge.conflicts.length,
          reason: merge.reason,
        })),
        mergeLog,
        agentChannel: {
          generatePermission: this.permission,
          generationsUsed: this.generationsUsed,
          generationLimit: GENERATE_SESSION_LIMIT,
        },
      })
    );
  }

  // --- generation permission --------------------------------------------------------------------

  private async requestGeneration(
    tool: string,
    agentName: string | null,
    root: string | null
  ): Promise<true | WorkspaceCallResult> {
    if (this.permission === 'denied') {
      return errorResult(
        'permission_denied',
        'The user denied asset generation for this agent session in the Pix3 editor.'
      );
    }
    if (this.permission === 'allowed' && this.generationsUsed >= GENERATE_SESSION_LIMIT) {
      // The allowance is used up: ask again.
      this.permission = 'unset';
      this.generationsUsed = 0;
    }
    if (this.permission !== 'allowed') {
      const decision = await this.askHuman(tool, agentName, root);
      if (decision === 'timeout') {
        return errorResult(
          'permission_denied',
          `Nobody answered the generation prompt in the Pix3 editor within ${PERMISSION_TIMEOUT_MS / 1000} s.`
        );
      }
      if (decision === 'deny') {
        this.permission = 'denied';
        this.notify();
        return errorResult(
          'permission_denied',
          'The user denied asset generation for this agent session in the Pix3 editor.'
        );
      }
      this.permission = 'allowed';
      this.generationsUsed = 0;
    }
    this.generationsUsed += 1;
    this.notify();
    return true;
  }

  private askHuman(
    tool: string,
    agentName: string | null,
    root: string | null
  ): Promise<PermissionDecision | 'timeout'> {
    return new Promise(resolve => {
      this.promptWaiters.push(resolve);
      if (this.prompt) return; // one prompt answers every generation waiting on it
      this.prompt = { id: this.nextPromptId++, agentName, root, tool };
      this.promptTimer = setTimeout(() => this.resolvePrompt('timeout'), PERMISSION_TIMEOUT_MS);
      this.notify();
    });
  }

  private resolvePrompt(decision: PermissionDecision | 'timeout'): void {
    if (this.promptTimer !== null) {
      clearTimeout(this.promptTimer);
      this.promptTimer = null;
    }
    const waiters = this.promptWaiters;
    this.promptWaiters = [];
    const hadPrompt = this.prompt !== null;
    this.prompt = null;
    for (const resolve of waiters) resolve(decision);
    if (hadPrompt) this.notify();
  }

  /** A new server session / lease / MCP process = a new connection: its permission starts over. */
  private noteConnection(frame: WorkspaceCallFrame, context: WorkspaceCallContext): void {
    if (context.serverSession !== this.stateSession) {
      // A restarted `pix3 serve` is a new session: the pill starts over, and so does a
      // "disconnected" the human chose for the previous one.
      if (this.stateSession !== null) this.enabled = true;
      this.stateSession = context.serverSession;
      this.seen = false;
    }
    this.seen = true;
    if (frame.agent) this.agentName = frame.agent.name;
    const key = `${context.serverSession ?? ''}|${context.leaseId ?? ''}|${frame.agent?.session ?? ''}`;
    if (key !== this.permissionKey) {
      this.permissionKey = key;
      this.resolvePrompt('deny');
      this.permission = 'unset';
      this.generationsUsed = 0;
    }
  }

  private onLeaseGone(): void {
    if (this.permissionKey === null && this.prompt === null) return;
    this.permissionKey = null;
    this.resolvePrompt('deny');
    this.permission = 'unset';
    this.generationsUsed = 0;
    for (const holdId of Array.from(this.holds.keys())) this.releaseHold(holdId);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('[WorkspaceAgentToolBridge] Listener error', error);
      }
    }
  }

  // --- the real host ----------------------------------------------------------------------------

  private host(): WorkspaceAgentHost {
    return this.hostOverride ?? this.editorHost;
  }

  private readonly editorHost: WorkspaceAgentHost = {
    executeTool: async (name, args) => (await this.registry()).execute(name, args),
    toolSpecs: async names => (await this.registry()).specs(names),
    isPlaying: () => appState.ui.isPlaying,
    stopPlay: async () => {
      await this.dispatcher.executeById('game.stop');
      const deadline = Date.now() + PLAY_STOP_TIMEOUT_MS;
      while (appState.ui.isPlaying && Date.now() < deadline) await sleep(50);
    },
    waitForRuntime: async timeoutMs => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (this.playSession.getActiveRuntime()) return true;
        await sleep(50);
      }
      return this.playSession.getActiveRuntime() !== null;
    },
    holdAutosave: reason => this.autosave.hold(reason),
    syncLoaded: async () => {
      const scenes = await this.projectSync.syncNow();
      const scripts = await this.projectSync.builtScriptHashes();
      return { ...scripts, ...scenes };
    },
    buildError: async () => {
      if (appState.project.scriptsStatus !== 'error') return null;
      return (await this.scriptLoader()).getLastBuildError();
    },
    mergeLogTail: async limit => (await this.mergeLog.read()).slice(-limit),
  };
}
