/**
 * Rewrites the editor's tool prose for the live agent channel (`pix3 mcp --workspace`).
 *
 * The channel serves 14 of the in-editor agent's ~100 tools, but it hands out the SAME
 * descriptions — and the same verdict / hint strings — the in-editor agent reads, and those point
 * at tools the channel does not have (`game_controls`, `scene_tree`, `node_inspect`,
 * `game_trace`, …). An external agent told "get the names from game_controls" calls a tool that
 * does not exist and loses a turn on `unknown_tool`. This post-processor runs over everything the
 * window sends through the channel: first a table of phrase rewrites that keep the sentence
 * readable, then a token fallback, so the invariant "no tool outside the allowlist is named"
 * holds even for prose written after this table.
 */

interface PhraseRewrite {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/** Phrase-level rewrites, applied in order before the token fallback. */
const PHRASE_REWRITES: readonly PhraseRewrite[] = [
  {
    pattern: /Get the names from game_controls\./g,
    replacement:
      'Target nodes by the names the scene gives them (game_observe reports live names); an ' +
      'interaction name the control does not offer is refused with the list it does offer.',
  },
  {
    pattern: /as named by game_controls/g,
    replacement:
      'as the control names it (a name it does not offer is refused with the ones it does)',
  },
  {
    pattern: /keyed by the argument names game_controls lists/g,
    replacement: "keyed by the interaction's argument names",
  },
  {
    pattern: /the (interactive )?controls game_controls lists/g,
    replacement: 'the $1controls on screen',
  },
  {
    pattern: /game_controls lists what is on screen/g,
    replacement: 'game_observe and viewport_screenshot show what is on screen',
  },
  {
    pattern: /game_controls lists (every|them)/g,
    replacement: 'game_observe reports $1',
  },
  {
    pattern: /you release it with game_time \{paused: false\}, send input/g,
    replacement: 'you send input',
  },
  {
    pattern: /That refusal is about THIS tool only: game_trace[\s\S]*?after your next change\.\s*/g,
    replacement: '',
  },
  {
    pattern: /read the FILE with fs_read \{offset, limit\} in slices/g,
    replacement: 'read the FILE (it is in the project directory on disk) in slices',
  },
  {
    pattern: /\(from find_nodes \/ scene tree\)/g,
    replacement: '(its id in the .pix3scene, or from get_selection)',
  },
  {
    pattern: /;? ?scene_tree still shows the EDITOR's scene, not this one\./g,
    replacement: '.',
  },
  {
    pattern: /(check|Check) (game_observe \/ )?scene_tree( or find_nodes)?/g,
    replacement: '$1 game_observe (with no names it lists the live roots)',
  },
  {
    pattern: /read_errors and scene_tree/g,
    replacement: 'read_errors and game_observe',
  },
  {
    pattern: /Use scene_tree or find_nodes/g,
    replacement: 'Use game_observe or get_selection',
  },
];

/**
 * What a remaining token becomes when no phrase rewrite caught it — the nearest tool the channel
 * does have, else a neutral phrase. Unknown editor tools fall back to {@link UNSERVED}.
 */
const TOKEN_FALLBACK: Readonly<Record<string, string>> = {
  game_controls: 'game_input',
  scene_tree: 'game_observe',
  node_inspect: 'game_observe',
  find_nodes: 'game_observe',
  game_time: 'game_input',
  play_screenshot: 'viewport_screenshot',
  fs_read: 'a file read on disk',
};
const UNSERVED = 'an in-editor tool this channel does not serve';

const TOOL_TOKEN = /\b[a-z]+(?:_[a-z0-9]+)+\b/g;

/**
 * Rewrite one prose string for the channel. `editorTools` is every tool the editor registry
 * knows; `served` the ones the channel answers. Tokens that are not editor tools (property names,
 * error codes) are left alone.
 */
export function rewriteForChannel(
  text: string,
  editorTools: ReadonlySet<string>,
  served: ReadonlySet<string>
): string {
  if (!TOOL_TOKEN.test(text)) return text;
  TOOL_TOKEN.lastIndex = 0;
  let out = text;
  for (const { pattern, replacement } of PHRASE_REWRITES) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(TOOL_TOKEN, token =>
    editorTools.has(token) && !served.has(token) ? (TOKEN_FALLBACK[token] ?? UNSERVED) : token
  );
}

/** Keys whose string values are data (a rendered label, a node's name), never prose to rewrite. */
const DATA_KEYS: ReadonlySet<string> = new Set(['text', 'name', 'nodeId', 'id', 'path', 'file']);

/** {@link rewriteForChannel} over every prose string of a JSON value (a spec, a tool result). */
export function rewriteValueForChannel<T>(
  value: T,
  editorTools: ReadonlySet<string>,
  served: ReadonlySet<string>
): T {
  const walk = (node: unknown, key: string | null): unknown => {
    if (typeof node === 'string') {
      return key !== null && DATA_KEYS.has(key)
        ? node
        : rewriteForChannel(node, editorTools, served);
    }
    if (Array.isArray(node)) return node.map(entry => walk(entry, key));
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(node)) out[childKey] = walk(child, childKey);
      return out;
    }
    return node;
  };
  return walk(value, null) as T;
}
