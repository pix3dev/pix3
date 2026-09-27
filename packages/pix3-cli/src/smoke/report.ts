/**
 * `pix3 smoke` report shapes, shared by the CLI side (`command.ts`, plain Node) and the worker that
 * runs the game (`worker.ts`, bundled with the runtime). No imports: both sides load this file.
 */

/** What went wrong while the game ran. Every one of these makes the run fail (exit 1). */
export type SmokeErrorCode =
  /** A script lifecycle hook (`onAttach`/`onStart`/`onUpdate`/…) threw; the engine disabled it. */
  | 'E_SMOKE_SCRIPT'
  /** A script (or the engine) needed a browser API the headless run does not provide. */
  | 'E_SMOKE_DOM'
  /** The engine's own tick threw outside any script hook. */
  | 'E_SMOKE_TICK'
  /** A game command handler threw. */
  | 'E_SMOKE_COMMAND'
  /** Something called `console.error` (not the engine re-reporting one of the above). */
  | 'E_SMOKE_CONSOLE_ERROR'
  /** A promise rejected and nobody handled it, or a timer callback threw. */
  | 'E_SMOKE_UNHANDLED'
  /** The scene could not be loaded or started. */
  | 'E_SMOKE_LOAD'
  /** The project's scripts do not compile. */
  | 'E_SMOKE_SCRIPT_COMPILE'
  /** The compiled scripts threw at module top level when imported. */
  | 'E_SMOKE_SCRIPT_IMPORT';

export interface SmokeError {
  readonly code: SmokeErrorCode;
  /** 0 = loading and starting the scene (`onAttach`/`onStart`), N = the N-th stepped frame. */
  readonly frame: number;
  /** Component type, e.g. `user:GameRules`. */
  readonly script?: string;
  readonly nodeId?: string;
  readonly nodeName?: string;
  /** Lifecycle phase the runtime reported (`start`, `update`, `attach`, `tick`, `command`, …). */
  readonly phase?: string;
  readonly message: string;
  readonly stack?: string;
  /** Browser globals/properties read (and missing) shortly before this error. */
  readonly domAccess?: readonly string[];
}

export type SmokeWarningCode =
  | 'W_SMOKE_MISSING_RESOURCE'
  | 'W_SMOKE_PENDING_COMPONENT'
  | 'W_SMOKE_LOADER'
  | 'W_SMOKE_CONSOLE_WARN'
  | 'W_SMOKE_STUBBED_IMPORT'
  | 'W_SMOKE_STOPPED';

export interface SmokeWarning {
  readonly code: SmokeWarningCode;
  readonly frame?: number;
  readonly message: string;
  /** How many identical warnings were folded into this one. */
  readonly count?: number;
}

export interface SmokeTimings {
  /** Compiling + importing the project's scripts. */
  readonly compile: number;
  /** Loading the scene and running its `onAttach`/`onStart` (frame 0). */
  readonly load: number;
  /** Frame 1 (the first stepped frame). */
  readonly firstFrame: number;
  /** Per stepped frame: engine tick time, not counting the async flush between frames. */
  readonly step: {
    readonly total: number;
    readonly mean: number;
    readonly p95: number;
    readonly max: number;
  };
  /** Whole run, worker start to report. */
  readonly total: number;
}

export interface SmokeReport {
  readonly ok: boolean;
  readonly scene: string;
  /** Frames actually stepped. */
  readonly frames: number;
  readonly framesRequested: number;
  /** The scene started and frame 1 ran with no error attributed to frames 0–1. */
  readonly firstFrameOk: boolean;
  readonly errors: readonly SmokeError[];
  readonly warnings: readonly SmokeWarning[];
  readonly nodes: { readonly start: number; readonly end: number };
  readonly timingsMs: SmokeTimings;
  /** `user:` components registered from the project's scripts. */
  readonly scripts: readonly string[];
  /** Browser properties read but not provided by the shim (feature detection included). */
  readonly domMissing: readonly string[];
  /** What the headless run could not do (models not decoded, audio silent, …). */
  readonly notes: readonly string[];
  /** The game's `registerGameDebug` provider at the end of the run, when it registered one. */
  readonly game: { readonly name: string; readonly snapshot: unknown } | null;
  /** `console.log`/`info` from the run: the total, and the first lines (frame-stamped). */
  readonly logs: { readonly count: number; readonly lines: readonly string[] };
}

/** The run could not happen at all (exit 2). */
export type SmokeFailureCode =
  | 'E_SMOKE_USAGE'
  | 'E_SMOKE_NO_PROJECT'
  | 'E_SMOKE_NO_SCENE'
  | 'E_SMOKE_BUNDLE'
  | 'E_SMOKE_UNSUPPORTED'
  | 'E_SMOKE_TIMEOUT'
  | 'E_SMOKE_CRASH';

export interface SmokeFailure {
  readonly ok: false;
  readonly code: SmokeFailureCode;
  readonly reason: string;
  readonly scene?: string;
}

export type SmokeOutcome = SmokeReport | SmokeFailure;

/**
 * `pix3 smoke` with no scene argument: several scenes, each run on its own (`runs`, in run order).
 * `ok` = every run ran and reported no error.
 */
export interface SmokeRunSet {
  readonly ok: boolean;
  /** `changed` = the scenes uncommitted changes reach; `all` = every top-level scene. */
  readonly selection: 'changed' | 'all';
  /** Why these scenes, in words. */
  readonly reason: string;
  /** Project files git reported as changed, when git was asked. */
  readonly changed?: readonly string[];
  readonly runs: readonly SmokeOutcome[];
}

/** Every code `pix3 smoke` can print — the kit drift spec holds the kit's mentions to this list. */
export const SMOKE_CODES: Readonly<
  Record<SmokeErrorCode | SmokeWarningCode | SmokeFailureCode, 'error' | 'warning' | 'failure'>
> = {
  E_SMOKE_SCRIPT: 'error',
  E_SMOKE_DOM: 'error',
  E_SMOKE_TICK: 'error',
  E_SMOKE_COMMAND: 'error',
  E_SMOKE_CONSOLE_ERROR: 'error',
  E_SMOKE_UNHANDLED: 'error',
  E_SMOKE_LOAD: 'error',
  E_SMOKE_SCRIPT_COMPILE: 'error',
  E_SMOKE_SCRIPT_IMPORT: 'error',
  W_SMOKE_MISSING_RESOURCE: 'warning',
  W_SMOKE_PENDING_COMPONENT: 'warning',
  W_SMOKE_LOADER: 'warning',
  W_SMOKE_CONSOLE_WARN: 'warning',
  W_SMOKE_STUBBED_IMPORT: 'warning',
  W_SMOKE_STOPPED: 'warning',
  E_SMOKE_USAGE: 'failure',
  E_SMOKE_NO_PROJECT: 'failure',
  E_SMOKE_NO_SCENE: 'failure',
  E_SMOKE_BUNDLE: 'failure',
  E_SMOKE_UNSUPPORTED: 'failure',
  E_SMOKE_TIMEOUT: 'failure',
  E_SMOKE_CRASH: 'failure',
};

export const isSmokeFailure = (outcome: SmokeOutcome): outcome is SmokeFailure => 'code' in outcome;

/** What the CLI hands the worker. */
export interface SmokeJob {
  readonly projectRoot: string;
  /** Project-relative scene path, no `res://`. */
  readonly scene: string;
  readonly frames: number;
  readonly viewport: { readonly width: number; readonly height: number };
  /** `pix3project.yaml` `localization` block, verbatim (null = none). */
  readonly localization: unknown;
  /** Where `esbuild` resolves from (the bundle may live in a temp folder). */
  readonly esbuildSpecifier?: string;
  /** A folder whose `node_modules` has `three` (for `three/*` addons a project does not install). */
  readonly fallbackResolveDir?: string;
}
