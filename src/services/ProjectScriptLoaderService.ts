import { injectable, inject } from '@/fw/di';
import { subscribe } from 'valtio/vanilla';

import { appState } from '@/state';
import { Script } from '@pix3/runtime';
import type { ScriptComponent } from '@pix3/runtime';
import { ProjectStorageService } from './ProjectStorageService';
import { ScriptRegistry } from '@pix3/runtime';
import type { PropertySchemaProvider } from '@pix3/runtime';
import { ScriptCompilerService } from './ScriptCompilerService';
import type { CompilationError } from './ScriptCompilerService';
import type { VirtualFileLoadContext } from './ScriptCompilerService';
import { ApiClientError } from './ApiClient';
import { LoggingService } from './LoggingService';
import { FileWatchService } from './FileWatchService';
import { isDocumentActive } from './page-activity';
import { ensureRapierLoaded } from '@/core/lazy-rapier';

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

  @inject(ScriptCompilerService)
  private readonly compiler!: ScriptCompilerService;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(FileWatchService)
  private readonly fileWatchService!: FileWatchService;

  private disposeSubscription?: () => void;
  private debounceTimer: number | null = null;
  private readonly debounceMs = 300;
  private readonly scriptDirectories = ['scripts', 'src/scripts'] as const;
  private readonly supportedSourceExtensions = ['.ts', '.js', '.css', '.glsl'] as const;
  private isPageActive = isDocumentActive(document);
  private pendingBuildWhileHidden = false;
  private readonly handlePageActivityChange = (): void => {
    this.isPageActive = isDocumentActive(document);
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

  // Enable auto-compilation
  enableAutoCompilation = true;

  constructor() {
    window.addEventListener('focus', this.handlePageActivityChange);
    window.addEventListener('blur', this.handlePageActivityChange);
    window.addEventListener('pageshow', this.handlePageActivityChange);
    window.addEventListener('pagehide', this.handlePageActivityChange);
    document.addEventListener('visibilitychange', this.handlePageActivityChange);

    let lastStatus = appState.project.status;

    // Watch for project status changes to trigger initial compilation
    this.disposeSubscription = subscribe(appState.project, () => {
      const currentStatus = appState.project.status;
      if (currentStatus === 'ready' && lastStatus !== 'ready' && this.enableAutoCompilation) {
        void this.syncAndBuild();
      }
      lastStatus = currentStatus;
    });
  }

  /**
   * Main workflow: Scan supported script directories, compile, and register.
   * This method is debounced to avoid excessive rebuilds.
   */
  async syncAndBuild(): Promise<void> {
    if (!this.isPageActive) {
      this.pendingBuildWhileHidden = true;
      return;
    }

    this.pendingBuildWhileHidden = false;
    appState.project.scriptsStatus = 'loading';

    // Clear existing debounce timer
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }

    // Debounce the build
    this.debounceTimer = window.setTimeout(() => {
      void this.performSyncAndBuild();
    }, this.debounceMs);
  }

  async ensureReady(): Promise<void> {
    if (appState.project.status !== 'ready') {
      return;
    }

    if (appState.project.scriptsStatus === 'ready' || appState.project.scriptsStatus === 'error') {
      return;
    }

    if (appState.project.scriptsStatus === 'idle') {
      await this.syncAndBuild();
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
   * Perform the actual sync and build workflow
   */
  private async performSyncAndBuild(): Promise<void> {
    try {
      appState.project.scriptsStatus = 'loading';
      this.logger.info('Compiling project scripts...');

      // Step 1: List all .ts files in supported script directories
      const { sourceFiles, checkedDirectories } = await this.collectScriptFiles();

      if (sourceFiles.length === 0) {
        this.logger.info(
          `No TypeScript files found in any script directory (${checkedDirectories.join(', ')})`
        );
        this.clearRegisteredScripts();
        appState.project.errorMessage = null;
        appState.project.scriptsStatus = 'ready';
        return;
      }

      this.logger.info(`Found ${sourceFiles.length} project source file(s), compiling...`);

      // Step 2: Read file contents into a Map and register watchers
      const filesMap = new Map<string, string>();
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
            if (handle) {
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
        } catch (error) {
          this.logger.error(`Failed to read ${file.path}`, error);
        }
      }

      if (filesMap.size === 0) {
        this.logger.warn('No script files could be read');
        appState.project.scriptsStatus = 'ready'; // Treat as ready but empty
        return;
      }

      const entryFiles = this.findComponentEntryFiles(filesMap);

      if (entryFiles.length === 0) {
        this.logger.info('No project Script components found to register');
        this.clearRegisteredScripts();
        appState.project.errorMessage = null;
        appState.project.scriptsStatus = 'ready';
        return;
      }

      // Step 3: Compile scripts using ScriptCompilerService
      let compilationResult;
      try {
        compilationResult = await this.compiler.bundle(
          filesMap,
          entryFiles,
          async (filePath, context) => this.loadBundledDependency(filePath, context)
        );
      } catch (error) {
        const userError = this.handleCompilationError(
          error as CompilationError,
          checkedDirectories
        );
        appState.project.errorMessage = userError;
        appState.project.scriptsStatus = 'error';
        return;
      }

      // Step 4: Load the compiled bundle
      await this.loadBundle(compilationResult.code);

      // Notify UI that scripts have been updated
      appState.project.scriptRefreshSignal++;
      appState.project.scriptsStatus = 'ready';

      this.logger.info(`✓ Scripts compiled and loaded successfully`);
    } catch (error) {
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
    const scriptId = `user:${className}`;

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
    context?: VirtualFileLoadContext
  ): Promise<string | null> {
    if (!this.isLoadableDependencyPath(filePath)) {
      return null;
    }

    try {
      const content = await this.storage.readTextFile(filePath);

      if (
        (filePath.endsWith('.ts') || filePath.endsWith('.js')) &&
        !this.watchedFilePaths.has(filePath)
      ) {
        try {
          const handle = await this.storage.getFileHandle(filePath);
          if (handle) {
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

      if (/extends\s+Script\b/.test(content)) {
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

    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.clearAll();
  }
}
