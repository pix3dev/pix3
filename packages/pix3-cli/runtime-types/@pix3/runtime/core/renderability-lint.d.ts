import { NodeBase } from '../nodes/NodeBase';
/**
 * "Will this scene actually show anything?" — computed from the scene graph, not from a picture.
 *
 * The failure this exists for: a 3D scene whose meshes use lit materials and whose lights are
 * missing (or were authored under a name the loader does not know, so they loaded inert) renders
 * pure black, and every cheap way of checking says it is fine. The editor viewport adds its own
 * fallback lights, so a screenshot looks correct; the console is empty, because nothing threw; the
 * node count is right, because the inert nodes are still there. An agent verifying its own work has
 * no signal at all until a human looks at the running game.
 *
 * So the check has to key on the thing that is actually wrong — lit geometry with nothing lighting
 * it — and be readable wherever the agent already looks (play-start, `game_observe`, `scene_tree`).
 *
 * Pure and editor-agnostic: it walks `Object3D`s and reads `node.type`, so it works on an editor
 * scene graph, a running graph, or a graph parsed in a test, and it pulls no node classes into the
 * bundle beyond `NodeBase` (which every bundle already has).
 */
export type RenderabilityIssueCode = 'lit-material-no-light' | 'no-camera-3d' | 'inert-nodes' | 'pbr-on-mobile';
/**
 * `blocking` = the scene cannot draw what it contains. `advice` = it draws, but costs more than
 * the target platform wants to pay.
 *
 * The split exists so advice can be shown where someone is authoring and withheld from the
 * verification loop: a warning that appears in every single `game_observe` result is a warning
 * everyone learns to scroll past, which would cost the blocking ones their credibility too.
 */
export type RenderabilitySeverity = 'blocking' | 'advice';
export interface RenderabilityLintOptions {
    /** The project's render budget; `desktop` is the only value that buys PBR without comment. */
    readonly targetPlatform?: string;
}
export interface RenderabilityIssue {
    readonly code: RenderabilityIssueCode;
    readonly severity: RenderabilitySeverity;
    /** One sentence, naming the fix — this string is what reaches Logs and agent tool results. */
    readonly message: string;
    /** Node ids the issue is about (capped; `nodeCount` is the true total). */
    readonly nodeIds: readonly string[];
    readonly nodeCount: number;
}
/**
 * Walk a scene graph and report what would keep it from rendering.
 *
 * Visibility is respected — an invisible subtree cannot be the reason the screen is black, and a
 * light switched off by the author is not a light. Play-mode `startVisible` is deliberately *not*
 * consulted: the lint runs against whatever graph it is handed, so a caller checking a running
 * scene already sees the play-mode truth.
 */
export declare const collectRenderabilityIssues: (rootNodes: readonly NodeBase[], options?: RenderabilityLintOptions) => RenderabilityIssue[];
/** One-line summary for a log line or a verdict prefix; empty string when the scene is fine. */
export declare const summarizeRenderabilityIssues: (issues: readonly RenderabilityIssue[]) => string;
/**
 * A node the loader could not build: it fell through to the permissive `NodeBase` fallback *and*
 * its type is not one the vocabulary knows. Both halves are needed — `Group` is a legitimate bare
 * `NodeBase`, and a known type on a real subclass is obviously fine.
 *
 * Exported because the lint is not the only surface that owes the user this fact: an inert node is
 * indistinguishable from a working one in the Scene Tree, which is the first place anybody looks
 * when a node "is there but does nothing".
 */
export declare const isInertNode: (node: NodeBase) => boolean;
