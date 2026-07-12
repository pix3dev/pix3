import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { guessMimeType } from '@/core/remote-preview/protocol';
import {
  componentToDTO,
  errors as capturedErrors,
  installErrorCapture,
  nodeToDTO,
  type NodeDTO,
  type NodeSummary,
} from '@/core/agent-introspection';
import { ProjectStorageService } from '@/services/ProjectStorageService';
import { ScriptCompilerService, type CompilationError } from '@/services/ScriptCompilerService';
import { CommandRegistry } from '@/services/CommandRegistry';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { LoggingService } from '@/services/LoggingService';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import { SceneManager, NodeBase } from '@pix3/runtime';

/** JSON Schema for a tool's input. */
export type JsonSchema = Record<string, unknown>;

/** A tool the agent may call. `handler` returns JSON-safe data (never a live object). */
export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** The LLM-facing subset of a tool definition (no handler). */
export interface AgentToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

// Script collection mirrors PreviewHostService.collectScriptFiles.
const SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;
const EXCLUDED_SCRIPT_SUFFIXES = ['.spec.ts', '.test.ts', '.d.ts'] as const;
const SCRIPT_ENTRY_PATTERN = /extends\s+Script\b/;

// `run_command` allow-list (plan §5): only command namespaces that mutate the scene / editor state
// without opening a dialog or picker. Everything else (project.open, editor.open-settings, …) is
// refused with an explanation in the tool result.
const RUN_COMMAND_ALLOWED_PREFIXES = [
  'scene.',
  'properties.',
  'selection.',
  'alignment.',
  'history.',
  'viewport.',
  'game.',
] as const;

// File extensions treated as text for `fs_read`. Binary files return metadata instead of content.
const TEXT_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'pix3scene',
  'pix3anim',
  'yaml',
  'yml',
  'md',
  'txt',
  'css',
  'html',
  'htm',
  'svg',
  'xml',
  'glsl',
  'vert',
  'frag',
  'csv',
  'ini',
  'cfg',
  'toml',
]);

const MAX_LOG_ENTRIES = 200;

/**
 * Registry of tools the in-editor AI agent can call. Each tool is a
 * `{ name, description, inputSchema (JSON Schema), handler }` and every handler returns JSON-safe
 * data. Scene reads reuse `agent-introspection`; mutations flow through the command gateway
 * (`CommandDispatcher`) so they land in undo/redo; file writes go through `ProjectStorageService`,
 * whose write/delete methods already bump `appState.project.fileRefreshSignal` (surfacing agent
 * edits to open code tabs and the asset browser) — so tools never poke `appState` directly.
 *
 * Two planned tools (`viewport_screenshot`, `generate_asset`) are intentionally deferred — see the
 * TODO in {@link AgentToolRegistry.buildTools}.
 */
@injectable()
export class AgentToolRegistry {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ScriptCompilerService)
  private readonly compiler!: ScriptCompilerService;

  @inject(CommandRegistry)
  private readonly commands!: CommandRegistry;

  @inject(CommandDispatcher)
  private readonly dispatcher!: CommandDispatcher;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  private tools: AgentToolDefinition[] | null = null;

  constructor() {
    // Cheap ring-buffer error capture, installed in production too so `read_errors` has data.
    installErrorCapture();
  }

  /** All registered tools (definitions with handlers). */
  list(): AgentToolDefinition[] {
    return this.ensureTools();
  }

  /** LLM-facing tool specs (name/description/inputSchema — no handler). */
  specs(): AgentToolSpec[] {
    return this.ensureTools().map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  /** Execute a tool by name. Throws for an unknown tool; handlers own their own error semantics. */
  async execute(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.ensureTools().find(t => t.name === name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.handler(args);
  }

  // -- tool table ------------------------------------------------------------

  private ensureTools(): AgentToolDefinition[] {
    if (!this.tools) {
      this.tools = this.buildTools();
    }
    return this.tools;
  }

  private buildTools(): AgentToolDefinition[] {
    return [
      {
        name: 'scene_tree',
        description: 'Return the active scene as a node tree, expanded up to maxDepth levels.',
        inputSchema: {
          type: 'object',
          properties: {
            maxDepth: { type: 'integer', description: 'Tree depth to expand (default 3).' },
          },
          additionalProperties: false,
        },
        handler: args => this.sceneTree(asInt(args.maxDepth, 3)),
      },
      {
        name: 'node_inspect',
        description: 'Full detail of one node: transform, properties, and script components.',
        inputSchema: {
          type: 'object',
          properties: { nodeId: { type: 'string' } },
          required: ['nodeId'],
          additionalProperties: false,
        },
        handler: args => this.nodeInspect(asString(args.nodeId)),
      },
      {
        name: 'find_nodes',
        description: 'Case-insensitive search across node name and type.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        handler: args => this.findNodes(asString(args.text)),
      },
      {
        name: 'get_selection',
        description: 'Current selection: node ids, primary node id, hovered node id.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.getSelection(),
      },
      {
        name: 'set_property',
        description:
          'Set a property on a node (undoable). While playing, hot-reloads onto the running scene.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            propertyPath: { type: 'string' },
            value: {},
          },
          required: ['nodeId', 'propertyPath'],
          additionalProperties: false,
        },
        handler: args =>
          this.setProperty(asString(args.nodeId), asString(args.propertyPath), args.value),
      },
      {
        name: 'list_commands',
        description:
          'List registered editor commands (id, title, menuPath) and whether the agent may run each.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.listCommands(),
      },
      {
        name: 'run_command',
        description:
          'Run a registered command by id. Only scene/properties/selection/alignment/history/viewport/game.* commands are permitted (no dialogs/pickers).',
        inputSchema: {
          type: 'object',
          properties: { commandId: { type: 'string' } },
          required: ['commandId'],
          additionalProperties: false,
        },
        handler: args => this.runCommand(asString(args.commandId)),
      },
      {
        name: 'fs_list',
        description: 'List a project directory (relative to the project root).',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Directory path (default ".").' } },
          additionalProperties: false,
        },
        handler: args => this.fsList(args.path === undefined ? '.' : asString(args.path)),
      },
      {
        name: 'fs_read',
        description:
          'Read a project file. Text files return their content; binary files return metadata (size, mimeType) only.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        handler: args => this.fsRead(asString(args.path)),
      },
      {
        name: 'fs_write',
        description: 'Write (create or overwrite) a project text file. Creates parent directories.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        handler: args => this.fsWrite(asString(args.path), asString(args.content)),
      },
      {
        name: 'fs_delete',
        description: 'Delete a project file or directory.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        handler: args => this.fsDelete(asString(args.path)),
      },
      {
        name: 'compile_scripts',
        description:
          'Compile the project user scripts (esbuild). Returns compilation diagnostics as the result — a syntax check for agent edits before play.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.compileScripts(),
      },
      {
        name: 'play_start',
        description: 'Enter play mode (start the game).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.playCommand('game.start'),
      },
      {
        name: 'play_stop',
        description: 'Exit play mode (stop the game).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.playCommand('game.stop'),
      },
      {
        name: 'play_restart',
        description: 'Restart play mode.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.playCommand('game.restart'),
      },
      {
        name: 'play_status',
        description: 'Whether the scene is playing and the current play-mode status.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.playStatus(),
      },
      {
        name: 'read_logs',
        description: 'Recent editor log entries. Optionally only those after a timestamp (ms).',
        inputSchema: {
          type: 'object',
          properties: { since: { type: 'number', description: 'Epoch ms; return newer entries.' } },
          additionalProperties: false,
        },
        handler: args => this.readLogs(typeof args.since === 'number' ? args.since : undefined),
      },
      {
        name: 'read_errors',
        description: 'Recent captured runtime errors (console.error / window errors / rejections).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.readErrors(),
      },
      // TODO(phase C/D): `viewport_screenshot` and `generate_asset` are deferred pending a decision
      // on the capture point (viewport canvas vs. same-origin game iframe) and on gating image
      // generation behind a configured image key. See plan §2.B.
    ];
  }

  // -- introspection ---------------------------------------------------------

  private sceneTree(maxDepth: number): (NodeDTO & { sceneVersion: string }) | null {
    const graph = this.sceneManager.getActiveSceneGraph();
    if (!graph) return null;
    const roots = graph.rootNodes.filter((n): n is NodeBase => n instanceof NodeBase);
    const tree: NodeDTO = {
      nodeId: '<scene-root>',
      type: 'SceneRoot',
      name: graph.description ?? 'Scene',
      visible: true,
      transform: { position: null, rotation: null, scale: null },
      groups: [],
      componentCount: 0,
      properties: null,
      children: roots.map(root => nodeToDTO(root, maxDepth - 1)),
    };
    return { ...tree, sceneVersion: graph.version };
  }

  private nodeInspect(nodeId: string): NodeDTO | null {
    const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    if (!(node instanceof NodeBase)) return null;
    const dto = nodeToDTO(node, 0);
    dto.components = node.components.map((c, i) => componentToDTO(c, i));
    return dto;
  }

  private findNodes(text: string): NodeSummary[] {
    const graph = this.sceneManager.getActiveSceneGraph();
    if (!graph) return [];
    const needle = text.toLowerCase();
    const matches: NodeSummary[] = [];
    for (const node of graph.nodeMap.values()) {
      if (node.name.toLowerCase().includes(needle) || node.type.toLowerCase().includes(needle)) {
        matches.push({ nodeId: node.nodeId, type: node.type, name: node.name });
      }
    }
    return matches;
  }

  private getSelection(): {
    nodeIds: string[];
    primaryNodeId: string | null;
    hoveredNodeId: string | null;
  } {
    return {
      nodeIds: [...appState.selection.nodeIds],
      primaryNodeId: appState.selection.primaryNodeId,
      hoveredNodeId: appState.selection.hoveredNodeId,
    };
  }

  // -- mutation --------------------------------------------------------------

  private async setProperty(
    nodeId: string,
    propertyPath: string,
    value: unknown
  ): Promise<{ ok: boolean }> {
    const ok = await this.dispatcher.execute(
      new UpdateObjectPropertyCommand({ nodeId, propertyPath, value })
    );
    return { ok };
  }

  private listCommands(): Array<{
    id: string;
    title: string;
    menuPath: string | null;
    allowed: boolean;
  }> {
    return this.commands.getAllCommands().map(command => ({
      id: command.metadata.id,
      title: command.metadata.title,
      menuPath: command.metadata.menuPath ?? null,
      allowed: isCommandAllowed(command.metadata.id),
    }));
  }

  private async runCommand(commandId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.commands.getCommand(commandId)) {
      return { ok: false, error: `Unknown command: ${commandId}` };
    }
    if (!isCommandAllowed(commandId)) {
      return {
        ok: false,
        error: `Command "${commandId}" is not permitted from the agent (only scene/properties/selection/alignment/history/viewport/game.* commands, and no dialogs/pickers).`,
      };
    }
    const ok = await this.dispatcher.executeById(commandId);
    return { ok };
  }

  // -- filesystem ------------------------------------------------------------

  private async fsList(
    path: string
  ): Promise<Array<{ name: string; kind: string; path: string; size: number | null }>> {
    const safe = this.safePath(path, true);
    const entries = await this.storage.listDirectory(safe);
    return entries.map(entry => ({
      name: entry.name,
      kind: entry.kind,
      path: entry.path,
      size: entry.size ?? null,
    }));
  }

  private async fsRead(
    path: string
  ): Promise<
    | { path: string; content: string }
    | { path: string; binary: true; mimeType: string; size: number }
  > {
    const safe = this.safePath(path);
    if (isTextPath(safe)) {
      const content = await this.storage.readTextFile(safe);
      return { path: safe, content };
    }
    const blob = await this.storage.readBlob(safe);
    return {
      path: safe,
      binary: true,
      mimeType: blob.type || guessMimeType(safe),
      size: blob.size,
    };
  }

  private async fsWrite(path: string, content: string): Promise<{ ok: true; path: string }> {
    const safe = this.safePath(path);
    // ProjectStorageService.writeTextFile bumps appState.project.fileRefreshSignal internally, so
    // open code tabs / the asset browser pick the change up — no direct appState mutation here.
    await this.storage.writeTextFile(safe, content);
    return { ok: true, path: safe };
  }

  private async fsDelete(path: string): Promise<{ ok: true; path: string }> {
    const safe = this.safePath(path);
    // deleteEntry likewise bumps fileRefreshSignal internally.
    await this.storage.deleteEntry(safe);
    return { ok: true, path: safe };
  }

  /** Reject `..` traversal (mirrors PreviewHostService.handleFileRequest). Allows "." for dir list. */
  private safePath(input: string, allowRoot = false): string {
    const normalized = String(input ?? '')
      .replace(/^res:\/\//i, '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!normalized || normalized === '.') {
      if (allowRoot) return '.';
      throw new Error(`Invalid path: ${input}`);
    }
    if (normalized.split('/').includes('..')) {
      throw new Error(`Invalid path (".." is not allowed): ${input}`);
    }
    return normalized;
  }

  // -- compile ---------------------------------------------------------------

  private async compileScripts(): Promise<Record<string, unknown>> {
    const files = await this.collectScriptFiles();
    if (files.size === 0) {
      return {
        ok: true,
        fileCount: 0,
        message: 'No script files found under scripts/ or src/scripts/.',
      };
    }
    const entryFiles = Array.from(files.entries())
      .filter(([, content]) => SCRIPT_ENTRY_PATTERN.test(content))
      .map(([path]) => path);
    if (entryFiles.length === 0) {
      return { ok: true, fileCount: files.size, message: 'No Script subclasses found to compile.' };
    }

    try {
      const result = await this.compiler.bundle(files, entryFiles, async filePath => {
        try {
          return await this.storage.readTextFile(filePath);
        } catch {
          return null;
        }
      });
      return {
        ok: true,
        fileCount: files.size,
        bytes: result.code.length,
        warnings: result.warnings,
      };
    } catch (error) {
      const compileError = error as CompilationError;
      return {
        ok: false,
        error: typeof compileError?.message === 'string' ? compileError.message : String(error),
        file: compileError?.file,
        line: compileError?.line,
        column: compileError?.column,
      };
    }
  }

  private async collectScriptFiles(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const directory of SCRIPT_DIRECTORIES) {
      for (const path of await this.collectScriptPaths(directory)) {
        try {
          files.set(path, await this.storage.readTextFile(path));
        } catch {
          // Files disappearing mid-scan are fine.
        }
      }
    }
    return files;
  }

  private async collectScriptPaths(directory: string): Promise<string[]> {
    let entries: ReadonlyArray<{ name: string; kind: FileSystemHandleKind; path: string }>;
    try {
      entries = await this.storage.listDirectory(directory);
    } catch {
      return [];
    }
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        result.push(...(await this.collectScriptPaths(entry.path)));
        continue;
      }
      const lower = entry.path.toLowerCase();
      if (!lower.endsWith('.ts') && !lower.endsWith('.js')) continue;
      if (EXCLUDED_SCRIPT_SUFFIXES.some(suffix => lower.endsWith(suffix))) continue;
      result.push(entry.path);
    }
    return result;
  }

  // -- play mode / logs / errors --------------------------------------------

  private async playCommand(commandId: string): Promise<{ ok: boolean }> {
    return { ok: await this.dispatcher.executeById(commandId) };
  }

  private playStatus(): { isPlaying: boolean; playModeStatus: string } {
    return { isPlaying: appState.ui.isPlaying, playModeStatus: appState.ui.playModeStatus };
  }

  private readLogs(
    since?: number
  ): Array<{ level: string; message: string; timestamp: number; source?: string }> {
    let logs = this.logger.getLogs();
    if (typeof since === 'number') {
      logs = logs.filter(entry => entry.timestamp > since);
    }
    return logs.slice(-MAX_LOG_ENTRIES).map(entry => ({
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp,
      ...(entry.source ? { source: entry.source } : {}),
    }));
  }

  private readErrors(): ReturnType<typeof capturedErrors> {
    return capturedErrors();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const isCommandAllowed = (commandId: string): boolean =>
  RUN_COMMAND_ALLOWED_PREFIXES.some(prefix => commandId.startsWith(prefix));

const isTextPath = (path: string): boolean => {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return TEXT_EXTENSIONS.has(ext);
};

const asString = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new Error(`Expected a string argument, got ${typeof value}.`);
  }
  return value;
};

const asInt = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
