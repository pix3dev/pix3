/**
 * The v1 tool surface of `pix3 mcp --workspace` (plan §5 D "Узкий набор инструментов"): exactly
 * these names, no scene-mutating tool (plan §4.1 — the agent edits files; the editor only runs,
 * observes, generates and reports).
 *
 * The schemas the agent sees come from the connected editor window (`GET /ws/agent/tools`, which
 * answers with the window's own `AgentToolRegistry` definitions for this allowlist). The static
 * ones below are the fallback, so `tools/list` answers before any window connected; they describe
 * the same arguments in less detail. Keep the names in step with `WORKSPACE_AGENT_TOOLS` in
 * `src/services/project/workspace/WorkspaceAgentToolBridge.ts`.
 */

export type JsonSchema = Record<string, unknown>;

export interface McpToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/** Start a game from verified files: the full §5 D barrier runs first. */
export const BARRIER_TOOLS: ReadonlySet<string> = new Set([
  'play_start',
  'play_restart',
  'game_run',
]);

/** Read the running game: no stop, no sync; they report the revision it started from + `stale`. */
export const OBSERVING_TOOLS: ReadonlySet<string> = new Set([
  'play_status',
  'game_input',
  'game_observe',
  'viewport_screenshot',
  'read_errors',
  'read_logs',
]);

export const WORKSPACE_TOOL_NAMES: readonly string[] = [
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

const EMPTY: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

/** `expect` — added to every barrier tool's schema, whatever the window advertises. */
export const EXPECT_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'sha256 (lowercase hex of the RAW BYTES) of every project file you wrote since your last run, ' +
    'keyed by project-relative path, e.g. {"scenes/main.pix3scene": "ab12…"}. The run starts only ' +
    'if the disk holds exactly these versions (else `disk_differs_from_agent`, with a recovery ' +
    'copy when one exists). Omit only when you wrote nothing; the answer then says ' +
    '`agentExpectations: "none"`.',
  additionalProperties: { type: 'string', pattern: '^[0-9a-f]{64}$' },
};

const BARRIER_NOTE =
  ' Runs through the sync barrier first: checks `expect` against the disk, stops play, makes the ' +
  'editor load the current files and verifies its hashes against the disk, then starts; the ' +
  'answer carries `revision`, `matchesAgent`, `matchesDisk` and `changedDuringRun`.';

const OBSERVING_NOTE =
  ' Does not stop or resync the game: the answer carries the `revision` the running game started ' +
  'from and `stale: true` when the disk moved since (use play_restart to pick new files up).';

const FALLBACK: Record<string, McpToolSpec> = {
  project_status: {
    name: 'project_status',
    description:
      'Whether a Pix3 editor window is connected to this project, what it has open, external ' +
      'versions it has not applied yet, unreadable files, merge conflicts and the latest merge-log ' +
      'entries (why a write of yours did not land as written).',
    inputSchema: EMPTY,
  },
  play_start: {
    name: 'play_start',
    description:
      'Enter play mode. Without `scene` plays the active scene; `scene` (res:// or ' +
      'project-relative .pix3scene) plays that one.',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: 'Scene to play (optional).' },
        reload: { type: 'boolean', description: 'Re-read the scene from disk first.' },
      },
      additionalProperties: false,
    },
  },
  play_stop: { name: 'play_stop', description: 'Exit play mode.', inputSchema: EMPTY },
  play_restart: { name: 'play_restart', description: 'Restart play mode.', inputSchema: EMPTY },
  play_status: {
    name: 'play_status',
    description:
      'Whether the game is playing, and what the last frame drew (draw calls, visible meshes).',
    inputSchema: EMPTY,
  },
  game_run: {
    name: 'game_run',
    description:
      'Run the game frame by frame until a predicate holds (`until`, OR), fails (`fail`) or a ' +
      'budget runs out, or run a stored routine from design/tests/routines (`routine`, `args`). ' +
      'Read `verdict` first. Starts play mode when it is not running.',
    inputSchema: {
      type: 'object',
      properties: {
        until: { type: 'array', items: { type: 'object' } },
        fail: { type: 'array', items: { type: 'object' } },
        watch: { type: 'array', items: { type: 'string' } },
        maxFrames: { type: 'integer' },
        maxWallMs: { type: 'integer' },
        routine: { type: 'string' },
        args: { type: 'object' },
      },
      additionalProperties: true,
    },
  },
  game_input: {
    name: 'game_input',
    description:
      'Send real input to the running game (steps: tap / key / keys / drag / hover / invoke / ' +
      'wait) and report the reaction; `observe` watches nodes over the window. Read `verdict` first.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'object' } },
        observe: { type: 'array', items: { type: 'string' } },
        expect: { type: 'object' },
      },
      required: ['steps'],
      additionalProperties: true,
    },
  },
  game_observe: {
    name: 'game_observe',
    description: 'Read live node state of the running game (by name or id) without sending input.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  read_errors: {
    name: 'read_errors',
    description:
      'Recent runtime errors captured in the editor (console.error, window errors, rejections).',
    inputSchema: EMPTY,
  },
  read_logs: {
    name: 'read_logs',
    description: 'Recent editor log entries; `since` (epoch ms) returns only newer ones.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'number' } },
      additionalProperties: false,
    },
  },
  viewport_screenshot: {
    name: 'viewport_screenshot',
    description:
      'A screenshot as an image: the running game while playing, else the editor viewport. ' +
      '`frame: "all" | "selection" | "node"` (+ `nodeId`) aims the editor camera temporarily.',
    inputSchema: {
      type: 'object',
      properties: {
        maxSize: { type: 'integer' },
        source: { type: 'string', enum: ['auto', 'game', 'editor'] },
        frame: { type: 'string', enum: ['current', 'all', 'selection', 'node'] },
        nodeId: { type: 'string' },
        isolate: { type: 'boolean' },
        padding: { type: 'number' },
        visualReason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  generate_asset: {
    name: 'generate_asset',
    description:
      "Generate an image with the editor's configured image provider (the user's keys — the " +
      'editor asks the user to allow this for the session), post-process it and save it into the ' +
      'project.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        name: { type: 'string', description: 'Target file, e.g. "sprites/car.png".' },
        transparent: { type: 'boolean' },
        postProcess: { type: 'string', enum: ['sprite', 'icon', 'texture', 'none'] },
        width: { type: 'integer' },
        height: { type: 'integer' },
        providerId: { type: 'string' },
      },
      required: ['prompt', 'name'],
      additionalProperties: true,
    },
  },
  generate_sfx: {
    name: 'generate_sfx',
    description:
      "Generate a prototype sound effect (WAV under res://sfx/) with the editor's LLM (asks the " +
      'user to allow this for the session). Not for music, ambience or voice.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        name: { type: 'string' },
        soundline: { type: 'string' },
        feedback: { type: 'string' },
        save: { type: 'boolean' },
      },
      required: ['prompt'],
      additionalProperties: true,
    },
  },
  get_selection: {
    name: 'get_selection',
    description:
      'What the human has selected in the editor right now (node ids, primary, hovered).',
    inputSchema: EMPTY,
  },
};

const asSchema = (value: unknown): JsonSchema | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonSchema) : null;

/** A barrier tool's schema with `expect` added (whatever else the window says it takes). */
const withExpect = (schema: JsonSchema): JsonSchema => {
  const properties = asSchema(schema.properties) ?? {};
  return { ...schema, type: 'object', properties: { ...properties, expect: EXPECT_SCHEMA } };
};

/**
 * The tool list for `tools/list`: the window's definitions where it sent one (only for names on
 * the allowlist), the static fallback otherwise, with the barrier / observing notes and `expect`.
 */
export const buildToolList = (fromWindow: readonly unknown[] | null): McpToolSpec[] => {
  const advertised = new Map<string, McpToolSpec>();
  for (const raw of fromWindow ?? []) {
    const spec = asSchema(raw);
    if (!spec || typeof spec.name !== 'string' || !WORKSPACE_TOOL_NAMES.includes(spec.name)) {
      continue;
    }
    const inputSchema = asSchema(spec.inputSchema);
    if (!inputSchema) continue;
    advertised.set(spec.name, {
      name: spec.name,
      description: typeof spec.description === 'string' ? spec.description : '',
      inputSchema,
    });
  }
  return WORKSPACE_TOOL_NAMES.map(name => {
    const base = advertised.get(name) ?? FALLBACK[name];
    if (BARRIER_TOOLS.has(name)) {
      return {
        name,
        description: base.description + BARRIER_NOTE,
        inputSchema: withExpect(base.inputSchema),
      };
    }
    if (OBSERVING_TOOLS.has(name)) {
      return { ...base, description: base.description + OBSERVING_NOTE };
    }
    return base;
  });
};
