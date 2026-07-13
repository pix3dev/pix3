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
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { AssetGenService, type AssetPostProcessPreset } from '@/services/AssetGenService';
import { AgentVisionService } from '@/services/agent/AgentVisionService';
import { AgentSkillsService } from '@/services/agent/AgentSkillsService';
import { ProjectDiagnosticsService } from '@/services/ProjectDiagnosticsService';
import type { LlmImageBlock } from '@/services/llm/LlmTypes';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import { AddComponentCommand } from '@/features/scripts/AddComponentCommand';
import { RemoveComponentCommand } from '@/features/scripts/RemoveComponentCommand';
import { UpdateComponentPropertyCommand } from '@/features/scripts/UpdateComponentPropertyCommand';
import { SceneManager, NodeBase, ScriptRegistry } from '@pix3/runtime';

/** JSON Schema for a tool's input. */
export type JsonSchema = Record<string, unknown>;

/** An image a tool wants shown to the model (base64 WITHOUT the `data:` prefix). */
export interface AgentToolImage {
  readonly mimeType: string;
  readonly data: string;
}

/**
 * Reserved key in a tool handler's return value: images listed here are lifted out of the JSON
 * tool-result by the chat loop and attached to the conversation as real image blocks (all three
 * providers are multimodal), so the model *sees* screenshots/previews instead of reading base64.
 */
export const AGENT_TOOL_IMAGES_KEY = '__images';

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
 * Tools that produce pixels (`viewport_screenshot`, `generate_asset`) return their images under
 * {@link AGENT_TOOL_IMAGES_KEY}; the chat loop turns those into real image blocks for the model.
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

  @inject(ViewportRendererService)
  private readonly viewportRenderer!: ViewportRendererService;

  @inject(AssetGenService)
  private readonly assetGen!: AssetGenService;

  @inject(AgentVisionService)
  private readonly vision!: AgentVisionService;

  @inject(AgentSkillsService)
  private readonly skills!: AgentSkillsService;

  @inject(ProjectDiagnosticsService)
  private readonly diagnostics!: ProjectDiagnosticsService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(ScriptRegistry)
  private readonly scriptRegistry!: ScriptRegistry;

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
        name: 'read_skill',
        description:
          'Read a bundled skill: a short step-by-step guide for a class of task (see the skill index in the system prompt). Call this BEFORE starting a matching task — e.g. read "game-prototype" before building from a GDD, "asset-generation" before making art, "verify-and-fix" before/while debugging a run. Optionally pass a section heading to read just that part.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              enum: this.skills.list().map(skill => skill.id),
              description: 'The skill id to read.',
            },
            section: {
              type: 'string',
              description: 'Optional: a "## Section" heading to read just that part of the skill.',
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
        handler: args => this.readSkill(args),
      },
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
        name: 'list_component_types',
        description:
          'List every script/behaviour component type that can be attached to a node: built-ins ("core:*", e.g. core:Rotate) and this project\'s user scripts ("user:*"). Each entry includes its configurable properties (name + type). Call this before add_component so you use a real type id and valid config keys.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.listComponentTypes(),
      },
      {
        name: 'add_component',
        description:
          'Attach a script/behaviour component to a node (undoable). Use a componentType from list_component_types. `config` sets initial property values (must match that type\'s property names). Returns the created componentId — pass it to set_component_property / remove_component. For a user script, write & compile_scripts the file first, then attach with its "user:<ExportName>" type.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            componentType: {
              type: 'string',
              description: 'A type id from list_component_types (e.g. "core:Rotate" or "user:Foo").',
            },
            config: {
              type: 'object',
              description: 'Optional initial property values keyed by property name.',
              additionalProperties: true,
            },
            enabled: { type: 'boolean', description: 'Initial enabled state (default true).' },
          },
          required: ['nodeId', 'componentType'],
          additionalProperties: false,
        },
        handler: args => this.addComponent(args),
      },
      {
        name: 'set_component_property',
        description:
          'Set one property on a component already attached to a node (undoable). Identify the component by the componentId from node_inspect or add_component.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            componentId: { type: 'string' },
            propertyName: { type: 'string' },
            value: {},
          },
          required: ['nodeId', 'componentId', 'propertyName'],
          additionalProperties: false,
        },
        handler: args =>
          this.setComponentProperty(
            asString(args.nodeId),
            asString(args.componentId),
            asString(args.propertyName),
            args.value
          ),
      },
      {
        name: 'remove_component',
        description:
          'Detach a component from a node (undoable). Identify it by the componentId from node_inspect.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            componentId: { type: 'string' },
          },
          required: ['nodeId', 'componentId'],
          additionalProperties: false,
        },
        handler: args =>
          this.removeComponent(asString(args.nodeId), asString(args.componentId)),
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
        name: 'check_scripts',
        description:
          'Type-check ALL project scripts and return semantic + syntax problems with { file, line, column, message, category, code }. Catches TypeScript type errors that compile_scripts (esbuild, transpile-only) misses — e.g. assigning to the read-only `position`/`rotation`/`scale`, wrong argument types, misspelled imports. Use this to find why a script misbehaves and to verify your own edits.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => this.checkScripts(),
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
      {
        name: 'viewport_screenshot',
        description:
          'Capture the editor viewport as an image the model can see (edit-mode scene view; the running game canvas is not captured). Use it to visually check layout, colors, and placement.',
        inputSchema: {
          type: 'object',
          properties: {
            maxSize: {
              type: 'integer',
              description: 'Longest-edge cap in px (default 1024).',
            },
          },
          additionalProperties: false,
        },
        handler: args => this.viewportScreenshot(asInt(args.maxSize, 1024)),
      },
      {
        name: 'analyze_image',
        description:
          'Ask a vision-capable helper model to look at an image and answer a question — use this when YOUR model cannot see images (no vision). source is a project image path (res:// or relative), "viewport" (a fresh editor screenshot), or a generated-image handle id. Ideal for extracting style tokens from a design reference before generating art, or QC-ing a generated sprite / the scene layout.',
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'A project image path, "viewport", or a generation handle id.',
            },
            question: {
              type: 'string',
              description:
                'What to ask about the image (e.g. "list the style tokens for an image prompt"). Defaults to a general description.',
            },
          },
          required: ['source'],
          additionalProperties: false,
        },
        handler: args => this.analyzeImage(args),
      },
      {
        name: 'generate_asset',
        description:
          "Generate an image with the project's AI image provider (uses the user's saved image key), post-process it to be game-ready (background removal, trim to content, downscale), and save it into the project. For sprites/icons set transparent:true and describe a SINGLE centered subject on a plain background. Pass design reference image paths so the style matches. Returns the saved path, original vs saved size, and a small preview you can see.",
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            name: {
              type: 'string',
              description:
                'Target file name or relative path (e.g. "src/assets/textures/car.png"); the extension is added automatically when missing.',
            },
            transparent: {
              type: 'boolean',
              description:
                'Request a transparent background from the image provider (recommended for sprites/icons).',
            },
            postProcess: {
              type: 'string',
              enum: ['sprite', 'icon', 'texture', 'none'],
              description:
                'Post-processing preset before saving. sprite = remove background + trim to content + downscale. icon = sprite + pad to a centered square (aligns icon grids). texture = downscale only, keep the background (tiles, photos, backgrounds). none = save the raw generation untouched. Default: transparent→sprite, otherwise→texture.',
            },
            maxSize: {
              type: 'integer',
              description:
                'Longest-edge downscale applied on save (px); omit to use the project default.',
            },
            references: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Project image paths used as style references — pass the design reference(s) so generated art matches the game.',
            },
          },
          required: ['prompt', 'name'],
          additionalProperties: false,
        },
        handler: args => this.generateAsset(args),
      },
      {
        name: 'process_asset',
        description:
          'Post-process an EXISTING project image: background removal, trim to content, downscale, re-encode. Use it to fix an image that has an unwanted background, is too large, or is not cropped tight (e.g. a previously generated sprite or a user import). Presets match generate_asset: sprite / icon / texture / none. Writes back to `path` unless `name` is given. Returns the saved path and a preview.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Project image to read (res:// or project-relative).',
            },
            preset: {
              type: 'string',
              enum: ['sprite', 'icon', 'texture', 'none'],
              description:
                'Processing preset (see generate_asset). Defaults to sprite (remove background + trim + downscale).',
            },
            name: {
              type: 'string',
              description: 'Optional output path; defaults to overwriting `path`.',
            },
            maxSize: {
              type: 'integer',
              description: 'Longest-edge cap in px; omit to use the project default.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
        handler: args => this.processAsset(args),
      },
    ];
  }

  // -- skills ----------------------------------------------------------------

  private readSkill(args: Record<string, unknown>): Record<string, unknown> {
    const id = asString(args.id);
    const section = typeof args.section === 'string' ? args.section : undefined;
    const content = this.skills.read(id, section);
    if (content === null) {
      const available = this.skills
        .list()
        .map(skill => skill.id)
        .join(', ');
      return {
        ok: false,
        error: section
          ? `No section matching "${section}" in skill "${id}" (or unknown skill). Skills: ${available}.`
          : `Unknown skill "${id}". Available: ${available}.`,
      };
    }
    return { ok: true, id, section: section ?? null, content };
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

  private nodeInspect(nodeId: string): (NodeDTO & { components?: unknown[] }) | null {
    const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    if (!(node instanceof NodeBase)) return null;
    const dto = nodeToDTO(node, 0);
    // Enrich each component with the explicit ids the mutation tools need (componentId + type),
    // which the generic ComponentDTO only exposes ambiguously as `scriptId`.
    dto.components = node.components.map((c, i) => ({
      ...componentToDTO(c, i),
      componentId: c.id,
      componentType: c.type,
      enabled: c.enabled,
    }));
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

  private listComponentTypes(): Array<{
    id: string;
    displayName: string;
    category: string;
    description: string;
    properties: Array<{ name: string; type: string; label?: string }>;
  }> {
    return this.scriptRegistry.getAllComponentTypes().map(info => {
      let properties: Array<{ name: string; type: string; label?: string }> = [];
      try {
        const schema = this.scriptRegistry.getComponentPropertySchema(info.id);
        properties = (schema?.properties ?? []).map(prop => ({
          name: prop.name,
          type: String(prop.type),
          ...(prop.ui?.label ? { label: prop.ui.label } : {}),
        }));
      } catch {
        // Schema resolution is best-effort — a type with a broken schema still lists.
      }
      return {
        id: info.id,
        displayName: info.displayName,
        category: info.category,
        description: info.description,
        properties,
      };
    });
  }

  private async addComponent(
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; componentId?: string; error?: string }> {
    const nodeId = asString(args.nodeId);
    const componentType = asString(args.componentType);
    if (!this.scriptRegistry.getComponentType(componentType)) {
      const available = this.scriptRegistry
        .getAllComponentTypes()
        .map(type => type.id)
        .join(', ');
      return {
        ok: false,
        error: `Unknown component type "${componentType}". Call list_component_types first. Available: ${available || '(none registered)'}`,
      };
    }
    const config =
      args.config && typeof args.config === 'object' && !Array.isArray(args.config)
        ? (args.config as Record<string, unknown>)
        : undefined;
    const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined;
    // Generate the id here (rather than letting the operation default it) so it can be returned.
    const componentId = `${nodeId}-${componentType}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const ok = await this.dispatcher.execute(
      new AddComponentCommand({ nodeId, componentType, componentId, config, enabled })
    );
    return ok
      ? { ok: true, componentId }
      : {
          ok: false,
          error:
            'Failed to attach the component (node not found, the type failed to instantiate, or the node is a prefab instance — components are locked there).',
        };
  }

  private async setComponentProperty(
    nodeId: string,
    componentId: string,
    propertyName: string,
    value: unknown
  ): Promise<{ ok: boolean; error?: string }> {
    const ok = await this.dispatcher.execute(
      new UpdateComponentPropertyCommand({ nodeId, componentId, propertyName, value })
    );
    return ok
      ? { ok: true }
      : {
          ok: false,
          error:
            'Property was not updated — the component/property was not found, the value is invalid or unchanged, or the node is a prefab instance. Re-check node_inspect and list_component_types.',
        };
  }

  private async removeComponent(
    nodeId: string,
    componentId: string
  ): Promise<{ ok: boolean; error?: string }> {
    const ok = await this.dispatcher.execute(new RemoveComponentCommand({ nodeId, componentId }));
    return ok
      ? { ok: true }
      : {
          ok: false,
          error:
            'Failed to remove the component (node/component not found, or the node is a prefab instance).',
        };
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

  private async checkScripts(): Promise<Record<string, unknown>> {
    try {
      const summary = await this.diagnostics.checkProject();
      return {
        ok: true,
        filesChecked: summary.filesChecked,
        errorCount: summary.errorCount,
        warningCount: summary.warningCount,
        diagnostics: summary.diagnostics,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
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

  // -- screenshot / asset generation -----------------------------------------

  private viewportScreenshot(maxSize: number): Record<string, unknown> {
    const shot = this.viewportRenderer.captureScreenshot({ maxSize });
    if (!shot) {
      return {
        ok: false,
        error: 'The viewport is not initialized yet (open a project with a scene first).',
      };
    }
    return {
      ok: true,
      width: shot.width,
      height: shot.height,
      mimeType: shot.mimeType,
      note: 'The screenshot is attached as an image.',
      [AGENT_TOOL_IMAGES_KEY]: [
        { mimeType: shot.mimeType, data: shot.dataBase64 },
      ] satisfies AgentToolImage[],
    };
  }

  private async analyzeImage(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = asString(args.source);
    const question = typeof args.question === 'string' ? args.question : '';
    let image: LlmImageBlock;
    try {
      image = await this.resolveImageForAnalysis(source);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const answer = await this.vision.analyze(image, question);
      const helper = await this.vision.describeHelper();
      return {
        ok: true,
        answer,
        model: helper ? `${helper.providerLabel} · ${helper.modelLabel ?? helper.modelId}` : null,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Turn an `analyze_image` source (viewport / handle / project path) into an inline image block. */
  private async resolveImageForAnalysis(source: string): Promise<LlmImageBlock> {
    if (source === 'viewport') {
      const shot = this.viewportRenderer.captureScreenshot({ maxSize: 1024 });
      if (!shot) {
        throw new Error('The viewport is not initialized yet (open a project with a scene first).');
      }
      return { type: 'image', mimeType: shot.mimeType, data: shot.dataBase64 };
    }
    // A live generation handle from generate_asset?
    if (this.assetGen.get(source)) {
      return dataUrlToImageBlock(await this.assetGen.preview(source, 1024));
    }
    // Otherwise a project image path — open, downscale for token economy, then release the handle.
    const path = this.safePath(source);
    const opened = await this.assetGen.open(path);
    try {
      return dataUrlToImageBlock(await this.assetGen.preview(opened.id, 1024));
    } finally {
      this.assetGen.discard(opened.id);
    }
  }

  private async generateAsset(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const status = await this.assetGen.status();
    if (!status.keyConfigured) {
      return {
        ok: false,
        error:
          'No image-generation API key is configured. Ask the user to set one (Asset Generator panel or Settings → AI Providers).',
      };
    }

    const prompt = asString(args.prompt);
    const name = this.safePath(asString(args.name));
    const references = Array.isArray(args.references)
      ? args.references.filter((r): r is string => typeof r === 'string')
      : undefined;
    const transparent = args.transparent === true;
    const maxSize = typeof args.maxSize === 'number' ? Math.floor(args.maxSize) : undefined;
    const preset = resolvePreset(args.postProcess, transparent ? 'sprite' : 'texture');

    const generated = await this.assetGen.generate({ prompt, references, transparent });
    // The generation plus every intermediate handle the pipeline creates must be freed.
    const handleIds = new Set<string>([generated.id]);
    try {
      const processed = await this.assetGen.postProcess(generated.id, preset, { maxSize });
      handleIds.add(processed.id);
      const saved = await this.assetGen.save(processed.id, name, {});
      // Preview the PROCESSED handle (what was actually saved), not the raw generation.
      return {
        ok: true,
        saved,
        preset,
        original: { width: generated.width, height: generated.height },
        note: `Saved with the "${preset}" preset. A 256px preview of the final asset is attached as an image.`,
        ...(await this.previewImages(processed.id)),
      };
    } finally {
      for (const id of handleIds) {
        this.assetGen.discard(id);
      }
    }
  }

  private async processAsset(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (appState.project.status !== 'ready') {
      return { ok: false, error: 'No project is open — cannot process an asset.' };
    }
    const path = this.safePath(asString(args.path));
    const preset = resolvePreset(args.preset, 'sprite');
    const maxSize = typeof args.maxSize === 'number' ? Math.floor(args.maxSize) : undefined;
    const outName =
      typeof args.name === 'string' && args.name.trim() ? this.safePath(args.name) : path;

    const opened = await this.assetGen.open(path);
    const handleIds = new Set<string>([opened.id]);
    try {
      const processed = await this.assetGen.postProcess(opened.id, preset, { maxSize });
      handleIds.add(processed.id);
      const saved = await this.assetGen.save(processed.id, outName, {});
      return {
        ok: true,
        saved,
        preset,
        note: `Processed "${path}" → "${saved.path}" with the "${preset}" preset. Preview attached.`,
        ...(await this.previewImages(processed.id)),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      for (const id of handleIds) {
        this.assetGen.discard(id);
      }
    }
  }

  /** Build the `__images` payload from a 256px preview of a handle, for visual QC by the model. */
  private async previewImages(handleId: string): Promise<Record<string, unknown>> {
    const previewDataUrl = await this.assetGen.preview(handleId, 256);
    const comma = previewDataUrl.indexOf(',');
    const previewMime = previewDataUrl.slice(5, previewDataUrl.indexOf(';'));
    return {
      [AGENT_TOOL_IMAGES_KEY]: [
        { mimeType: previewMime, data: previewDataUrl.slice(comma + 1) },
      ] satisfies AgentToolImage[],
    };
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

const ASSET_PRESETS: readonly AssetPostProcessPreset[] = ['sprite', 'icon', 'texture', 'none'];

/** Coerce a tool argument to a known post-processing preset, else the supplied fallback. */
const resolvePreset = (value: unknown, fallback: AssetPostProcessPreset): AssetPostProcessPreset =>
  typeof value === 'string' && (ASSET_PRESETS as readonly string[]).includes(value)
    ? (value as AssetPostProcessPreset)
    : fallback;

/** Split a `data:<mime>;base64,<data>` URL into an inline image block (base64 without the prefix). */
const dataUrlToImageBlock = (dataUrl: string): LlmImageBlock => {
  const comma = dataUrl.indexOf(',');
  const semi = dataUrl.indexOf(';');
  const mimeType = comma > 5 && semi > 5 && semi < comma ? dataUrl.slice(5, semi) : 'image/png';
  return { type: 'image', mimeType, data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl };
};
