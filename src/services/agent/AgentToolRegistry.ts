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
import { EditorTabService } from '@/services/EditorTabService';
import { ProjectScriptLoaderService } from '@/services/ProjectScriptLoaderService';
import { ScriptCompilerService, type CompilationError } from '@/services/ScriptCompilerService';
import { CommandRegistry } from '@/services/CommandRegistry';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { LoggingService } from '@/services/LoggingService';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { AssetGenService, type AssetPostProcessPreset } from '@/services/AssetGenService';
import type { AlphaStats } from '@/services/image-gen/image-ops';
import { AgentVisionService } from '@/services/agent/AgentVisionService';
import {
  GameInputService,
  type GameInputStep,
  type GameInputExpectation,
} from '@/services/agent/GameInputService';
import { GamePlaySessionService } from '@/services/GamePlaySessionService';
import type { CanvasScreenshot } from '@/core/canvas-screenshot';
import { AgentAdvisorService } from '@/services/agent/AgentAdvisorService';
import { AgentSkillsService } from '@/services/agent/AgentSkillsService';
import { ProjectDiagnosticsService } from '@/services/ProjectDiagnosticsService';
import type { LlmImageBlock } from '@/services/llm/LlmTypes';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import { SaveSceneCommand } from '@/features/scene/SaveSceneCommand';
import { ReloadSceneCommand } from '@/features/scene/ReloadSceneCommand';
import { AddComponentCommand } from '@/features/scripts/AddComponentCommand';
import { StartSceneGameCommand } from '@/features/scripts/StartSceneGameCommand';
import { RemoveComponentCommand } from '@/features/scripts/RemoveComponentCommand';
import { UpdateComponentPropertyCommand } from '@/features/scripts/UpdateComponentPropertyCommand';
import { SceneManager, NodeBase, ScriptRegistry, getNodePropertySchema } from '@pix3/runtime';
import { Vector2 } from 'three';
import {
  buildCreateNodeCommand,
  CREATABLE_NODE_TYPES,
  type CreateNodeOptions,
} from '@/services/agent/create-node-registry';
import { ConvertNodeTypeCommand } from '@/features/scene/ConvertNodeTypeCommand';

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
 * Property types whose value is a genuine string — never JSON-parse an agent-supplied string for
 * these (a color "#ff0000", an enum "idle", or a node reference must stay a string). Every OTHER
 * type — numbers, booleans, vectors, objects — may arrive stringified from some providers (see
 * coercePropertyValue) and is parsed back.
 */
const STRINGLIKE_PROPERTY_TYPES = new Set(['string', 'color', 'enum', 'select', 'node']);

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

  @inject(GameInputService)
  private readonly gameInput!: GameInputService;

  @inject(GamePlaySessionService)
  private readonly playSession!: GamePlaySessionService;

  @inject(AgentAdvisorService)
  private readonly advisor!: AgentAdvisorService;

  @inject(AgentSkillsService)
  private readonly skills!: AgentSkillsService;

  @inject(ProjectDiagnosticsService)
  private readonly diagnostics!: ProjectDiagnosticsService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(EditorTabService)
  private readonly editorTabs!: EditorTabService;

  @inject(ProjectScriptLoaderService)
  private readonly projectScriptLoader!: ProjectScriptLoaderService;

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
        name: 'ask_advisor',
        description:
          'Consult a stronger "advisor" model when you are genuinely stuck or facing a non-obvious decision: an error that survived ~2 fix attempts, an architecture/approach choice, or a review of your plan before a large change. NOT for routine operations or anything another tool answers directly. The advisor sees ONLY what you pass here (no scene, no files, no conversation) — put the goal, the exact error text, and the relevant code/snippets into `context`, or you will get generic advice. Costly: at most a couple of calls per task.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'One specific question (one decision or one problem per call).',
            },
            context: {
              type: 'string',
              description:
                'Everything needed to answer: relevant code, exact error messages, what you already tried, constraints/goal. The advisor cannot look anything up itself.',
            },
          },
          required: ['question', 'context'],
          additionalProperties: false,
        },
        handler: args => this.askAdvisor(args),
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
        handler: async args => {
          await this.ensureActiveScene();
          return this.sceneTree(asInt(args.maxDepth, 3));
        },
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
        handler: async args => {
          await this.ensureActiveScene();
          return this.nodeInspect(asString(args.nodeId));
        },
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
        handler: async args => {
          await this.ensureActiveScene();
          return this.findNodes(asString(args.text));
        },
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
        handler: async args => {
          await this.ensureActiveScene();
          return this.setProperty(asString(args.nodeId), asString(args.propertyPath), args.value);
        },
      },
      {
        name: 'create_node',
        description:
          "Create a new node in the active scene (undoable). Use it to build scenes and — importantly — to turn placeholder art into real graphics, e.g. add a Sprite2D that shows a generated texture. `nodeType` is case-insensitive; creatable types: " +
          CREATABLE_NODE_TYPES.join(', ') +
          ". Pass `texturePath` (res://…) for sprites (it also auto-sizes them), an optional `parentId` (defaults to a sensible root) and `position` {x,y}, and a `properties` object for anything else (color/width/height/label/opacity/…) applied via set_property after creation. Returns the new nodeId. To REPLACE an existing placeholder such as a ColorRect2D with a sprite, prefer convert_node_type — it keeps the node's transform, components and children.",
        inputSchema: {
          type: 'object',
          properties: {
            nodeType: { type: 'string', description: 'e.g. "Sprite2D" (case-insensitive).' },
            name: { type: 'string' },
            parentId: {
              type: 'string',
              description: 'Parent node id; omit for a sensible default root.',
            },
            position: {
              type: 'object',
              description: "2D position {x,y} in the parent's space.",
              properties: { x: { type: 'number' }, y: { type: 'number' } },
            },
            texturePath: {
              type: 'string',
              description:
                'res:// image path for Sprite2D / TiledSprite2D / Sprite3D (also auto-sizes the sprite).',
            },
            width: { type: 'number' },
            height: { type: 'number' },
            text: { type: 'string', description: 'Initial text for Label2D.' },
            src: { type: 'string', description: 'res://….glb path for MeshInstance3D.' },
            properties: {
              type: 'object',
              description:
                'Extra schema properties applied after creation via set_property, e.g. {"color":"#ff0000","opacity":0.5}.',
              additionalProperties: true,
            },
          },
          required: ['nodeType'],
          additionalProperties: false,
        },
        handler: args => this.createNode(args),
      },
      {
        name: 'convert_node_type',
        description:
          "Replace an existing node with a new node of a different type IN PLACE, keeping its id, name, transform, size, attached components AND children (undoable). This is the right way to \"skin\" a placeholder: e.g. convert a scaffolding ColorRect2D into a Sprite2D showing a generated texture without losing the script component on it. Pass the new visual bits via `properties` (e.g. {\"texturePath\":\"res://…\"} for a sprite). Common target types: " +
          CREATABLE_NODE_TYPES.join(', ') +
          ' (most serializable node types work). Returns the (unchanged) nodeId and its new type.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'Id of the node to replace.' },
            toType: {
              type: 'string',
              description: 'Target node type, e.g. "Sprite2D" (case-sensitive type name).',
            },
            properties: {
              type: 'object',
              description:
                'Property overrides for the new node, applied on top of the migrated ones — e.g. {"texturePath":"res://…"} for a Sprite2D.',
              additionalProperties: true,
            },
          },
          required: ['nodeId', 'toType'],
          additionalProperties: false,
        },
        handler: args => this.convertNodeType(args),
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
              description:
                'A type id from list_component_types (e.g. "core:Rotate" or "user:Foo").',
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
        handler: async args => {
          await this.ensureActiveScene();
          return this.addComponent(args);
        },
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
        handler: async args => {
          await this.ensureActiveScene();
          return this.setComponentProperty(
            asString(args.nodeId),
            asString(args.componentId),
            asString(args.propertyName),
            args.value
          );
        },
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
        handler: async args => {
          await this.ensureActiveScene();
          return this.removeComponent(asString(args.nodeId), asString(args.componentId));
        },
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
          'Run a registered command by id (use list_commands for the catalog; do not invent ids — there is no "scene.reload", edited scene files auto-reload). Only scene/properties/selection/alignment/history/viewport/game.* commands are permitted (no dialogs/pickers).',
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
        description:
          'Write (create or overwrite) a project text file. Creates parent directories. Writing the ACTIVE scene file replaces the scene wholesale (the editor auto-reloads it): components previously attached via add_component are lost unless your YAML includes them — verify with node_inspect afterwards.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        handler: args => this.fsWrite(asString(args.path), asString(args.content)),
      },
      {
        name: 'str_replace',
        description:
          'Make a TARGETED edit to an existing project text file: replace an exact `old_string` with `new_string`, leaving everything else byte-for-byte. PREFER THIS over fs_write for changing existing code — a full rewrite can silently drop or revert other parts of the file (a real session regressed a working fix that way). `old_string` must match the file EXACTLY (indentation and whitespace included) and be UNIQUE — include a few surrounding lines to pin it down. It makes NO change and returns an error if `old_string` is not found or matches more than once; read the error, widen the context, and retry. Pass replace_all:true to replace every occurrence. Use fs_write only to CREATE a file or rewrite it wholesale. Editing the active .pix3scene reloads it (same as fs_write).',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: {
              type: 'string',
              description: 'Exact text to find, verbatim (including indentation/newlines).',
            },
            new_string: { type: 'string', description: 'Text to replace it with (may be empty to delete).' },
            replace_all: {
              type: 'boolean',
              description: 'Replace every occurrence. Default false = require exactly one match.',
            },
          },
          required: ['path', 'old_string', 'new_string'],
          additionalProperties: false,
        },
        handler: args =>
          this.strReplace(
            asString(args.path),
            asString(args.old_string),
            asString(args.new_string),
            args.replace_all === true
          ),
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
        description:
          'Enter play mode (start the game). Without `scene` plays the active scene (auto-opens the project scene if none). Pass `scene` (res:// or project-relative .pix3scene path) to play that exact scene regardless of which tab is active; `reload: true` additionally re-reads it from disk first — use after compiling scripts when the scene was opened before the compile (stale graph drops user:* components).',
        inputSchema: {
          type: 'object',
          properties: {
            scene: {
              type: 'string',
              description: 'Scene to play (.pix3scene, res:// or project-relative). Optional.',
            },
            reload: {
              type: 'boolean',
              description: 'Re-read the scene from disk before playing (only with `scene`).',
            },
          },
          additionalProperties: false,
        },
        handler: args =>
          this.playStart(
            typeof args.scene === 'string' ? args.scene : undefined,
            args.reload === true
          ),
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
        name: 'game_input',
        description:
          "Send REAL input to the RUNNING game and verify the REACTION in one call (requires play mode — play_start first). Steps: {type:'key',code:'ArrowUp',ms:800} holds a key (KeyboardEvent.code: 'KeyW','ArrowLeft','Space'); {type:'keys',codes:['KeyW','KeyA'],ms:500} holds a chord; {type:'tap',target:'PlayButton'} presses a node (Button2D etc.) by name or nodeId — or tap at coordinates {type:'tap',x:960,y:540} (same space as node position properties); {type:'drag',x,y,to:{x,y},ms}; {type:'wait',ms}. READ `verdict` FIRST: it fuses every signal into one line — `moved:false` does NOT mean the game is dead. Pass observe:['Player','Cannonballs'] to watch nodes over the whole window (not just endpoints). Each observed node reports transform motion (`moved`, `alignForward`/`alignRight`: +1 forward along the nose, ~0 = SIDEWAYS, −1 backward) AND `activity` — what it did DURING the window: `spawned`/`removed` children, `visibleChildPeak` (pools recycle ammo by toggling visibility — the count of children in flight, NOT position), `maxChildDistance` (projectiles fly while the spawner stays at 0,0). A spawner/shooter/pool/HUD reacts WITHOUT moving. When a GameDebugProvider is registered, `game.changed` carries the game's own state diff (ammo/score/wave). To assert: expect:{'PlayerCar':'forward'} for movers → observed.PlayerCar.directionOk; expect:{'Cannonballs':'activity'} for spawners/shooters/pools/HUD → passes when anything reacted. Values: forward | backward | sideways | moving | still | activity.",
        inputSchema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              description: 'Input steps, executed in order. Total duration is capped at 15s.',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['tap', 'key', 'keys', 'drag', 'wait'] },
                  target: { type: 'string', description: 'Node name or nodeId to tap/drag from.' },
                  x: { type: 'number' },
                  y: { type: 'number' },
                  to: {
                    type: 'object',
                    description: 'Drag destination: coordinates or a target node.',
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' },
                      target: { type: 'string' },
                    },
                    additionalProperties: false,
                  },
                  code: { type: 'string', description: "KeyboardEvent.code, e.g. 'KeyW'." },
                  codes: { type: 'array', items: { type: 'string' } },
                  ms: { type: 'number', description: 'Hold/drag/wait duration in ms.' },
                  holdMs: {
                    type: 'number',
                    description: 'Tap press duration (default 700 — UI buttons need a real press).',
                  },
                },
                required: ['type'],
                additionalProperties: false,
              },
            },
            observe: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Node names/ids to watch over the window: transform (moved, alignForward/alignRight), children (childCount/visibleChildCount), and `activity` (spawned/removed, visibleChildPeak, maxChildDistance, stateChanges). Watch the container of a spawner/pool (e.g. "Cannonballs"), not just the player. Max 8 tracked.',
            },
            expect: {
              type: 'object',
              description:
                "Per-node assertion, e.g. {'PlayerCar':'forward'} or {'Cannonballs':'activity'}. Each named node is auto-observed and gets a directionOk verdict. Use 'activity' for spawners/shooters/pools/HUD that react without moving. Values: forward | backward | sideways | moving | still | activity.",
              additionalProperties: {
                type: 'string',
                enum: ['forward', 'backward', 'sideways', 'moving', 'still', 'activity'],
              },
            },
            settleMs: {
              type: 'number',
              description: 'Extra wait before the "after" snapshot (default 300).',
            },
          },
          required: ['steps'],
          additionalProperties: false,
        },
        handler: args =>
          this.gameInput.run(Array.isArray(args.steps) ? (args.steps as GameInputStep[]) : [], {
            observe: Array.isArray(args.observe) ? (args.observe as string[]) : undefined,
            settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
            expect:
              args.expect && typeof args.expect === 'object'
                ? (args.expect as Record<string, GameInputExpectation>)
                : undefined,
          }),
      },
      {
        name: 'game_observe',
        description:
          "Live state of nodes in the RUNNING game WITHOUT sending input (requires play mode): transform, children (childCount/visibleChildCount), and the game's own `game.snapshot` when a GameDebugProvider is registered. Pass nodes:['Player','Enemy'] (names or ids); omit to sample the scene roots. With sampleMs (e.g. 1000-2000) it records the window and reports per-node `activity` (motion, spawn/despawn, visible-child bursts, state changes) + `moved`/`alignForward`/`alignRight`, plus a fused `verdict` — e.g. confirm an AI car drives on its own, or measure a self-acting spawner's baseline BEFORE you attribute activity to your input. A `null` snapshot comes with a `hint` (play mode still warming up → retry, vs wrong name/id → check scene_tree).",
        inputSchema: {
          type: 'object',
          properties: {
            nodes: { type: 'array', items: { type: 'string' } },
            sampleMs: {
              type: 'number',
              description: 'Optional: wait this long and sample again to detect motion (max 5000).',
            },
          },
          additionalProperties: false,
        },
        handler: args =>
          this.gameInput.observe(
            Array.isArray(args.nodes) ? (args.nodes as string[]) : [],
            typeof args.sampleMs === 'number' ? args.sampleMs : 0
          ),
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
          "Capture what is on screen as an image the model can see. While play mode is active this captures the RUNNING GAME canvas; otherwise the edit-mode editor viewport. Use it to visually check layout, colors, and placement. The user's editor camera may be zoomed/scrolled anywhere — pass `frame:\"all\"` to fit the whole scene, `frame:\"selection\"` to fit the current selection, or `nodeId` to zoom onto one node (add `isolate:true` to hide other content that overlaps/covers it). Framing is temporary and captures the EDITOR viewport (never the game) without moving the user's camera. The result reports `view` and, when framed, `framed`.",
        inputSchema: {
          type: 'object',
          properties: {
            maxSize: {
              type: 'integer',
              description: 'Longest-edge cap in px (default 1024).',
            },
            source: {
              type: 'string',
              enum: ['auto', 'game', 'editor'],
              description:
                'What to capture when NOT framing: "auto" (default) = the running game when play mode is active, else the editor viewport; "game" = the running game only (errors when not playing); "editor" = the edit-mode viewport even while playing. Any framing param forces the editor viewport.',
            },
            frame: {
              type: 'string',
              enum: ['current', 'all', 'selection', 'node'],
              description:
                'Aim the editor camera before capturing: "current" (default) = capture as-is; "all" = fit all scene content; "selection" = fit the selected node(s); "node" = fit the node given by nodeId. The user\'s camera is restored afterwards.',
            },
            nodeId: {
              type: 'string',
              description:
                'Node to frame (from find_nodes / scene tree). Implies frame:"node".',
            },
            isolate: {
              type: 'boolean',
              description:
                'With a framed node/selection: hide every OTHER node so the target and its children are captured unobstructed on a clean background. Default false (surrounding context stays visible).',
            },
            padding: {
              type: 'number',
              description:
                'Margin around framed content as a fraction of its size, 0–1 (default ~0.15). Smaller = tighter crop.',
            },
          },
          additionalProperties: false,
        },
        handler: args => this.viewportScreenshot(args),
      },
      {
        name: 'analyze_image',
        description:
          'Ask a vision-capable helper model to look at an image and answer a question — use this when YOUR model cannot see images (no vision). source is a project image path (res:// or relative), "viewport" (a fresh screenshot: the RUNNING GAME while play mode is active, else the editor viewport; "game"/"editor" force one), or a generated-image handle id. Ideal for extracting style tokens from a design reference before generating art, or QC-ing a generated sprite / the scene layout / the running game.',
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description:
                'A project image path, "viewport" (game when playing, else editor), "game", "editor", or a generation handle id.',
            },
            question: {
              type: 'string',
              description:
                'What to ask about the image. For verification, ask a yes/no checklist ("(1) exactly ONE subject, not a whole scene? (2) centered, not cut off?") — an open "describe it" answer reads as success even when the content is wrong. Defaults to a general description.',
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
          "Generate an image with the project's AI image provider (uses the user's saved image key), post-process it to be game-ready (background removal, trim to content, downscale), and save it into the project. For sprites/icons set transparent:true and describe a SINGLE centered subject on a plain background, carrying the art style as prompt keywords (see the references warning before passing screenshots). Returns the saved path, original vs saved size, and a small preview you can see.",
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
                'Project image paths used as style references. WARNING: the generator copies composition, not just style — a full gameplay screenshot as reference for a single-object sprite tends to reproduce the whole scene. For single-object sprites/icons prefer style keywords in the prompt and omit this; pass references when you want a scene-like result (backgrounds, mockups).',
            },
            rotate: {
              type: 'integer',
              enum: [90, 180, 270],
              description:
                'Rotate the result clockwise by this many degrees AFTER post-processing. Use to fix a top-down sprite that came out sideways (e.g. a car whose nose points left/down instead of up) without regenerating.',
            },
            flip: {
              type: 'string',
              enum: ['horizontal', 'vertical'],
              description: 'Mirror the result horizontally or vertically (applied after rotate).',
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
          'Post-process an EXISTING project image: background removal, trim to content, downscale, re-encode, and optional rotate/flip. Use it to fix an image that has an unwanted background, is too large, is not cropped tight, or is mis-oriented (e.g. a previously generated sprite or a user import). Presets match generate_asset: sprite / icon / texture / none. Pass rotate (90/180/270) and/or flip (horizontal/vertical) to re-orient without regenerating. Writes back to `path` unless `name` is given. Returns the saved path and a preview.',
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
            rotate: {
              type: 'integer',
              enum: [90, 180, 270],
              description:
                'Rotate clockwise by this many degrees after the preset runs — fixes a sideways sprite (e.g. a top-down car whose nose points the wrong way) without regenerating.',
            },
            flip: {
              type: 'string',
              enum: ['horizontal', 'vertical'],
              description: 'Mirror horizontally or vertically (applied after rotate).',
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
      // A section miss must show what actually exists — otherwise models retry the same
      // invented heading verbatim, forever (observed in eval runs).
      const sections = section ? this.skills.sections(id) : [];
      return {
        ok: false,
        error: section
          ? sections.length > 0
            ? `No section matching "${section}" in skill "${id}". Do NOT retry this name. Existing sections: ${sections.map(s => `"${s}"`).join(', ')} — pick one of these, or omit section to read the whole skill.`
            : `Unknown skill "${id}". Available skills: ${available}.`
          : `Unknown skill "${id}". Available: ${available}.`,
      };
    }
    return { ok: true, id, section: section ?? null, content };
  }

  // -- advisor -----------------------------------------------------------------

  private async askAdvisor(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const question = asString(args.question);
    const context = typeof args.context === 'string' ? args.context : '';
    // Ground the advisor with the one thing the caller always forgets to mention: where it is.
    const activeSceneId = appState.scenes.activeSceneId;
    const activePath = activeSceneId
      ? (appState.scenes.descriptors[activeSceneId]?.filePath ?? null)
      : null;
    const header = `Pix3 project "${appState.project.projectName ?? 'Untitled'}"${
      activePath ? `, active scene: ${activePath}` : ''
    }`;
    try {
      const answer = await this.advisor.consult(question, `${header}\n\n${context}`);
      const info = await this.advisor.describeAdvisor();
      return {
        ok: true,
        answer,
        advisor: info ? `${info.providerLabel} · ${info.modelLabel ?? info.modelId}` : null,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // -- introspection ---------------------------------------------------------

  /**
   * Scene-dependent tools auto-open the project scene when none is active. The editor can end up
   * scene-less mid-session (e.g. a failed reload of an externally rewritten scene file closes the
   * tab), and the agent has no tool to open scenes — models then flail with fs_write rewrites and
   * forbidden commands (observed in eval runs). Prefer the editor startup scene (`main.pix3scene`,
   * the gameplay scene the agent iterates on) so recovery never lands the agent on a menu/entry
   * scene; fall back to the configured entry scene, then any known scene.
   */
  private async ensureActiveScene(): Promise<void> {
    if (this.sceneManager.getActiveSceneGraph()) {
      return;
    }
    const startupPath = 'src/assets/scenes/main.pix3scene';
    const stripPrefix = (p: string): string => p.replace(/^res:\/\//i, '').replace(/^\/+/, '');
    const descriptorPaths = Object.values(appState.scenes.descriptors).map(d => d.filePath ?? '');
    const startupDescriptor = descriptorPaths.find(p => stripPrefix(p) === startupPath);
    const configured = appState.project.manifest?.defaultExportScenePath?.trim() ?? '';
    const raw = startupDescriptor || configured || descriptorPaths[0] || startupPath;
    const path = raw.startsWith('res://') ? raw : `res://${raw.replace(/^res:\/\//i, '')}`;
    await this.editorTabs.focusOrOpenScene(path);
    // The scene loads asynchronously behind the tab activation; give it a few seconds.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (this.sceneManager.getActiveSceneGraph()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(
      `No scene is open and auto-opening "${path}" did not load one. The scene file is probably invalid — fs_read it and check the YAML.`
    );
  }

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
  ): Promise<{ ok: boolean; error?: string }> {
    // Guard the value SHAPE before dispatch. The schema setters assume an exact shape (a vector2
    // wants {x,y}); a wrong shape like the array [x,y] slips straight through as a silent no-op,
    // which misleads models into concluding "the engine ignores this property" (observed in eval:
    // waypoints set with [x,y] stayed at 0,0 and the model then hardcoded them in script).
    const coerced = this.coercePropertyValue(nodeId, propertyPath, value);
    if ('error' in coerced) {
      return { ok: false, error: coerced.error };
    }
    const ok = await this.dispatcher.execute(
      new UpdateObjectPropertyCommand({ nodeId, propertyPath, value: coerced.value })
    );
    if (ok) {
      await this.saveActiveSceneBestEffort();
    }
    return { ok };
  }

  private async createNode(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (appState.project.status !== 'ready') {
      return { ok: false, error: 'No project is open — cannot create a node.' };
    }
    await this.ensureActiveScene();
    if (!this.sceneManager.getActiveSceneGraph()) {
      return { ok: false, error: 'No active scene — open a scene first.' };
    }
    const nodeType = asString(args.nodeType);
    const options: CreateNodeOptions = {
      name: typeof args.name === 'string' ? args.name : undefined,
      parentNodeId: typeof args.parentId === 'string' ? args.parentId : undefined,
      position: parseVector2(args.position),
      width: typeof args.width === 'number' ? args.width : undefined,
      height: typeof args.height === 'number' ? args.height : undefined,
      texturePath: typeof args.texturePath === 'string' ? args.texturePath : undefined,
      text: typeof args.text === 'string' ? args.text : undefined,
      src: typeof args.src === 'string' ? args.src : undefined,
    };
    const command = buildCreateNodeCommand(nodeType, options);
    if (!command) {
      return {
        ok: false,
        error: `Cannot create node type "${nodeType}". Creatable types: ${CREATABLE_NODE_TYPES.join(', ')}.`,
      };
    }
    const didMutate = await this.dispatcher.execute(command);
    if (!didMutate) {
      return {
        ok: false,
        error: `Creating a ${nodeType} did not mutate the scene (blocked by preconditions?).`,
      };
    }
    // The create operation selects the new node — that's how its id surfaces to callers (see
    // getCreatedNodeIdFromSelection in scene-command-utils).
    const nodeId = appState.selection.primaryNodeId ?? '';

    // Apply any extra schema properties the create params didn't cover (color, opacity, label, …).
    const propertyErrors: Record<string, string> = {};
    const props = args.properties;
    if (nodeId && props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [path, value] of Object.entries(props as Record<string, unknown>)) {
        const result = await this.setProperty(nodeId, path, value);
        if (!result.ok) {
          propertyErrors[path] = result.error ?? 'property could not be set';
        }
      }
    }
    await this.saveActiveSceneBestEffort();

    const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    return {
      ok: true,
      nodeId,
      nodeType: node?.type ?? nodeType,
      name: node?.name,
      ...(Object.keys(propertyErrors).length > 0 ? { propertyErrors } : {}),
    };
  }

  private async convertNodeType(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (appState.project.status !== 'ready') {
      return { ok: false, error: 'No project is open — cannot convert a node.' };
    }
    await this.ensureActiveScene();
    const graph = this.sceneManager.getActiveSceneGraph();
    if (!graph) {
      return { ok: false, error: 'No active scene — open a scene first.' };
    }
    const nodeId = asString(args.nodeId);
    const toType = asString(args.toType);
    const source = graph.nodeMap.get(nodeId);
    if (!(source instanceof NodeBase)) {
      return { ok: false, error: `Node "${nodeId}" not found in the active scene.` };
    }
    if (source.type === toType) {
      return { ok: false, error: `Node "${nodeId}" is already a ${toType}.` };
    }
    const props = args.properties;
    const properties =
      props && typeof props === 'object' && !Array.isArray(props)
        ? (props as Record<string, unknown>)
        : undefined;

    const didMutate = await this.dispatcher.execute(
      new ConvertNodeTypeCommand({ nodeId, toType, properties })
    );
    if (!didMutate) {
      return {
        ok: false,
        error: `Could not convert "${nodeId}" to "${toType}" — the target type may be unknown or the node is a prefab instance. Common target types: ${CREATABLE_NODE_TYPES.join(', ')}.`,
      };
    }
    await this.saveActiveSceneBestEffort();

    const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    return { ok: true, nodeId, nodeType: node?.type ?? toType, name: node?.name };
  }

  /**
   * Coerce/validate an agent-supplied property value against the node's schema. Only vector types
   * are touched (the observed silent-no-op class): an array of the right arity is coerced to the
   * {x,y[,z[,w]]} object the setter expects, an already-valid object passes through, and any other
   * shape returns an error naming the expected form instead of a mystery no-op. Every other
   * property type passes through unchanged so this cannot regress existing edits.
   */
  private coercePropertyValue(
    nodeId: string,
    propertyPath: string,
    value: unknown
  ): { value: unknown } | { error: string } {
    const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    if (!(node instanceof NodeBase)) {
      return { value }; // node resolution is the operation's job; don't second-guess it here
    }
    let propDef;
    try {
      propDef = getNodePropertySchema(node).properties.find(p => p.name === propertyPath);
    } catch {
      return { value };
    }
    if (!propDef) {
      return { value };
    }

    // Some OpenAI-compatible providers (observed with OpenCode Zen free models) serialize a
    // structured or scalar tool argument as a JSON *string* — e.g. value: "{\"x\":-300,\"y\":-259.8}",
    // "[-300,-259.8]", "90" or "true" — because the tool's `value` schema is untyped. Parse it back
    // for every property type EXCEPT the genuinely string-valued ones (a color "#ff0000" or an enum
    // "idle" must stay a string). A non-JSON string is left untouched. Without this a stringified
    // vector slips through as a silent shape mismatch and the model abandons set_property to
    // hand-edit the scene file (a real session then tripped over the degrees-vs-radians rotation
    // format that way).
    let current = value;
    if (typeof current === 'string' && !STRINGLIKE_PROPERTY_TYPES.has(propDef.type)) {
      try {
        current = JSON.parse(current);
      } catch {
        // Not JSON — keep the raw string for the downstream setter / the error below.
      }
    }

    const arity =
      propDef.type === 'vector2'
        ? 2
        : propDef.type === 'vector3'
          ? 3
          : propDef.type === 'vector4'
            ? 4
            : 0;
    if (arity === 0) {
      return { value: current };
    }
    const keys = ['x', 'y', 'z', 'w'].slice(0, arity);
    const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    if (
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current) &&
      keys.every(k => isFiniteNumber((current as Record<string, unknown>)[k]))
    ) {
      return { value: current };
    }
    if (Array.isArray(current) && current.length === arity && current.every(isFiniteNumber)) {
      const obj: Record<string, number> = {};
      keys.forEach((k, i) => (obj[k] = current[i] as number));
      return { value: obj };
    }
    return {
      error: `Property "${propertyPath}" on this node is a ${propDef.type}; its value must be an object { ${keys.join(', ')} } (an array [${keys.join(', ')}] is also accepted). Received ${JSON.stringify(value)}.`,
    };
  }

  /**
   * Persist the active scene after an agent mutation. Agent edits must be durable: components and
   * properties changed via tools live only in the loaded scene until a save, so any scene reload
   * (an external fs_write of the file, a page reload) silently discards them — models then
   * re-attach the same components turn after turn without understanding why. Best-effort: a failed
   * save must never fail the mutation that succeeded.
   */
  private async saveActiveSceneBestEffort(): Promise<void> {
    try {
      await this.dispatcher.execute(new SaveSceneCommand());
    } catch (error) {
      console.warn('[AgentToolRegistry] Scene save after agent mutation failed:', error);
    }
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
    if (ok) {
      await this.saveActiveSceneBestEffort();
    }
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
    if (ok) {
      await this.saveActiveSceneBestEffort();
    }
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
    if (ok) {
      await this.saveActiveSceneBestEffort();
    }
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

  private async fsWrite(
    path: string,
    content: string
  ): Promise<{ ok: true; path: string; reloadedScene?: string }> {
    const safe = this.safePath(path);
    // ProjectStorageService.writeTextFile bumps appState.project.fileRefreshSignal internally, so
    // open code tabs / the asset browser pick the change up — no direct appState mutation here.
    await this.storage.writeTextFile(safe, content);
    const reloadedScene = await this.reloadSceneIfOpen(safe);
    return { ok: true, path: safe, ...(reloadedScene ? { reloadedScene } : {}) };
  }

  /**
   * Targeted edit: swap an exact, unique `oldString` for `newString`. Refuses (no write) when the
   * anchor is absent or ambiguous, so a mismatched edit fails loudly instead of corrupting the
   * file — the reason blind full-file rewrites reverted a good fix in the wild. Splicing avoids
   * String.replace's `$`-pattern interpretation in the replacement text.
   */
  private async strReplace(
    path: string,
    oldString: string,
    newString: string,
    replaceAll: boolean
  ): Promise<
    | { ok: true; path: string; replacements: number; reloadedScene?: string }
    | { ok: false; error: string }
  > {
    const safe = this.safePath(path);
    if (!isTextPath(safe)) {
      return { ok: false, error: `str_replace edits text files only; "${safe}" is binary.` };
    }
    if (oldString.length === 0) {
      return {
        ok: false,
        error: 'old_string must not be empty. Use fs_write to create a file; to insert text, anchor old_string on nearby existing lines.',
      };
    }
    if (oldString === newString) {
      return { ok: false, error: 'old_string and new_string are identical — nothing to change.' };
    }
    let content: string;
    try {
      content = await this.storage.readTextFile(safe);
    } catch {
      return { ok: false, error: `File not found: ${safe}. Use fs_write to create it.` };
    }
    const count = countOccurrences(content, oldString);
    if (count === 0) {
      return {
        ok: false,
        error: `old_string was not found in ${safe}. It must match exactly, including whitespace and indentation. fs_read the file and copy the target text verbatim.`,
      };
    }
    if (count > 1 && !replaceAll) {
      return {
        ok: false,
        error: `old_string matches ${count} places in ${safe}. Include surrounding lines to make it unique, or pass replace_all:true to change all ${count}.`,
      };
    }
    let updated: string;
    if (replaceAll) {
      updated = content.split(oldString).join(newString);
    } else {
      const at = content.indexOf(oldString);
      updated = content.slice(0, at) + newString + content.slice(at + oldString.length);
    }
    await this.storage.writeTextFile(safe, updated);
    const reloadedScene = await this.reloadSceneIfOpen(safe);
    return {
      ok: true,
      path: safe,
      replacements: replaceAll ? count : 1,
      ...(reloadedScene ? { reloadedScene } : {}),
    };
  }

  /**
   * Deterministically reload an OPEN scene the agent just overwrote. The file watcher cannot be
   * relied on here: browser-OPFS scene descriptors carry no usable fileHandle and a blurred
   * automation window pauses polling — observed in eval: the agent rewrote the active scene,
   * the editor silently kept the stale graph, and every follow-up edit targeted dead nodes.
   */
  private async reloadSceneIfOpen(safePath: string): Promise<string | null> {
    if (!safePath.toLowerCase().endsWith('.pix3scene')) {
      return null;
    }
    const entry = Object.entries(appState.scenes.descriptors).find(([, descriptor]) => {
      const descriptorPath = (descriptor?.filePath ?? '')
        .replace(/^res:\/\//i, '')
        .replace(/^\/+/, '');
      return descriptorPath === safePath;
    });
    if (!entry) {
      return null;
    }
    const [sceneId, descriptor] = entry;
    try {
      const ok = await this.dispatcher.execute(
        new ReloadSceneCommand({ sceneId, filePath: descriptor.filePath })
      );
      return ok ? sceneId : null;
    } catch (error) {
      console.warn('[AgentToolRegistry] Scene reload after fs_write failed:', error);
      return null;
    }
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
      // A successful bundle alone does NOT update the live ScriptRegistry — without this
      // rebuild the game keeps running the previously registered classes and the model's
      // "fixed" scripts change nothing (it then reports "the old code is still executing").
      // force: the agent's automation window is typically unfocused, which would defer the build.
      await this.projectScriptLoader.syncAndBuild({ force: true });
      await this.projectScriptLoader.ensureReady();
      return {
        ok: true,
        fileCount: files.size,
        bytes: result.code.length,
        warnings: result.warnings,
        registered: true,
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

  /**
   * Capture pixels for the model: the running game when play mode is active
   * ('auto'), or explicitly the game / editor viewport. The game path renders a
   * frame on the live runtime canvas via {@link GamePlaySessionService}; the
   * editor path uses the edit-mode viewport (proxy visuals, gizmos and all).
   */
  private captureView(
    source: AgentCaptureSource,
    maxSize: number
  ): { shot: CanvasScreenshot; view: 'game' | 'editor'; note?: string } | { error: string } {
    if (source !== 'editor' && appState.ui.isPlaying) {
      const shot = this.playSession.captureScreenshot({ maxSize });
      if (shot) {
        return { shot, view: 'game' };
      }
      if (source === 'game') {
        return {
          error:
            'Play mode is starting but the game canvas is not attached yet; retry in a moment.',
        };
      }
    } else if (source === 'game') {
      return {
        error:
          'The game is not running — call play_start first (or use source "editor" for the edit-mode viewport).',
      };
    }
    const shot = this.viewportRenderer.captureScreenshot({ maxSize });
    if (!shot) {
      return { error: 'The viewport is not initialized yet (open a project with a scene first).' };
    }
    return {
      shot,
      view: 'editor',
      // 'auto' while isPlaying only lands here when the game canvas was not ready — say so,
      // or the model reads the edit-mode frame as the running game.
      ...(appState.ui.isPlaying
        ? { note: 'The game canvas was not ready; this is the EDIT-MODE viewport instead.' }
        : {}),
    };
  }

  private viewportScreenshot(args: Record<string, unknown>): Record<string, unknown> {
    const maxSize = asInt(args.maxSize, 1024);
    const source = asCaptureSource(args.source);
    const nodeId = typeof args.nodeId === 'string' && args.nodeId ? args.nodeId : undefined;
    const isolate = args.isolate === true;
    const padding = typeof args.padding === 'number' ? args.padding : undefined;
    // A bare nodeId means "frame this node".
    let frame = typeof args.frame === 'string' ? args.frame : 'current';
    if (nodeId && frame === 'current') {
      frame = 'node';
    }

    if (frame !== 'current') {
      return this.framedViewportScreenshot(
        frame as 'all' | 'selection' | 'node',
        { maxSize, source, nodeId, isolate, padding }
      );
    }

    // Unframed: capture as-is (game while playing unless source forces editor).
    const capture = this.captureView(source, maxSize);
    if ('error' in capture) {
      return { ok: false, error: capture.error };
    }
    const { shot, view } = capture;
    return {
      ok: true,
      view,
      width: shot.width,
      height: shot.height,
      mimeType: shot.mimeType,
      note:
        capture.note ??
        (view === 'game'
          ? 'The screenshot of the RUNNING GAME is attached as an image.'
          : 'The screenshot of the edit-mode editor viewport is attached as an image.'),
      [AGENT_TOOL_IMAGES_KEY]: [
        { mimeType: shot.mimeType, data: shot.dataBase64 },
      ] satisfies AgentToolImage[],
    };
  }

  /**
   * Editor-viewport screenshot with the camera transiently aimed at scene
   * content / a selection / a node, optionally isolating the target. Always the
   * editor (never the game) and always restores the user's camera.
   */
  private framedViewportScreenshot(
    frame: 'all' | 'selection' | 'node',
    opts: {
      maxSize: number;
      source: AgentCaptureSource;
      nodeId?: string;
      isolate: boolean;
      padding?: number;
    }
  ): Record<string, unknown> {
    if (frame === 'node' && !opts.nodeId) {
      return { ok: false, error: 'frame:"node" requires nodeId.' };
    }
    if (opts.isolate && frame === 'all') {
      return {
        ok: false,
        error: 'isolate needs a target — use frame:"node" (with nodeId) or frame:"selection".',
      };
    }
    if (opts.source === 'game') {
      return {
        ok: false,
        error: 'Framing captures the editor viewport — drop source or use source:"editor".',
      };
    }

    // padding fraction (0–1) → bounds inflation multiplier, clamped to a sane range.
    const paddingMultiplier =
      opts.padding !== undefined
        ? Math.min(3, Math.max(1, 1 + 2 * opts.padding))
        : undefined;

    const result = this.viewportRenderer.captureFramedScreenshot({
      maxSize: opts.maxSize,
      frame,
      nodeId: opts.nodeId,
      isolate: opts.isolate,
      paddingMultiplier,
    });
    if (result === null) {
      return {
        ok: false,
        error: 'The viewport is not initialized yet (open a project with a scene first).',
      };
    }
    if ('error' in result) {
      return { ok: false, error: result.error };
    }

    const framedNode = opts.nodeId
      ? this.sceneManager.getActiveSceneGraph()?.nodeMap.get(opts.nodeId)
      : undefined;
    const target =
      frame === 'node' ? `node "${framedNode?.name ?? opts.nodeId}"` : `the ${frame}`;
    return {
      ok: true,
      view: 'editor',
      framed: frame,
      ...(opts.nodeId ? { framedNodeId: opts.nodeId, framedNodeName: framedNode?.name } : {}),
      width: result.width,
      height: result.height,
      mimeType: result.mimeType,
      note: `Editor viewport framed on ${target}${
        opts.isolate ? ' with other nodes hidden' : ''
      }. The user's camera was restored.`,
      [AGENT_TOOL_IMAGES_KEY]: [
        { mimeType: result.mimeType, data: result.dataBase64 },
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

  /** Turn an `analyze_image` source (viewport / game / handle / project path) into an inline image block. */
  private async resolveImageForAnalysis(source: string): Promise<LlmImageBlock> {
    if (source === 'viewport' || source === 'game' || source === 'editor') {
      const capture = this.captureView(source === 'viewport' ? 'auto' : source, 1024);
      if ('error' in capture) {
        throw new Error(capture.error);
      }
      return { type: 'image', mimeType: capture.shot.mimeType, data: capture.shot.dataBase64 };
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
      // Optional orientation fix (rotate/flip) applied AFTER post-processing — top-down sprites
      // often come out sideways and the model can't otherwise re-orient without regenerating.
      const oriented = await this.applyOrientation(processed.id, args, id => handleIds.add(id));
      const saved = await this.assetGen.save(oriented, name, {});
      const transparency = await this.assetGen.alphaStats(oriented);
      // Preview the ORIENTED handle (what was actually saved), not the raw generation.
      return {
        ok: true,
        saved,
        preset,
        original: { width: generated.width, height: generated.height },
        transparency,
        note: transparencyNote(preset, transparency),
        ...(await this.previewImages(oriented)),
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
      const oriented = await this.applyOrientation(processed.id, args, id => handleIds.add(id));
      const saved = await this.assetGen.save(oriented, outName, {});
      const transparency = await this.assetGen.alphaStats(oriented);
      return {
        ok: true,
        saved,
        preset,
        transparency,
        note: `Processed "${path}" → "${saved.path}" with the "${preset}" preset. ${transparencyNote(preset, transparency)}`,
        ...(await this.previewImages(oriented)),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      for (const id of handleIds) {
        this.assetGen.discard(id);
      }
    }
  }

  /**
   * Apply optional `rotate` (90/180/270, clockwise) then `flip` ('horizontal'/'vertical') to an
   * image handle, returning the id of the final handle (the input id when neither is requested).
   * Each intermediate handle is registered via `track` so the caller frees it. Invalid values are
   * ignored rather than erroring — orientation is a best-effort refinement.
   */
  private async applyOrientation(
    handleId: string,
    args: Record<string, unknown>,
    track: (id: string) => void
  ): Promise<string> {
    let currentId = handleId;
    const rotate = asInt(args.rotate, 0);
    if (rotate === 90 || rotate === 180 || rotate === 270) {
      const rotated = await this.assetGen.rotate(currentId, (rotate / 90) as 1 | 2 | 3);
      track(rotated.id);
      currentId = rotated.id;
    }
    const flip = typeof args.flip === 'string' ? args.flip : '';
    if (flip === 'horizontal' || flip === 'vertical') {
      const flipped = await this.assetGen.flip(currentId, flip);
      track(flipped.id);
      currentId = flipped.id;
    }
    return currentId;
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
    // Starting/restarting needs an active scene; auto-open it (stop must keep working regardless).
    if (commandId !== 'game.stop') {
      await this.ensureActiveScene();
    }
    return { ok: await this.dispatcher.executeById(commandId) };
  }

  /**
   * play_start: no `scene` → legacy behavior (active scene via game.start);
   * with `scene` → play exactly that scene (game.start-scene), optionally
   * re-reading it from disk first so a graph opened before a script compile
   * (which silently drops user:* components) doesn't get cloned stale.
   */
  private async playStart(
    scene: string | undefined,
    reload: boolean
  ): Promise<{ ok: boolean; scene?: string; reloaded?: boolean; error?: string }> {
    if (!scene) {
      return this.playCommand('game.start');
    }
    let safe: string;
    try {
      safe = this.safePath(scene);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!safe.toLowerCase().endsWith('.pix3scene')) {
      return { ok: false, error: `Not a scene path: "${scene}" (expected a .pix3scene file)` };
    }
    let reloaded = false;
    if (reload) {
      reloaded = (await this.reloadSceneIfOpen(safe)) !== null;
    }
    const ok = await this.dispatcher.execute(new StartSceneGameCommand({ scenePath: safe }));
    return { ok, scene: safe, reloaded };
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

/** Count non-overlapping occurrences of `needle` in `haystack` (matches split/join semantics). */
const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

const asString = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new Error(`Expected a string argument, got ${typeof value}.`);
  }
  return value;
};

/** Which surface a screenshot tool captures. */
type AgentCaptureSource = 'auto' | 'game' | 'editor';

// Lenient on junk values (providers do send them for enum params): fall back to 'auto'.
const asCaptureSource = (value: unknown): AgentCaptureSource =>
  value === 'game' || value === 'editor' ? value : 'auto';

const asInt = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  // Gemini returns enum-constrained numeric params as strings (its schema enum is string-only), so
  // a `rotate: "90"` must still parse back to 90 rather than falling through to the default.
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

/** Parse an agent-supplied 2D position ({x,y} object or [x,y] array) into a Vector2, or undefined. */
const parseVector2 = (value: unknown): Vector2 | undefined => {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  ) {
    return new Vector2(value[0], value[1]);
  }
  if (value && typeof value === 'object') {
    const v = value as { x?: unknown; y?: unknown };
    if (typeof v.x === 'number' && typeof v.y === 'number') {
      return new Vector2(v.x, v.y);
    }
  }
  return undefined;
};

const ASSET_PRESETS: readonly AssetPostProcessPreset[] = ['sprite', 'icon', 'texture', 'none'];

/** Coerce a tool argument to a known post-processing preset, else the supplied fallback. */
const resolvePreset = (value: unknown, fallback: AssetPostProcessPreset): AssetPostProcessPreset =>
  typeof value === 'string' && (ASSET_PRESETS as readonly string[]).includes(value)
    ? (value as AssetPostProcessPreset)
    : fallback;

/**
 * A note the model can trust for transparency — because vision models CANNOT judge it (a
 * transparent PNG is flattened onto white before they see it). The `hasAlpha` fact is measured
 * from the alpha channel, so the model must not re-check transparency via analyze_image.
 */
const transparencyNote = (preset: AssetPostProcessPreset, alpha: AlphaStats): string => {
  const base = `Saved with the "${preset}" preset. A 256px preview is attached.`;
  if (preset === 'sprite' || preset === 'icon') {
    return alpha.hasAlpha
      ? `${base} The background WAS removed — the PNG has a transparent background (${Math.round(alpha.transparentFraction * 100)}% transparent pixels, measured from the alpha channel). Do NOT use analyze_image to check transparency: vision models see transparent pixels as white and will wrongly report a white background.`
      : `${base} Warning: no transparency was detected in the result — background removal may have failed. You can retry with process_asset.`;
  }
  return base;
};

/** Split a `data:<mime>;base64,<data>` URL into an inline image block (base64 without the prefix). */
const dataUrlToImageBlock = (dataUrl: string): LlmImageBlock => {
  const comma = dataUrl.indexOf(',');
  const semi = dataUrl.indexOf(';');
  const mimeType = comma > 5 && semi > 5 && semi < comma ? dataUrl.slice(5, semi) : 'image/png';
  return { type: 'image', mimeType, data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl };
};
