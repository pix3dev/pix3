import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import { registerScriptErrorSink, type ScriptErrorInfo } from '@pix3/runtime';
import { LoggingService } from './LoggingService';

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

  initialize(): void {
    if (this.initialized || typeof window === 'undefined') {
      return;
    }
    this.initialized = true;

    this.disposeSink = registerScriptErrorSink(this.handleScriptError);
    window.addEventListener('error', this.handleWindowError);
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
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

  private readonly handleScriptError = (error: ScriptErrorInfo): void => {
    const where = error.nodeName
      ? ` in "${error.nodeName}"${error.componentType ? ` (${error.componentType})` : ''}`
      : '';
    const summary = `Script error [${error.phase}]${where}: ${error.message}`;

    this.loggingService.error(summary, {
      phase: error.phase,
      nodeName: error.nodeName,
      componentType: error.componentType,
      componentId: error.componentId,
      stack: error.stack,
    });

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
    const message =
      reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    this.loggingService.error(`Unhandled promise rejection: ${message}`, {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };

  dispose(): void {
    this.disposeSink?.();
    this.disposeSink = undefined;
    if (typeof window !== 'undefined') {
      window.removeEventListener('error', this.handleWindowError);
      window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);
    }
    this.initialized = false;
  }
}
