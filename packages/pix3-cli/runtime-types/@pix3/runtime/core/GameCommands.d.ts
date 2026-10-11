import type { PropertyDefinition } from '../fw/property-schema';
/** Optional discovery metadata for a command. */
export interface GameCommandMeta {
    /** One line, shown to agents in `list()`. Say what the intent does, not how. */
    description?: string;
    /** Argument schema, reusing the property-schema types the Inspector already speaks. */
    params?: readonly PropertyDefinition[];
    /** Declares that the handler returns a reverse step. Advisory: `list()` reports it. */
    undoable?: boolean;
}
/** A handler's reverse step, returned to make the command undoable. */
export interface GameCommandUndo {
    undo(): void;
}
/** Command arguments. Must be JSON-serialisable — see {@link GameCommandRegistry.dispatch}. */
export type GameCommandArgs = Record<string, unknown>;
/** A command handler: performs the intent, optionally returning how to reverse it. */
export type GameCommandHandler = (args?: GameCommandArgs) => void | GameCommandUndo;
/** What `list()` publishes about one command. */
export interface GameCommandDescriptor {
    name: string;
    description?: string;
    params?: readonly PropertyDefinition[];
    undoable: boolean;
}
/**
 * Outcome of one log entry:
 * - `ok` — the handler ran to completion;
 * - `error` — the handler threw; the game loop was not affected;
 * - `unknown` — nothing is registered under that name;
 * - `rejected` — refused before running (bad name, duplicate, non-serialisable
 *   args, recursion cap, nothing to undo);
 * - `undo` — a reverse step ran.
 */
export type GameCommandLogStatus = 'ok' | 'error' | 'unknown' | 'rejected' | 'undo';
/** One line of the command journal. */
export interface GameCommandLogEntry {
    /** Frame number as reported by the runner; `0` when no scene is running. */
    frame: number;
    name: string;
    status: GameCommandLogStatus;
    /** Deep copy taken at dispatch time, so later mutation cannot rewrite history. */
    args?: GameCommandArgs;
    /** Set instead of `args` when the serialised arguments exceed the log's cap. */
    argsOmitted?: true;
    /** Why a non-`ok` entry did not do what its name says. */
    error?: string;
}
/**
 * The scene's command registry, reached from scripts as `this.scene.commands`.
 *
 * Every failure mode lands in {@link log} rather than throwing at the caller: a
 * mistyped command name must not disable the script that registered it, and a
 * throwing handler must not take the frame loop down with it (the same boundary
 * `NodeBase` draws around script hooks). Errors additionally go to
 * `reportScriptError`, which surfaces them in the editor's Logs panel.
 */
export declare class GameCommandRegistry {
    private readonly frameProvider;
    private readonly commands;
    private readonly entries;
    private readonly undoStack;
    private depth;
    private dropped;
    /**
     * @param frameProvider Current frame number, supplied by the runner so every
     * journal line is stamped with the frame it happened on. Defaults to `0` for
     * registries created outside a running scene.
     */
    constructor(frameProvider?: () => number);
    /**
     * Register an intent under `name`.
     *
     * Refuses — loudly, in {@link log} and on the console — an invalid name or a
     * duplicate, and returns a no-op disposer in that case. Refusing rather than
     * throwing is deliberate: a typo inside `onStart` would otherwise disable the
     * whole script through the component error boundary and take the game with it.
     *
     * @returns a disposer that unregisters this command (only while it is still
     * the registered one). Scene teardown clears the whole registry anyway; the
     * disposer matters for a script detached mid-scene, e.g. a freed prefab.
     */
    register(name: string, handler: GameCommandHandler, meta?: GameCommandMeta): () => void;
    /**
     * Run the intent registered under `name`.
     *
     * `args` must be JSON-serialisable — anything else could not survive a trace
     * or a routine file, so it is refused before the handler runs rather than
     * blowing up on replay. A throwing handler is contained: the error lands in
     * {@link log} with `status: 'error'` and is reported, and the caller (usually
     * the frame loop, through a button handler) carries on.
     *
     * @returns `true` only when a handler ran to completion.
     */
    dispatch(name: string, args?: GameCommandArgs): boolean;
    /**
     * Reverse the most recent command that declared an undo step. Discovery for
     * agents, and "undo the last move" for the game, are the same mechanism.
     *
     * @returns `true` when a reverse step ran to completion.
     */
    undo(): boolean;
    /** Every registered command, sorted by name — the discovery surface for agents, bots and routines. */
    list(): GameCommandDescriptor[];
    /** The journal: what was dispatched, with which arguments, on which frame. Oldest first. */
    get log(): readonly GameCommandLogEntry[];
    /** How many journal lines the cap dropped — a report says "…and N more" instead of lying. */
    get droppedLogEntries(): number;
    /** True when at least one dispatched command declared a reverse step that has not run yet. */
    get canUndo(): boolean;
    /**
     * Drop every command, journal line and pending undo. Called by
     * `SceneRunner.stop()` — the registry lives with the scene, and a stale
     * command in `list()` is an invitation to dispatch into a dead graph.
     */
    clear(): void;
    private frame;
    private reject;
    private describeArgs;
    private push;
}
