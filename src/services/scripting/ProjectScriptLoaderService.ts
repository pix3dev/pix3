import { injectable, inject } from '@/fw/di';
import { subscribe } from 'valtio/vanilla';

import { appState } from '@/state';
import {
  PROJECT_SCRIPT_DIRECTORIES,
  PROJECT_SCRIPT_ENTRY_PATTERN,
  Script,
  userScriptComponentId,
} from '@pix3/runtime';
import type { ScriptComponent } from '@pix3/runtime';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { ScriptRegistry, SceneManager } from '@pix3/runtime';
import type { PropertySchemaProvider } from '@pix3/runtime';
import { ScriptCompilerService } from '@/services/scripting/ScriptCompilerService';
import type { CompilationError } from '@/services/scripting/ScriptCompilerService';
import type { VirtualFileLoadContext } from '@/services/scripting/ScriptCompilerService';
import { ApiClientError } from '@/services/cloud/ApiClient';
import { LoggingService } from '@/services/core/LoggingService';
import { FileWatchService } from '@/services/project/FileWatchService';
import { isEditorActive, onEditorKeepAliveChange } from '@/services/core/page-activity';
import { keepaliveTimer } from '@/services/core/background-ticker';
import { ensureRapierLoaded } from '@/core/lazy-rapier';
import { sha256 } from '@/services/project/external-merge/hash';
import { clearScriptBuildErrors } from '@/core/agent-introspection';

/**
 * ProjectScriptLoaderService
 *
 * Manages the lifecycle of user-authored scripts in the project.
 * This service:
 * 1. Watches for changes to .ts files in supported script directories
 * 2. Compiles scripts using ScriptCompilerService (esbuild-wasm)
 * 3. Dynamically imports the compiled bundle
 * 4. Registers script classes in ScriptRegistry for use in the editor
 *
 * The compilation process is debounced to avoid excessive rebuilds during editing.
 */

@injectable()
export class ProjectScriptLoaderService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ScriptRegistry)
  private readonly scriptRegistry!: ScriptRegistry;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(ScriptCompilerService)
  private readonly compiler!: ScriptCompilerService;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(FileWatchService)
  private readonly fileWatchService!: FileWatchService;

  private disposeSubscription?: () => void;
  /** Cancel function of the pending debounced build (`keepaliveTimer`), or null. */
  private debounceTimer: (() => void) | null = null;
  private readonly debounceMs = 300;
  // Shared with `pix3 validate` (see `core/project-script-registration.ts` in the runtime).
  private readonly scriptDirectories = PROJECT_SCRIPT_DIRECTORIES;
  private readonly supportedSourceExtensions = ['.ts', '.js', '.css', '.glsl'] as const;
  /** Document active, or an agent keeps the editor alive: a background build is not deferred. */
  private isPageActive = isEditorActive(document);
  private pendingBuildWhileHidden = false;
  private disposeKeepAlive: (() => void) | null = null;
  private readonly handlePageActivityChange = (): void => {
    this.isPageActive = isEditorActive(document);
    if (!this.isPageActive || !this.pendingBuildWhileHidden) {
      return;
    }

    this.pendingBuildWhileHidden = false;
    void this.syncAndBuild();
  };

  // Track scripts from this project for cleanup
  private registeredScriptIds = new Set<string>();

  // Track watched files to avoid redundant watchers
  private watchedFilePaths = new Set<string>();

  // Last set of project source files read during a build (path -> contents).
  // Consumed by MonacoIntelliSenseService to mirror sibling files into the
  // code editor so relative imports resolve. Updated on every build.
  private lastCollectedFiles: Map<string, string> = new Map();

  /**
   * sha256 of the bytes behind each entry of {@link lastCollectedFiles} (path → hash), recorded as
   * each source was read — the workspace ETag of that very read, else the hash of the text. Lets
   * the agent channel's sync barrier name the exact revision of every build input without reading
   * any of them again.
   */
  private lastCollectedHashes: Map<string, string> = new Map();

  /** Project id the last build ran for — `scriptsStatus` alone cannot tell a stale ready apart. */
  private lastBuiltProjectId: string | null = null;

  /** Why the last build failed (null after a successful one) — the sync barrier reports it. */
  private lastBuildError: { file: string | null; line?: number; message: string } | null = null;

  /**
   * Bumped by every build that starts (and by the watchdog when it gives up on one). A build only
   * publishes its outcome — status, registered classes, error — while its generation is current,
   * so a build overtaken by a newer one (or abandoned as hung) cannot overwrite the newer result.
   */
  private buildGeneration = 0;

  /** The build chain running now; builds never overlap, a request during one queues a rerun. */
  private inflightBuild: Promise<void> | null = null;

  /** A build was requested while one was running: run once more when it finishes. */
  private rerunRequested = false;

  /**
   * A build was requested while the project's storage could not serve it (a `pix3 serve` workspace
   * that is connecting, reconnecting or gone). It runs as soon as the workspace is connected.
   */
  private waitingForStorage = false;

  /**
   * Upper bound of one build. A build that neither finishes nor fails (a request into a dead
   * tunnel, a wedged compiler) must not leave `scriptsStatus` at `loading` forever: every caller
   * of {@link ensureReady} — scene loads, `compile_scripts`, the agent's sync barrier — would
   * inherit the hang. On timeout the build is abandoned (its late result is ignored) and reported
   * as an error; the next trigger builds again.
   */
  buildTimeoutMs = 60_000;

  // Enable auto-compilation
  enableAutoCompilation = true;

  constructor() {
    window.addEventListener('focus', this.handlePageActivityChange);
    window.addEventListener('blur', this.handlePageActivityChange);
    window.addEventListener('pageshow', this.handlePageActivityChange);
    window.addEventListener('pagehide', this.handlePageActivityChange);
    document.addEventListener('visibilitychange', this.handlePageActivityChange);
    this.disposeKeepAlive = onEditorKeepAliveChange(this.handlePageActivityChange);

    let lastStatus = appState.project.status;
    let lastProjectId = appState.project.id;
    let lastWorkspaceStatus = appState.project.workspace.status;

    // Watch for project status changes to trigger initial compilation. The project ID is watched
    // too: creating or opening a project while another one is already open flips the id WITHOUT
    // ever leaving `ready`, so a status-only check skipped the build entirely and the new project
    // ran with the previous project's classes still registered (seen in Flow, where a prompt
    // builds a project on top of the open one: its scenes loaded with every `user:*` component
    // missing from the registry).
    //
    // A `pix3 serve` workspace adds one more trigger: the connection coming (back) up. A build
    // requested while it was down was deferred (see `canReadProjectStorage`), and a build that
    // failed may have failed only because it was down — both run again once it is connected.
    this.disposeSubscription = subscribe(appState.project, () => {
      const currentStatus = appState.project.status;
      const currentProjectId = appState.project.id;
      const workspaceStatus = appState.project.workspace.status;
      const becameReady = currentStatus === 'ready' && lastStatus !== 'ready';
      const switchedProject = currentStatus === 'ready' && currentProjectId !== lastProjectId;
      const workspaceConnected =
        currentStatus === 'ready' &&
        appState.project.backend === 'workspace' &&
        workspaceStatus === 'connected' &&
        lastWorkspaceStatus !== 'connected' &&
        (this.waitingForStorage || appState.project.scriptsStatus === 'error');
      if (currentProjectId !== lastProjectId) {
        // A build still running for the previous project must not publish into this one (nor
        // register its classes here): retire it. The switch's own build queues behind it.
        this.buildGeneration++;
      }
      if ((becameReady || switchedProject || workspaceConnected) && this.enableAutoCompilation) {
        void this.syncAndBuild();
      }
      lastStatus = currentStatus;
      lastProjectId = currentProjectId;
      lastWorkspaceStatus = workspaceStatus;
    });
  }

  /**
   * Main workflow: Scan supported script directories, compile, and register.
   * This method is debounced to avoid excessive rebuilds.
   *
   * `force` builds even when the page is hidden/unfocused. Background deferral is a CPU
   * courtesy, but an explicit caller that *waits* on the result (ensureReady before a scene
   * load, the agent's compile_scripts) must not be deferred — agent-driven sessions run in an
   * automation browser window that is visible yet never focused, and deferring there means
   * user scripts never register at all.
   */
  async syncAndBuild(options?: { force?: boolean }): Promise<void> {
    if (!this.isPageActive && !options?.force) {
      this.pendingBuildWhileHidden = true;
      return;
    }

    this.pendingBuildWhileHidden = false;

    if (!this.canReadProjectStorage()) {
      // Listing a workspace whose connection is down throws "No workspace is connected" (or talks
      // to the wrong server mid-switch). Defer to the reconnect instead; a caller that waits on the
      // result gets an answer now rather than a `loading` that nothing will ever finish.
      this.waitingForStorage = true;
      if (options?.force) {
        this.publishStorageUnavailable();
      }
      return;
    }
    this.waitingForStorage = false;
    appState.project.scriptsStatus = 'loading';

    // Clear existing debounce timer
    if (this.debounceTimer !== null) {
      this.debounceTimer();
      this.debounceTimer = null;
    }

    if (options?.force) {
      // A caller that waits on the build is not an editing burst: build now. Debouncing it also let
      // a series of waiting callers (the sync barrier, compile_scripts) push the timer forward
      // indefinitely — and a background tab throttles that timer to once a minute.
      await this.runBuild();
      return;
    }

    // Debounce the build
    this.debounceTimer = keepaliveTimer(() => {
      this.debounceTimer = null;
      void this.runBuild();
    }, this.debounceMs);
  }

  /**
   * Run a build, never two at once. A request while one runs makes that chain build once more
   * (the files it read may already be outdated) and resolves when the rerun is done.
   */
  private runBuild(): Promise<void> {
    if (this.inflightBuild) {
      this.rerunRequested = true;
      return this.inflightBuild;
    }
    const chain = (async () => {
      try {
        do {
          this.rerunRequested = false;
          await this.performSyncAndBuildWithTimeout();
        } while (this.rerunRequested);
      } finally {
        this.inflightBuild = null;
      }
    })();
    this.inflightBuild = chain;
    return chain;
  }

  private async performSyncAndBuildWithTimeout(): Promise<void> {
    const build = this.performSyncAndBuild();
    let timer: number | null = null;
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = window.setTimeout(() => resolve('timeout'), this.buildTimeoutMs);
    });
    try {
      const outcome = await Promise.race([build.then(() => 'done' as const), timedOut]);
      if (outcome === 'timeout') {
        // Abandon it: bumping the generation makes whatever it eventually produces a no-op.
        this.buildGeneration++;
        const message = `Script build did not finish within ${Math.round(this.buildTimeoutMs / 1000)} s and was abandoned; it runs again on the next change or compile.`;
        this.lastBuildError = { file: null, message };
        appState.project.errorMessage = message;
        appState.project.scriptsStatus = 'error';
        this.logger.error(message);
        // The abandoned build still settles some day; nothing may await it.
        build.catch(() => undefined);
      }
    } finally {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
  }

  /**
   * Whether the project's files can be listed right now. Only a `pix3 serve` workspace can be open
   * without being readable: between `connect()` of a new workspace and the project switch, while
   * the socket reconnects, or after the server went away.
   */
  private canReadProjectStorage(): boolean {
    return (
      appState.project.backend !== 'workspace' || appState.project.workspace.status === 'connected'
    );
  }

  private publishStorageUnavailable(): void {
    const message =
      'The workspace server is not connected; project scripts build again once it reconnects.';
    this.lastBuiltProjectId = appState.project.id;
    this.lastBuildError = { file: null, message };
    appState.project.scriptsStatus = 'error';
  }

  /**
   * The project source files (path → contents) read during the most recent
   * build. Used by the code editor to mirror sibling scripts for IntelliSense.
   */
  getCollectedFiles(): ReadonlyMap<string, string> {
    return this.lastCollectedFiles;
  }

  /**
   * sha256 of every source the most recent build read (the entry sources AND every module the
   * bundle pulled in), keyed like {@link getCollectedFiles}.
   */
  getCollectedFileHashes(): ReadonlyMap<string, string> {
    return this.lastCollectedHashes;
  }

  /** The error of the most recent build, or null when it compiled (or has not run). */
  getLastBuildError(): { file: string | null; line?: number; message: string } | null {
    return this.lastBuildError;
  }

  async ensureReady(): Promise<void> {
    if (appState.project.status !== 'ready') {
      return;
    }

    // A `ready` status left over from the PREVIOUS project is worse than no status at all: the
    // caller (a scene load) would proceed against the old project's registered classes. Compare
    // what was actually built against the project we are in now.
    const isStale = this.lastBuiltProjectId !== appState.project.id;

    if (
      !isStale &&
      (appState.project.scriptsStatus === 'ready' || appState.project.scriptsStatus === 'error')
    ) {
      return;
    }

    // A `loading` with no build running or scheduled is orphaned (e.g. a deferred build whose
    // storage never came back): waiting on it would only ever end in the timeout below.
    const orphanedLoading =
      appState.project.scriptsStatus === 'loading' &&
      this.inflightBuild === null &&
      this.debounceTimer === null;

    if (
      isStale ||
      orphanedLoading ||
      appState.project.scriptsStatus === 'idle' ||
      this.pendingBuildWhileHidden
    ) {
      // Not awaited: the build is bounded by its own watchdog, this wait by the 15 s below.
      void this.syncAndBuild({ force: true });
    }

    await new Promise<void>(resolve => {
      if (
        appState.project.scriptsStatus === 'ready' ||
        appState.project.scriptsStatus === 'error'
      ) {
        resolve();
        return;
      }

      const timeoutId = window.setTimeout(() => {
        unsubscribe();
        this.logger.warn('Timed out waiting for project scripts to finish loading');
        resolve();
      }, 15000);

      const unsubscribe = subscribe(appState.project, () => {
        if (
          appState.project.scriptsStatus === 'ready' ||
          appState.project.scriptsStatus === 'error'
        ) {
          window.clearTimeout(timeoutId);
          unsubscribe();
          resolve();
        }
      });
    });
  }

  /**
   * Perform the actual sync and build workflow.
   *
   * Every exit publishes a final `scriptsStatus` (`ready` or `error`) — including a thrown storage
   * error — unless the build was overtaken (see {@link buildGeneration}) or a rerun is queued, in
   * which case the newer build publishes. Nothing here may leave `loading` behind.
   */
  private async performSyncAndBuild(): Promise<void> {
    const generation = ++this.buildGeneration;
    /** Still the newest build: allowed to touch the registry. */
    const isCurrent = (): boolean => generation === this.buildGeneration;
    /** Allowed to publish a final status (a queued rerun publishes instead). */
    const mayPublish = (): boolean => isCurrent() && !this.rerunRequested;
    const publish = (
      status: 'ready' | 'error',
      options: { errorMessage?: string | null; refreshSignal?: boolean } = {}
    ): void => {
      if (!mayPublish()) {
        return;
      }
      if (options.errorMessage !== undefined) {
        appState.project.errorMessage = options.errorMessage;
      }
      if (options.refreshSignal) {
        appState.project.scriptRefreshSignal++;
      }
      appState.project.scriptsStatus = status;
      // A build that succeeded supersedes every captured build failure: `read_errors` otherwise
      // kept answering with a syntax error the agent had already fixed.
      if (status === 'ready') clearScriptBuildErrors();
    };

    try {
      appState.project.scriptsStatus = 'loading';
      this.lastBuiltProjectId = appState.project.id;
      this.lastBuildError = null;

      // The debounce may fire after the workspace connection dropped (or mid-switch).
      if (!this.canReadProjectStorage()) {
        this.waitingForStorage = true;
        if (mayPublish()) {
          this.publishStorageUnavailable();
        }
        return;
      }

      this.logger.info('Compiling project scripts...');

      // Step 1: List all .ts files in supported script directories
      const { sourceFiles, checkedDirectories } = await this.collectScriptFiles();
      if (!isCurrent()) {
        return;
      }

      if (sourceFiles.length === 0) {
        this.logger.info(
          `No TypeScript files found in any script directory (${checkedDirectories.join(', ')})`
        );
        this.lastCollectedFiles = new Map();
        this.lastCollectedHashes = new Map();
        this.clearRegisteredScripts();
        publish('ready', { errorMessage: null });
        return;
      }

      this.logger.info(`Found ${sourceFiles.length} project source file(s), compiling...`);

      // Step 2: Read file contents into a Map and register watchers
      const filesMap = new Map<string, string>();
      const hashes = new Map<string, string>();
      const currentFiles = new Set(sourceFiles.map(f => f.path));

      // Remove watchers for files that are no longer present
      for (const watchedPath of this.watchedFilePaths) {
        if (!currentFiles.has(watchedPath)) {
          this.fileWatchService.unwatch(watchedPath);
          this.watchedFilePaths.delete(watchedPath);
        }
      }

      for (const file of sourceFiles) {
        // Register watcher if not already watching
        if (!this.watchedFilePaths.has(file.path)) {
          try {
            const handle = await this.storage.getFileHandle(file.path);
            if (handle || this.fileWatchService.isPushMode()) {
              this.fileWatchService.watch(file.path, handle, undefined, () => {
                void this.syncAndBuild();
              });
              this.watchedFilePaths.add(file.path);
            }
          } catch (error) {
            this.logger.error(`Failed to register watcher for ${file.path}`, error);
          }
        }

        try {
          const content = await this.storage.readTextFile(file.path);
          filesMap.set(file.path, content);
          hashes.set(file.path, await this.readHash(file.path, content));
        } catch (error) {
          this.logger.error(`Failed to read ${file.path}`, error);
        }
      }
      if (!isCurrent()) {
        return;
      }

      if (filesMap.size === 0) {
        this.logger.warn('No script files could be read');
        this.lastCollectedFiles = new Map();
        this.lastCollectedHashes = new Map();
        publish('ready'); // Treat as ready but empty
        return;
      }

      // Expose the collected sources (mutated in place with lazily-loaded
      // dependencies during bundling) for the code editor's sibling mirroring.
      this.lastCollectedFiles = filesMap;
      this.lastCollectedHashes = hashes;

      const entryFiles = this.findComponentEntryFiles(filesMap);

      if (entryFiles.length === 0) {
        this.logger.info('No project Script components found to register');
        this.clearRegisteredScripts();
        publish('ready', { errorMessage: null });
        return;
      }

      // Step 3: Compile scripts using ScriptCompilerService
      let compilationResult;
      try {
        compilationResult = await this.compiler.bundle(
          filesMap,
          entryFiles,
          async (filePath, context) => this.loadBundledDependency(filePath, context, hashes)
        );
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        const compilation = error as CompilationError;
        this.lastBuildError = {
          file: compilation.file ?? null,
          ...(typeof compilation.line === 'number' ? { line: compilation.line } : {}),
          message: compilation.message ?? String(error),
        };
        const userError = this.handleCompilationError(compilation, checkedDirectories);
        publish('error', { errorMessage: userError });
        return;
      }
      if (!isCurrent()) {
        return;
      }

      // Step 4: Load the compiled bundle
      await this.loadBundle(compilationResult.code);

      // Step 5: scenes open before their scripts finish compiling (nothing gates a scene load on
      // `scriptsStatus`, and recipe projects open a scene immediately), so `user:*` components in
      // those scenes were unresolved at load time and are parked on their nodes. Now that the types
      // exist, attach them — otherwise they stay invisible and the next save writes the scene file
      // without them.
      this.attachPendingSceneComponents();

      // Notify UI that scripts have been updated
      publish('ready', { refreshSignal: true });

      this.logger.info(`✓ Scripts compiled and loaded successfully`);
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      this.lastBuildError = {
        file: null,
        message: error instanceof Error ? error.message : String(error),
      };
      // Always settle, even when a rerun is queued: the rerun overwrites it, and a waiter must not
      // be left on `loading` if that rerun is itself deferred.
      appState.project.scriptsStatus = 'error';
      this.logger.error('Failed to compile scripts', error);
    }
  }

  /**
   * Load a compiled JavaScript bundle and register its exports
   */
  private async loadBundle(code: string): Promise<void> {
    if (!code || code.trim().length === 0) {
      console.log('[ProjectScriptLoader] Empty bundle, nothing to load');
      return;
    }

    // Rapier is lazy-loaded so it does not bloat the editor's main chunk.
    // The runtime importmap shim for `@dimforge/rapier3d-compat` resolves to
    // window.__RAPIER__, so it must be populated before the user bundle is
    // dynamically imported.
    if (this.bundleReferencesRapier(code)) {
      try {
        await ensureRapierLoaded();
      } catch (error) {
        this.logger.error('Failed to load rapier physics runtime', error);
        throw error;
      }
    }

    // Create a blob URL from the compiled code
    const blob = new Blob([code], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);

    try {
      // Dynamically import the module
      const module = await import(/* @vite-ignore */ blobUrl);

      // Clear previously registered scripts
      this.clearRegisteredScripts();

      // Iterate through exports and register script classes
      for (const [exportName, exported] of Object.entries(module)) {
        if (typeof exported === 'object' && exported !== null) {
          // Each export is a namespace containing the classes from that file
          for (const [className, classValue] of Object.entries(exported)) {
            this.tryRegisterScriptClass(className, classValue, exportName);
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to load compiled bundle', error);
      throw error;
    } finally {
      // Clean up blob URL
      URL.revokeObjectURL(blobUrl);
    }
  }

  private bundleReferencesRapier(code: string): boolean {
    return code.includes('@dimforge/rapier3d-compat') || code.includes('@dimforge/');
  }

  /**
   * Try to register a class as a Script component
   */
  private tryRegisterScriptClass(className: string, classValue: unknown, sourceFile: string): void {
    // Check if it's a class constructor
    if (typeof classValue !== 'function') {
      return;
    }

    const ctor = classValue as unknown as { prototype?: object; getPropertySchema?: unknown };

    // Check if it has getPropertySchema static method (our marker for script classes)
    if (typeof (ctor as { getPropertySchema?: unknown }).getPropertySchema !== 'function') {
      return;
    }

    // Check if it extends Script by checking prototype chain
    const isScript = this.isSubclassOf(ctor, Script);

    if (!isScript) {
      console.warn(
        `[ProjectScriptLoader] ${className} has getPropertySchema but doesn't extend Script`
      );
      return;
    }

    // Create unique ID for this script
    const scriptId = userScriptComponentId(className);

    // Cast the dynamic constructor to the expected registry type
    const typedCtor = ctor as unknown as (new (id: string, type: string) => ScriptComponent) &
      PropertySchemaProvider;

    this.scriptRegistry.registerComponent({
      id: scriptId,
      displayName: className,
      description: `Project component from ${sourceFile}`,
      category: 'Project',
      componentClass: typedCtor,
      keywords: ['project', 'component', className.toLowerCase(), sourceFile.toLowerCase()],
    });

    this.registeredScriptIds.add(scriptId);
    this.logger.info(`Registered component: ${className}`);
  }

  /**
   * Check if a constructor is a subclass of a base class
   */
  private isSubclassOf(ctor: unknown, baseClass: unknown): boolean {
    try {
      // Ensure both values are callable constructors at runtime
      if (typeof ctor !== 'function' || typeof baseClass !== 'function') return false;

      // Walk the prototype chain to correctly detect subclassing for both
      // regular and abstract class constructors.
      let currentProto = (ctor as { prototype?: object }).prototype;
      const baseProto = (baseClass as { prototype?: object }).prototype;
      while (currentProto) {
        if (currentProto === baseProto) return true;
        currentProto = Object.getPrototypeOf(currentProto);
      }
      return ctor === baseClass;
    } catch {
      return false;
    }
  }

  /**
   * Clear all scripts registered by this service
   */
  private clearRegisteredScripts(): void {
    for (const scriptId of this.registeredScriptIds) {
      this.scriptRegistry.unregisterComponent(scriptId);
    }
    this.registeredScriptIds.clear();
  }

  /**
   * Attach scene components that were parked because their script type was not registered when the
   * scene loaded. Best-effort: a failure here must not fail the compile that succeeded.
   */
  private attachPendingSceneComponents(): void {
    try {
      const attached = this.sceneManager.resolvePendingComponents();
      if (attached > 0) {
        this.logger.info(
          `Attached ${attached} scene component(s) that were waiting for their script type`
        );
      }
    } catch (error) {
      this.logger.error('Failed to attach pending scene components', error);
    }
  }

  /**
   * Clear all scripts and stop watching files
   */
  private clearAll(): void {
    this.clearRegisteredScripts();

    // Clear watchers
    for (const filePath of this.watchedFilePaths) {
      this.fileWatchService.unwatch(filePath);
    }
    this.watchedFilePaths.clear();
  }
  private async collectScriptFiles(): Promise<{
    sourceFiles: Array<{ name: string; kind: FileSystemHandleKind; path: string }>;
    checkedDirectories: readonly string[];
  }> {
    const sourceFiles = new Map<
      string,
      { name: string; kind: FileSystemHandleKind; path: string }
    >();

    for (const directory of this.scriptDirectories) {
      try {
        const entries = await this.collectFilesRecursively(directory);
        for (const entry of entries) {
          if (this.isSupportedSourceFile(entry.name)) {
            sourceFiles.set(entry.path, entry);
          }
        }
      } catch (error) {
        if (this.isDirectoryNotFoundError(error)) {
          continue;
        }
        throw error;
      }
    }

    return {
      sourceFiles: Array.from(sourceFiles.values()),
      checkedDirectories: this.scriptDirectories,
    };
  }

  private async loadBundledDependency(
    filePath: string,
    context?: VirtualFileLoadContext,
    hashes?: Map<string, string>
  ): Promise<string | null> {
    if (!this.isLoadableDependencyPath(filePath)) {
      return null;
    }

    try {
      const content = await this.storage.readTextFile(filePath);
      hashes?.set(filePath, await this.readHash(filePath, content));

      if (
        (filePath.endsWith('.ts') || filePath.endsWith('.js')) &&
        !this.watchedFilePaths.has(filePath)
      ) {
        try {
          const handle = await this.storage.getFileHandle(filePath);
          if (handle || this.fileWatchService.isPushMode()) {
            this.fileWatchService.watch(filePath, handle, undefined, () => {
              void this.syncAndBuild();
            });
            this.watchedFilePaths.add(filePath);
          }
        } catch (error) {
          this.logger.error(`Failed to register watcher for ${filePath}`, error);
        }
      }

      return content;
    } catch (error) {
      this.reportBundledDependencyLoadFailure(filePath, context, error);
      return null;
    }
  }

  private reportBundledDependencyLoadFailure(
    filePath: string,
    context: VirtualFileLoadContext | undefined,
    error: unknown
  ): void {
    const requestedImport = context?.requestedImportPath ?? filePath;
    const importer = context?.importer?.trim() || null;
    const message = importer
      ? `Script dependency fetch failed: tried ${filePath} while resolving ${requestedImport} from ${importer}`
      : `Script dependency fetch failed: tried ${filePath} while resolving ${requestedImport}`;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorData = {
      attemptedPath: filePath,
      requestedImport,
      importer,
      namespace: context?.namespace ?? null,
      status: error instanceof ApiClientError ? error.status : null,
      message: errorMessage,
    };

    if (error instanceof ApiClientError && error.status === 404) {
      this.logger.warn(message, errorData);
      return;
    }

    this.logger.error(message, errorData);
  }

  /**
   * The hash of what `readTextFile(path)` just returned: the workspace ETag of that read (the hash
   * of the exact bytes, BOM included), else sha256 of the text.
   */
  private async readHash(path: string, content: string): Promise<string> {
    return this.storage.getKnownContentHash?.(path) ?? (await sha256(content));
  }

  private async collectFilesRecursively(
    directory: string
  ): Promise<Array<{ name: string; kind: FileSystemHandleKind; path: string }>> {
    const entries = await this.storage.listDirectory(directory);
    const collected: Array<{ name: string; kind: FileSystemHandleKind; path: string }> = [];

    for (const entry of entries) {
      if (entry.kind === 'file') {
        collected.push(entry);
        continue;
      }

      if (entry.kind === 'directory') {
        collected.push(...(await this.collectFilesRecursively(entry.path)));
      }
    }

    return collected;
  }

  private isSupportedSourceFile(fileName: string): boolean {
    return this.supportedSourceExtensions.some(extension => fileName.endsWith(extension));
  }

  private isLoadableDependencyPath(filePath: string): boolean {
    return (
      filePath.endsWith('.ts') ||
      filePath.endsWith('.js') ||
      filePath.endsWith('.css') ||
      filePath.endsWith('.glsl') ||
      filePath.endsWith('.frag') ||
      filePath.endsWith('.vert')
    );
  }

  private findComponentEntryFiles(files: Map<string, string>): string[] {
    const entryFiles: string[] = [];

    for (const [filePath, content] of files) {
      if (
        !(filePath.endsWith('.ts') || filePath.endsWith('.js')) ||
        !this.isWithinScriptDirectory(filePath)
      ) {
        continue;
      }

      if (PROJECT_SCRIPT_ENTRY_PATTERN.test(content)) {
        entryFiles.push(filePath);
      }
    }

    return entryFiles;
  }

  private isWithinScriptDirectory(filePath: string): boolean {
    return this.scriptDirectories.some(
      directory => filePath === directory || filePath.startsWith(`${directory}/`)
    );
  }

  private isDirectoryNotFoundError(error: unknown): boolean {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: unknown }).code === 'not-found'
    );
  }

  /**
   * Handle compilation errors by logging and displaying to user
   */
  private handleCompilationError(
    error: CompilationError,
    checkedDirectories: readonly string[]
  ): string {
    const location = error.file
      ? `${error.file}:${error.line ?? '?'}:${error.column ?? '?'}`
      : 'unknown location';

    const checked = checkedDirectories.join(', ');
    const errorMessage = `Compilation failed at ${location}: ${error.message}`;
    const userMessage = `${errorMessage}. Checked script directories: ${checked}. Keep project scripts in one of these folders.`;
    this.logger.error(userMessage, error.details);
    return userMessage;
  }

  dispose(): void {
    this.disposeSubscription?.();
    window.removeEventListener('focus', this.handlePageActivityChange);
    window.removeEventListener('blur', this.handlePageActivityChange);
    window.removeEventListener('pageshow', this.handlePageActivityChange);
    window.removeEventListener('pagehide', this.handlePageActivityChange);
    document.removeEventListener('visibilitychange', this.handlePageActivityChange);
    this.disposeKeepAlive?.();
    this.disposeKeepAlive = null;

    if (this.debounceTimer !== null) {
      this.debounceTimer();
      this.debounceTimer = null;
    }

    this.clearAll();
  }
}
