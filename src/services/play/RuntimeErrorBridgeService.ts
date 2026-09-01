import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import {
  isTestHarnessComponentType,
  registerScriptErrorSink,
  registerSignalEmitSink,
  type RenderabilityIssue,
  type ScriptErrorInfo,
  type SignalEmitInfo,
} from '@pix3/runtime';
import { subscribe } from 'valtio/vanilla';
import { stringifyLogArgument } from '@/core/log-argument';
import { LoggingService, type LogLevel } from '@/services/core/LoggingService';

/**
 * Does this stack belong to the game rather than to the editor?
 *
 * In-editor user scripts are compiled to a bundle and imported from a **blob URL** (see
 * `ProjectScriptLoaderService.loadBundle`), so their frames carry a `blob:` origin that no
 * editor-bundle frame has. That is the only non-guessing discriminator available while both run in
 * one page — matching on message prefixes would drop a game's own `[Board] reset` just as happily
 * as an editor service's line.
 *
 * Fails OPEN: no stack means the log is forwarded rather than swallowed. Losing the game's output
 * is the failure that matters; a little extra noise is not.
 */
export function isGameOriginatedStack(stack: string | undefined): boolean {
  if (!stack) {
    return true;
  }
  return stack.includes('blob:');
}

/**
 * RuntimeErrorBridgeService
 *
 * Bridges runtime failures into places the user can actually see them:
 *  - Script/lifecycle errors caught by the runtime (`onStart`/`onUpdate`/…) are
 *    delivered through `registerScriptErrorSink` and forwarded to the Logs panel
 *    (via {@link LoggingService}) and to `appState.ui.playModeError` so the Game
 *    tab can show a banner.
 *  - Truly-uncaught `error` / `unhandledrejection` events are mirrored into the
 *    Logs panel too, so a runtime failure that escapes every guard still shows
 *    up in the editor instead of only in the browser devtools console.
 *  - While play mode is running, the game's own `console.*` output and every
 *    `NodeBase.emit` are mirrored in as well — see {@link interceptGameConsole}
 *    and {@link handleSignalEmit}. Before this, a game's `console.log` and its
 *    signals existed only in devtools, so the Logs panel showed a game that had
 *    crashed but never one that was merely doing the wrong thing.
 *
 * Before this bridge existed, runtime errors went only to `console.error` /
 * `window.onerror`, so a broken script failed silently: the game froze and the
 * Logs panel stayed empty.
 */
@injectable()
export class RuntimeErrorBridgeService {
  @inject(LoggingService)
  private readonly loggingService!: LoggingService;

  private initialized = false;
  private disposeSink?: () => void;
  private disposeSignalSink?: () => void;
  private disposePlayWatch?: () => void;
  /** Restores the untouched console methods; set only while play mode is running. */
  private restoreConsole?: () => void;
  /**
   * Guards the loop `console.log` → forward → LoggingService → its own DEV console echo →
   * forward → … Without it a single game log takes the tab down.
   */
  private forwardingConsole = false;

  initialize(): void {
    if (this.initialized || typeof window === 'undefined') {
      return;
    }
    this.initialized = true;

    this.disposeSink = registerScriptErrorSink(this.handleScriptError);
    this.disposeSignalSink = registerSignalEmitSink(this.handleSignalEmit);
    window.addEventListener('error', this.handleWindowError);
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
    // Console interception follows play mode: an in-editor game shares the page's console with the
    // editor, so patching it permanently would file every editor service's chatter under "game".
    this.disposePlayWatch = subscribe(appState.ui, () => this.syncGameConsoleInterception());
    this.syncGameConsoleInterception();
  }

  /** Clear the current play-mode error banner (called when (re)starting/stopping play). */
  clearPlayModeError(): void {
    if (appState.ui.playModeError !== null) {
      appState.ui.playModeError = null;
    }
  }

  /**
   * Record a play-mode error from a source other than the script sink (e.g. the
   * game session failing to start the scene). Logs to the Logs panel and raises
   * the Game tab banner.
   */
  reportPlayModeFailure(message: string, detail?: unknown): void {
    this.loggingService.error(message, detail);
    appState.ui.playModeError = { message, at: Date.now() };
  }

  /**
   * Report renderability problems found when a scene started playing (see
   * `collectRenderabilityIssues`).
   *
   * These are warnings, not errors — the game is running, nothing threw — but a scene whose meshes
   * have no light draws a black screen, which is indistinguishable from a crash to anyone looking
   * at it, and invisible to anyone looking at the console. So they go to the Logs panel *and* raise
   * the Game-tab banner: this class of failure is only ever caught by being told about it.
   */
  reportSceneIssues(issues: readonly RenderabilityIssue[]): void {
    if (issues.length === 0) {
      return;
    }
    for (const issue of issues) {
      this.loggingService.warn(`Scene renderability: ${issue.message}`, {
        code: issue.code,
        severity: issue.severity,
        nodeIds: issue.nodeIds,
        nodeCount: issue.nodeCount,
      });
    }
    // Only a scene that cannot DRAW earns the banner. Performance advice is real but it is not a
    // failure, and a banner that cries wolf about material cost would get dismissed along with the
    // black screens it sits next to.
    const blocking = issues.find(issue => issue.severity !== 'advice');
    // Never overwrite a real error banner with a lint warning — a thrown script is the bigger news.
    if (blocking && appState.ui.playModeError === null) {
      appState.ui.playModeError = { message: blocking.message, at: Date.now() };
    }
  }

  private readonly handleScriptError = (error: ScriptErrorInfo): void => {
    const where = error.nodeName
      ? ` in "${error.nodeName}"${error.componentType ? ` (${error.componentType})` : ''}`
      : '';
    const detail = {
      phase: error.phase,
      nodeName: error.nodeName,
      componentType: error.componentType,
      componentId: error.componentId,
      stack: error.stack,
    };

    // A `test:`-prefixed component is the harness, not the game (see
    // `isTestHarnessComponentType`), and the difference decides two things.
    //
    // It is logged as a WARNING rather than an error, which keeps it visible in the
    // Logs panel and in devtools while keeping it OUT of the captured-error ring —
    // `installErrorCapture` patches `console.error` only. That ring is what the
    // gameplay harness counts for `newErrors`, and a run may have `newErrors` as its
    // crash net, checked BEFORE the bot's own verdict: reported as an error, a broken
    // test policy would end the run as "the GAME threw" on the frame it died. Measured
    // live before this branch existed.
    //
    // And it raises no Game-tab banner: a banner announcing that the game failed would
    // be the same lie in the UI.
    if (isTestHarnessComponentType(error.componentType)) {
      this.loggingService.warn(`Test harness error [${error.phase}]${where}: ${error.message}`, {
        ...detail,
        note: 'This is test-harness code failing, not the game. It is deliberately not counted as a runtime error.',
      });
      return;
    }

    this.loggingService.error(`Script error [${error.phase}]${where}: ${error.message}`, detail);

    // Only raise the Game-tab banner while playing — a late error arriving after
    // stop should still be logged, but must not resurrect the banner.
    if (appState.ui.isPlaying) {
      appState.ui.playModeError = {
        message: error.message,
        phase: error.phase,
        nodeName: error.nodeName,
        componentType: error.componentType,
        at: Date.now(),
      };
    }
  };

  /**
   * A signal fired. Logged at `debug` so a chatty game does not drown the panel's default view,
   * and with the listener count because the failure this makes visible is usually "the signal fires
   * and nobody is listening".
   */
  private readonly handleSignalEmit = (info: SignalEmitInfo): void => {
    const target = info.nodeName || info.nodeId;
    this.loggingService.logFrom(
      'game',
      'debug',
      `Signal "${info.signal}" from ${target} → ${info.listenerCount} listener(s)`,
      info.args.length > 0 ? { args: info.args } : undefined
    );
  };

  /**
   * Whether the console call being forwarded came from game code. Its own method so a spec can
   * stand in for the stack, which V8 installs as an own property at construction and therefore
   * cannot be faked from `Error.prototype`.
   */
  private isGameOriginatedLog(): boolean {
    return isGameOriginatedStack(new Error().stack);
  }

  /** Patch or restore the game console so interception is live exactly while the game runs. */
  private syncGameConsoleInterception(): void {
    if (appState.ui.isPlaying && !this.restoreConsole) {
      this.interceptGameConsole();
      return;
    }
    if (!appState.ui.isPlaying && this.restoreConsole) {
      this.restoreConsole();
      this.restoreConsole = undefined;
    }
  }

  /**
   * Mirror `console.*` into the Logs panel for the duration of a play session, attributed to
   * `game` — the same thing the standalone player already does over the remote-preview channel
   * (`player-main.ts`), brought to the in-editor Game tab.
   *
   * An in-editor game runs in the editor's own page and shares its console, so "which of these is
   * the game talking" has to be answered from the call stack — see {@link isGameOriginatedLog}.
   * Without that filter the panel filled with `[LayoutManager]` / `[Atlas]` / `[InputService]`
   * chatter labelled `game`, which is worse than no bridge at all: a label that lies.
   */
  private interceptGameConsole(): void {
    const levels = ['debug', 'info', 'warn', 'error'] as const;
    const originals = new Map<string, (...args: unknown[]) => void>();
    const forward = (level: LogLevel, args: unknown[]): void => {
      if (this.forwardingConsole || !this.isGameOriginatedLog()) {
        return;
      }
      this.forwardingConsole = true;
      try {
        this.loggingService.logFrom('game', level, args.map(stringifyLogArgument).join(' '));
      } catch {
        // Never let log forwarding break the game.
      } finally {
        this.forwardingConsole = false;
      }
    };

    // Keep the ORIGINAL method objects, not bound copies: restore has to put back exactly what was
    // there, or every play/stop cycle leaves another wrapper on the console.
    for (const level of levels) {
      const original = console[level];
      originals.set(level, original);
      console[level] = (...args: unknown[]) => {
        original.call(console, ...args);
        forward(level, args);
      };
    }
    const originalLog = console.log;
    originals.set('log', originalLog);
    console.log = (...args: unknown[]) => {
      originalLog.call(console, ...args);
      forward('info', args);
    };

    this.restoreConsole = () => {
      for (const level of levels) {
        const original = originals.get(level);
        if (original) console[level] = original;
      }
      const log = originals.get('log');
      if (log) console.log = log;
    };
  }

  private readonly handleWindowError = (event: ErrorEvent): void => {
    // Ignore resource-load errors (img/script/link) — they have no message and
    // no Error object, and would only add noise to the Logs panel.
    if (!event.message && !(event.error instanceof Error)) {
      return;
    }
    const stack = event.error instanceof Error ? event.error.stack : undefined;
    this.loggingService.error(`Uncaught error: ${event.message || 'unknown error'}`, {
      file: event.filename || undefined,
      line: event.lineno || undefined,
      column: event.colno || undefined,
      stack,
    });
  };

  private readonly handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason;
    const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    this.loggingService.error(`Unhandled promise rejection: ${message}`, {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };

  dispose(): void {
    this.disposeSink?.();
    this.disposeSink = undefined;
    this.disposeSignalSink?.();
    this.disposeSignalSink = undefined;
    this.disposePlayWatch?.();
    this.disposePlayWatch = undefined;
    this.restoreConsole?.();
    this.restoreConsole = undefined;
    if (typeof window !== 'undefined') {
      window.removeEventListener('error', this.handleWindowError);
      window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);
    }
    this.initialized = false;
  }
}
