/**
 * Game commands — named intents a game exposes so tooling can drive it without
 * clicking (§5.8 of `.plans/done/agent-gameplay-testing.md`).
 *
 * For menu-, turn- and puzzle-shaped games the testable unit is the *intent*
 * ("open the settings", "make a move", "buy an item"), not a pixel and not even
 * a control. A game whose buttons `dispatch` a command instead of calling the
 * handler directly gets four things for free:
 *
 * 1. a test that never taps anything (`dispatch('open-settings')`);
 * 2. a report timeline in game terms — {@link GameCommandRegistry.log};
 * 3. a regression trace that survives renaming a node (the command name is the
 *    contract, the scene layout is not);
 * 4. undo, when a handler declares it, as a game feature rather than extra work.
 *
 * This is the editor's `CommandDispatcher → Command → Operation` gateway in
 * miniature — a named intent with parameters, not a document-edit history — and
 * it is deliberately a registry, not a subsystem.
 *
 * **Boundaries.** Commands are for *discrete* intents. Continuous control does
 * not survive the trip: "drive left" as a command loses the analog magnitude and
 * the per-frame cadence, and a stick is a hold rather than an event. Movement,
 * gestures and aiming stay on the input axes and controls.
 *
 * **Lifetime.** The registry lives with the scene. `SceneRunner.stop()` clears
 * it (and `runGraph` stops before it starts), so commands registered by the
 * previous scene never linger in `list()` for an agent to dispatch into a torn
 * down graph.
 *
 * ```ts
 * // In a Script's onStart:
 * const commands = this.scene?.commands;
 * this.disposers = [
 *   commands?.register('start-game', () => this.startGame(), {
 *     description: 'Leave the menu and enter the game scene.',
 *   }),
 * ];
 * // Anywhere (a button handler, a test, an agent):
 * this.scene?.commands.dispatch('start-game');
 * ```
 */
import { describeThrown, reportScriptError } from './game-debug';
import type { PropertyDefinition } from '../fw/property-schema';

/**
 * Log cap. Dispatches are discrete events whose *order* is the timeline, so this
 * is a ring buffer (drop oldest, count the drops) rather than the dedup-by-kind
 * discipline the tick-cadence recorders use — collapsing two dispatches of the
 * same command into a counter would destroy exactly the sequence a trace is.
 */
const MAX_LOG_ENTRIES = 50;
/** Recursion cap: a handler that dispatches, whose handler dispatches, … */
const MAX_DISPATCH_DEPTH = 8;
/** Undo entries kept; older reverse steps are dropped, oldest first. */
const MAX_UNDO_ENTRIES = 32;
const MAX_NAME_LENGTH = 64;
/** Args longer than this are logged as omitted — the log is a timeline, not storage. */
const MAX_ARGS_JSON_LENGTH = 200;
/** Nesting cap for the JSON-serialisability check (also the circular-reference backstop). */
const MAX_ARGS_DEPTH = 6;

/**
 * `kebab-case`, optionally namespaced with dots: `restart`, `settings.toggle-music`.
 * Names are typed by agents and stored in traces, so the shape is fixed rather
 * than a convention — see {@link GameCommandRegistry.register}.
 */
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/;

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

interface RegisteredCommand {
  readonly name: string;
  readonly handler: GameCommandHandler;
  readonly meta?: GameCommandMeta;
}

interface UndoEntry {
  readonly name: string;
  readonly undo: () => void;
}

/**
 * Returns a human-readable reason when `value` is not JSON-serialisable, or
 * `null` when it is. The path is part of the message because "args are not
 * serialisable" without naming the offending key is a riddle, not a refusal.
 */
function findNonSerializable(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>
): string | null {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return null;
  if (type === 'number') {
    return Number.isFinite(value) ? null : `${path} is ${String(value)}, which JSON cannot carry`;
  }
  if (type === 'undefined') {
    // JSON.stringify silently drops these, so a trace would replay a different
    // call than the one that ran. Refusing is the only honest option.
    return `${path} is undefined — use null for an absent value`;
  }
  if (type !== 'object') {
    return `${path} is a ${type}, which is not JSON-serialisable`;
  }

  const object = value as object;
  if (seen.has(object)) return `${path} is a circular reference`;
  if (depth > MAX_ARGS_DEPTH) return `${path} nests deeper than ${MAX_ARGS_DEPTH} levels`;

  const prototype = Object.getPrototypeOf(object);
  const isPlain = prototype === Object.prototype || prototype === null;
  if (!Array.isArray(object) && !isPlain) {
    const kind = object.constructor?.name ?? 'object';
    return `${path} is a ${kind} instance — pass plain data, not live objects`;
  }

  seen.add(object);
  try {
    if (Array.isArray(object)) {
      for (let i = 0; i < object.length; i++) {
        const found = findNonSerializable(object[i], `${path}[${i}]`, depth + 1, seen);
        if (found) return found;
      }
      return null;
    }
    for (const [key, entry] of Object.entries(object)) {
      const found = findNonSerializable(entry, `${path}.${key}`, depth + 1, seen);
      if (found) return found;
    }
    return null;
  } finally {
    seen.delete(object);
  }
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
export class GameCommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly entries: GameCommandLogEntry[] = [];
  private readonly undoStack: UndoEntry[] = [];
  private depth = 0;
  private dropped = 0;

  /**
   * @param frameProvider Current frame number, supplied by the runner so every
   * journal line is stamped with the frame it happened on. Defaults to `0` for
   * registries created outside a running scene.
   */
  constructor(private readonly frameProvider: () => number = () => 0) {}

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
  register(name: string, handler: GameCommandHandler, meta?: GameCommandMeta): () => void {
    const noop = (): void => {};
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
      this.reject(
        String(name),
        `command names are 1..${MAX_NAME_LENGTH} characters of kebab-case, optionally namespaced (e.g. "settings.toggle-music")`
      );
      return noop;
    }
    if (!COMMAND_NAME_PATTERN.test(name)) {
      this.reject(
        name,
        `"${name}" is not a valid command name — use kebab-case, optionally namespaced with dots (e.g. "settings.toggle-music")`
      );
      return noop;
    }
    if (typeof handler !== 'function') {
      this.reject(name, `"${name}" was registered without a handler function`);
      return noop;
    }
    if (this.commands.has(name)) {
      // Two owners for one intent is a bug in the game (a prefab instantiated
      // twice, a copy-pasted script), and silently letting the second win would
      // make dispatch target whichever loaded last.
      this.reject(name, `"${name}" is already registered — command names are unique per scene`);
      return noop;
    }

    const record: RegisteredCommand = { name, handler, meta };
    this.commands.set(name, record);
    return () => {
      if (this.commands.get(name) === record) {
        this.commands.delete(name);
      }
    };
  }

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
  dispatch(name: string, args?: GameCommandArgs): boolean {
    const command = this.commands.get(name);
    if (!command) {
      this.push({
        frame: this.frame(),
        name: String(name),
        status: 'unknown',
        error: `no command named "${String(name)}" is registered`,
      });
      console.warn(`[commands] No command named "${String(name)}" is registered.`);
      return false;
    }

    if (args !== undefined) {
      const invalid =
        typeof args !== 'object' || args === null || Array.isArray(args)
          ? 'args must be a plain object of JSON values'
          : findNonSerializable(args, 'args', 0, new Set());
      if (invalid) {
        this.reject(name, invalid);
        return false;
      }
    }

    if (this.depth >= MAX_DISPATCH_DEPTH) {
      this.reject(
        name,
        `dispatch nested deeper than ${MAX_DISPATCH_DEPTH} commands — a command is dispatching itself, directly or in a cycle`
      );
      return false;
    }

    // Logged before the handler runs so nested dispatches read in the order they
    // happened; the entry is amended in place if the handler throws.
    const entry = this.push({
      frame: this.frame(),
      name,
      status: 'ok',
      ...this.describeArgs(args),
    });

    this.depth += 1;
    try {
      const result = command.handler(args);
      if (result && typeof result.undo === 'function') {
        this.undoStack.push({ name, undo: () => result.undo() });
        if (this.undoStack.length > MAX_UNDO_ENTRIES) {
          this.undoStack.shift();
        }
      }
      return true;
    } catch (thrown) {
      const { message, stack } = describeThrown(thrown);
      entry.status = 'error';
      entry.error = message;
      console.error(`[commands] Command "${name}" failed:`, thrown);
      reportScriptError({ phase: 'command', message: `command "${name}": ${message}`, stack });
      return false;
    } finally {
      this.depth -= 1;
    }
  }

  /**
   * Reverse the most recent command that declared an undo step. Discovery for
   * agents, and "undo the last move" for the game, are the same mechanism.
   *
   * @returns `true` when a reverse step ran to completion.
   */
  undo(): boolean {
    const last = this.undoStack.pop();
    if (!last) {
      this.reject('(undo)', 'nothing to undo — no dispatched command declared a reverse step');
      return false;
    }
    if (this.depth >= MAX_DISPATCH_DEPTH) {
      this.reject(last.name, `undo nested deeper than ${MAX_DISPATCH_DEPTH} commands`);
      return false;
    }

    const entry = this.push({ frame: this.frame(), name: last.name, status: 'undo' });
    this.depth += 1;
    try {
      last.undo();
      return true;
    } catch (thrown) {
      const { message, stack } = describeThrown(thrown);
      entry.status = 'error';
      entry.error = message;
      console.error(`[commands] Undo of "${last.name}" failed:`, thrown);
      reportScriptError({
        phase: 'command',
        message: `undo of command "${last.name}": ${message}`,
        stack,
      });
      return false;
    } finally {
      this.depth -= 1;
    }
  }

  /** Every registered command, sorted by name — the discovery surface for agents, bots and routines. */
  list(): GameCommandDescriptor[] {
    return [...this.commands.values()]
      .map(command => ({
        name: command.name,
        ...(command.meta?.description ? { description: command.meta.description } : {}),
        ...(command.meta?.params ? { params: command.meta.params } : {}),
        undoable: command.meta?.undoable === true,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The journal: what was dispatched, with which arguments, on which frame. Oldest first. */
  get log(): readonly GameCommandLogEntry[] {
    return this.entries;
  }

  /** How many journal lines the cap dropped — a report says "…and N more" instead of lying. */
  get droppedLogEntries(): number {
    return this.dropped;
  }

  /** True when at least one dispatched command declared a reverse step that has not run yet. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Drop every command, journal line and pending undo. Called by
   * `SceneRunner.stop()` — the registry lives with the scene, and a stale
   * command in `list()` is an invitation to dispatch into a dead graph.
   */
  clear(): void {
    this.commands.clear();
    this.entries.length = 0;
    this.undoStack.length = 0;
    this.depth = 0;
    this.dropped = 0;
  }

  private frame(): number {
    const frame = this.frameProvider();
    return Number.isFinite(frame) ? frame : 0;
  }

  private reject(name: string, reason: string): void {
    this.push({ frame: this.frame(), name, status: 'rejected', error: reason });
    console.error(`[commands] ${reason}`);
  }

  private describeArgs(
    args?: GameCommandArgs
  ): Pick<GameCommandLogEntry, 'args' | 'argsOmitted'> | Record<string, never> {
    if (args === undefined) return {};
    const serialized = JSON.stringify(args);
    if (serialized === undefined || serialized.length > MAX_ARGS_JSON_LENGTH) {
      return { argsOmitted: true };
    }
    return { args: JSON.parse(serialized) as GameCommandArgs };
  }

  private push(entry: GameCommandLogEntry): GameCommandLogEntry {
    this.entries.push(entry);
    while (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.shift();
      this.dropped += 1;
    }
    return entry;
  }
}
