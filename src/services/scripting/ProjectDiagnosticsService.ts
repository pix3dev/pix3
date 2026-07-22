import type * as Monaco from 'monaco-editor';

import { injectable, inject, injectLazy, type LazyService } from '@/fw/di';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';

import { LoggingService } from '@/services/core/LoggingService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import type { MonacoIntelliSenseService } from '@/services/scripting/MonacoIntelliSenseService';
import { ensureMonacoLoaded, isMonacoLoaded } from '@/ui/code-editor/monaco-loader';
import {
  flattenDiagnosticMessage,
  mapDiagnosticCategory,
  type DiagnosticMessageText,
} from '@/services/scripting/script-diagnostics-format';

/** A single TypeScript diagnostic mapped back to its source file + position. */
export interface ScriptDiagnostic {
  /** Project-relative path, e.g. `scripts/Player.ts`. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  message: string;
  category: 'error' | 'warning';
  /** TypeScript diagnostic code (e.g. 2540 for the readonly-assign error). */
  code: number;
}

export interface ScriptDiagnosticsSummary {
  errorCount: number;
  warningCount: number;
  filesChecked: number;
  diagnostics: ScriptDiagnostic[];
}

interface WorkerDiagnostic {
  start?: number;
  length?: number;
  messageText: DiagnosticMessageText;
  category: number;
  code: number;
}

interface TypeScriptDiagnosticsWorker {
  getSemanticDiagnostics(fileName: string): Promise<WorkerDiagnostic[]>;
  getSyntacticDiagnostics(fileName: string): Promise<WorkerDiagnostic[]>;
}

/**
 * ProjectDiagnosticsService
 *
 * Type-checks *all* project scripts and reports the results (with `file:line:col`)
 * to the Logs panel — so a type error like `Cannot assign to 'position'` is
 * visible without having to open every file in the code editor.
 *
 * esbuild (the runtime compiler) only transpiles and never type-checks, and
 * Monaco only produces diagnostics for files that are open in an editor. This
 * service closes that gap by reusing Monaco's TypeScript worker: it materialises
 * a model for every project script, asks the worker for semantic + syntactic
 * diagnostics, then disposes the temporary models.
 *
 * Auto-runs after a compile and when entering play mode, but ONLY when Monaco is
 * already loaded (so pure scene/asset work never pays the Monaco load cost). The
 * `scripts.check` command runs it on demand, loading Monaco if needed.
 */
@injectable()
export class ProjectDiagnosticsService {
  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(ProjectScriptLoaderService)
  private readonly scriptLoader!: ProjectScriptLoaderService;

  @injectLazy(() =>
    import('@/services/scripting/MonacoIntelliSenseService').then(m => m.MonacoIntelliSenseService)
  )
  private readonly intelliSense!: LazyService<MonacoIntelliSenseService>;

  private initialized = false;
  private running: Promise<ScriptDiagnosticsSummary> | null = null;
  private autoCheckTimer: number | null = null;
  private readonly disposers: Array<() => void> = [];

  /** Result of the most recent check (null until the first run completes). */
  private lastSummary: ScriptDiagnosticsSummary | null = null;
  private readonly listeners = new Set<(summary: ScriptDiagnosticsSummary) => void>();

  /** The most recent check result, or null if no check has run yet. */
  getLastSummary(): ScriptDiagnosticsSummary | null {
    return this.lastSummary;
  }

  /** Subscribe to completed checks (e.g. a status-bar problem counter). */
  subscribe(listener: (summary: ScriptDiagnosticsSummary) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Wire the automatic (free) checks. Call once at startup. */
  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    let lastRefresh = appState.project.scriptRefreshSignal;
    let lastPlaying = appState.ui.isPlaying;

    this.disposers.push(
      subscribe(appState.project, () => {
        if (appState.project.scriptRefreshSignal !== lastRefresh) {
          lastRefresh = appState.project.scriptRefreshSignal;
          this.scheduleAutoCheck();
        }
      })
    );

    this.disposers.push(
      subscribe(appState.ui, () => {
        if (appState.ui.isPlaying !== lastPlaying) {
          lastPlaying = appState.ui.isPlaying;
          if (lastPlaying) {
            this.scheduleAutoCheck();
          }
        }
      })
    );
  }

  /** Auto-check only when Monaco is already in memory — never force the load. */
  private scheduleAutoCheck(): void {
    if (!isMonacoLoaded()) {
      return;
    }
    if (this.autoCheckTimer !== null) {
      window.clearTimeout(this.autoCheckTimer);
    }
    this.autoCheckTimer = window.setTimeout(() => {
      this.autoCheckTimer = null;
      void this.checkProject();
    }, 500);
  }

  /**
   * Run a full project type-check and report results to the Logs panel. Loads
   * Monaco on demand. Concurrent calls share one in-flight run.
   */
  checkProject(): Promise<ScriptDiagnosticsSummary> {
    if (this.running) {
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<ScriptDiagnosticsSummary> {
    const empty: ScriptDiagnosticsSummary = {
      errorCount: 0,
      warningCount: 0,
      filesChecked: 0,
      diagnostics: [],
    };

    const files = [...this.scriptLoader.getCollectedFiles()].filter(
      ([path]) => (path.endsWith('.ts') || path.endsWith('.js')) && !path.endsWith('.d.ts')
    );
    if (files.length === 0) {
      this.logger.info('Script check: no scripts to check.');
      return empty;
    }

    const monaco = await ensureMonacoLoaded();
    const intelliSense = await this.intelliSense();
    await intelliSense.ensureConfigured(monaco);

    // Materialise a model for every project script. Reuse a model if one already
    // exists (an open editor tab); otherwise create a temporary one to dispose.
    const createdModels: Monaco.editor.ITextModel[] = [];
    const models: Array<{ path: string; model: Monaco.editor.ITextModel }> = [];
    for (const [path, content] of files) {
      const uri = monaco.Uri.parse(`res://${path}`);
      let model = monaco.editor.getModel(uri);
      if (!model) {
        model = monaco.editor.createModel(content, this.languageFor(path), uri);
        createdModels.push(model);
      }
      models.push({ path, model });
    }

    // Our new models now shadow the sibling-mirror extra libs; drop the mirrors
    // so the worker doesn't see the same declarations twice (TS2300/TS2440).
    intelliSense.refreshNow();

    try {
      // On a cold Monaco load the engine type libs (@pix3/runtime, three) are
      // still propagating to the worker; give them a moment so the first run
      // doesn't report spurious "cannot find module" errors.
      await new Promise<void>(resolve => window.setTimeout(resolve, 150));

      const getWorker = await monaco.typescript.getTypeScriptWorker();
      const client = (await getWorker(
        ...models.map(m => m.model.uri)
      )) as unknown as TypeScriptDiagnosticsWorker;

      const diagnostics: ScriptDiagnostic[] = [];
      for (const { path, model } of models) {
        const fileName = model.uri.toString();
        const [semantic, syntactic] = await Promise.all([
          client.getSemanticDiagnostics(fileName),
          client.getSyntacticDiagnostics(fileName),
        ]);
        for (const diag of [...syntactic, ...semantic]) {
          const category = mapDiagnosticCategory(diag.category);
          if (!category) {
            continue;
          }
          const position =
            typeof diag.start === 'number'
              ? model.getPositionAt(diag.start)
              : { lineNumber: 1, column: 1 };
          diagnostics.push({
            file: path,
            line: position.lineNumber,
            column: position.column,
            message: flattenDiagnosticMessage(diag.messageText),
            category,
            code: diag.code,
          });
        }
      }

      diagnostics.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column
      );

      const summary: ScriptDiagnosticsSummary = {
        errorCount: diagnostics.filter(d => d.category === 'error').length,
        warningCount: diagnostics.filter(d => d.category === 'warning').length,
        filesChecked: models.length,
        diagnostics,
      };
      this.report(summary);
      return summary;
    } finally {
      for (const model of createdModels) {
        model.dispose();
      }
      // Restore the sibling mirrors for the models we removed.
      intelliSense.refreshNow();
    }
  }

  private report(summary: ScriptDiagnosticsSummary): void {
    this.lastSummary = summary;
    for (const listener of this.listeners) {
      listener(summary);
    }

    if (summary.errorCount === 0 && summary.warningCount === 0) {
      this.logger.info(
        `✓ Script check passed — no type errors in ${summary.filesChecked} file(s).`
      );
      return;
    }

    this.logger.warn(
      `Script check found ${summary.errorCount} error(s) and ${summary.warningCount} warning(s) ` +
        `across ${summary.filesChecked} file(s):`
    );
    for (const diag of summary.diagnostics) {
      const line = `${diag.file}:${diag.line}:${diag.column} — ${diag.message} (ts${diag.code})`;
      if (diag.category === 'error') {
        this.logger.error(line, diag);
      } else {
        this.logger.warn(line, diag);
      }
    }
  }

  private languageFor(path: string): string {
    return path.endsWith('.js') ? 'javascript' : 'typescript';
  }

  dispose(): void {
    if (this.autoCheckTimer !== null) {
      window.clearTimeout(this.autoCheckTimer);
      this.autoCheckTimer = null;
    }
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;
    this.initialized = false;
  }
}
