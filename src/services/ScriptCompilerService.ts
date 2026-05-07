/**
 * ScriptCompilerService
 *
 * Handles in-browser compilation of user TypeScript scripts using esbuild-wasm.
 * This service bundles user scripts into ESM modules that can be dynamically imported
 * and registered with the ScriptRegistry.
 *
 * The compilation process:
 * 1. Initialize esbuild-wasm with the WASM binary
 * 2. Accept a map of filenames to TypeScript source code
 * 3. Create a virtual entry point that exports all scripts
 * 4. Use esbuild to bundle with '@pix3/runtime' marked as external
 * 5. Return the compiled JavaScript code ready for dynamic import
 */

import { injectable, inject } from '@/fw/di';
import * as esbuild from 'esbuild-wasm';
import { LoggingService } from './LoggingService';

export interface CompilationResult {
  /** Compiled JavaScript code as ESM module */
  code: string;
  /** Any warnings from the compilation */
  warnings: string[];
}

export type VirtualNamespace = 'virtual-fs' | 'virtual-raw' | 'virtual-url' | 'virtual-css';

export interface CompilationError {
  message: string;
  /** File where the error occurred */
  file?: string;
  /** Line number in the file */
  line?: number;
  /** Column number in the file */
  column?: number;
  /** Full error details for debugging */
  details?: unknown;
}

export interface VirtualFileLoadContext {
  importer: string;
  requestedImportPath: string;
  namespace: VirtualNamespace;
}

type VirtualFileLoader = (
  filePath: string,
  context: VirtualFileLoadContext
) => Promise<string | null>;

@injectable()
export class ScriptCompilerService {
  @inject(LoggingService)
  private readonly logger!: LoggingService;

  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize esbuild-wasm by loading the WASM binary.
   * This must be called before any compilation can occur.
   * Safe to call multiple times - will only initialize once.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        this.logger.info('Initializing script compiler...');
        await esbuild.initialize({
          wasmURL: '/esbuild.wasm',
          worker: true,
        });
        this.initialized = true;
        this.logger.info('Script compiler initialized successfully');
      } catch (error) {
        this.logger.error('Failed to initialize script compiler', error);
        throw new Error(`Failed to initialize script compiler: ${error}`);
      }
    })();

    return this.initPromise;
  }

  /**
   * Bundle user scripts from a virtual file system.
   * @param files Map of file paths to their TypeScript content
   * @returns Compilation result with bundled code or throws CompilationError
   */
  async bundle(
    files: Map<string, string>,
    entryFiles?: string[],
    fileLoader?: VirtualFileLoader
  ): Promise<CompilationResult> {
    if (!this.initialized) {
      await this.init();
    }

    if (files.size === 0) {
      return { code: '', warnings: [] };
    }

    const effectiveEntryFiles = (
      entryFiles ??
      Array.from(files.keys()).filter(file => file.endsWith('.ts') || file.endsWith('.js'))
    ).filter(file => files.has(file));

    if (effectiveEntryFiles.length === 0) {
      return { code: '', warnings: [] };
    }

    // Create a virtual entry point that exports all entry files
    const entryPoint = this.createEntryPoint(effectiveEntryFiles);

    try {
      const result = await esbuild.build({
        stdin: {
          contents: entryPoint,
          resolveDir: '/',
          sourcefile: 'entry.ts',
          loader: 'ts',
        },
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        define: {
          'import.meta.env.BASE_URL': JSON.stringify('/'),
          'import.meta.env.DEV': 'true',
          'import.meta.env.PROD': 'false',
        },
        external: [
          '@pix3/runtime',
          'three',
          'three/*',
          '@dimforge/rapier3d-compat',
          '@dimforge/*',
          'ios-haptics',
        ],
        write: false,
        logLevel: 'silent',
        plugins: [this.createVirtualFileSystemPlugin(files, fileLoader)],
      });

      const warnings = result.warnings.map(w => this.formatMessage(w));
      const code = result.outputFiles?.[0]?.text ?? '';

      if (warnings.length > 0) {
        warnings.forEach(warning => this.logger.warn(`Script compilation warning: ${warning}`));
      }

      this.logger.info(`Scripts compiled successfully (${files.size} files, ${code.length} bytes)`);

      return { code, warnings };
    } catch (error: unknown) {
      const compilationError = this.parseCompilationError(error);
      this.logger.error(`Script compilation failed: ${compilationError.message}`, compilationError);
      throw compilationError;
    }
  }

  /**
   * Create a virtual entry point that imports and re-exports all user scripts
   */
  private createEntryPoint(entryFiles: string[]): string {
    const exports: string[] = [];

    for (const filePath of entryFiles) {
      // Preserve the full virtual path so entry imports resolve the same way as
      // every other relative import inside the bundle.
      const importPath = `./${filePath}`.replace(/\.ts$/, '');

      const exportName = this.pathToExportName(filePath);
      exports.push(`export * as ${exportName} from '${importPath}';`);
    }

    return exports.join('\n');
  }

  /**
   * Convert a file path to a valid JavaScript export name
   */
  private pathToExportName(filePath: string): string {
    return filePath.replace(/\.ts$/, '').replace(/[^a-zA-Z0-9_]/g, '_');
  }

  /**
   * Create esbuild plugin for virtual file system
   */
  private createVirtualFileSystemPlugin(
    files: Map<string, string>,
    fileLoader?: VirtualFileLoader
  ): esbuild.Plugin {
    return {
      name: 'virtual-fs',
      setup: build => {
        build.onResolve({ filter: /.*/ }, args => {
          return (async () => {
            if (this.isExternalModule(args.path)) {
              return { path: args.path, external: true };
            }

            // Resolve relative imports against the importing virtual file.
            if (args.path.startsWith('./') || args.path.startsWith('../')) {
              const resolved = await this.resolveVirtualImport(
                args.path,
                args.importer,
                files,
                fileLoader
              );
              if (resolved) {
                return {
                  ...resolved,
                  pluginData: {
                    importer: args.importer,
                    requestedImportPath: args.path,
                    namespace: resolved.namespace,
                  },
                };
              }

              return {
                path: this.resolveUnresolvedPath(args.path, args.importer),
                namespace: 'virtual-fs',
                pluginData: {
                  importer: args.importer,
                  requestedImportPath: args.path,
                  namespace: 'virtual-fs',
                },
              };
            }

            return { path: args.path, external: true };
          })();
        });

        // Load file contents from virtual FS
        build.onLoad({ filter: /.*/, namespace: 'virtual-fs' }, async args => {
          let contents = files.get(args.path);
          const context = this.getVirtualFileLoadContext(args.pluginData, args.path, 'virtual-fs');

          if (contents === undefined && fileLoader) {
            contents = (await fileLoader(args.path, context)) ?? undefined;
            if (contents !== undefined) {
              files.set(args.path, contents);
            }
          }

          if (contents === undefined) {
            return {
              errors: [
                {
                  text: `File not found: ${args.path}`,
                  location: null,
                },
              ],
            };
          }

          return {
            contents: this.rewriteVirtualAssetUrls(contents, args.path),
            loader: 'ts',
          };
        });

        build.onLoad({ filter: /.*/, namespace: 'virtual-raw' }, async args => {
          let contents = files.get(args.path);
          const context = this.getVirtualFileLoadContext(args.pluginData, args.path, 'virtual-raw');

          if (contents === undefined && fileLoader) {
            contents = (await fileLoader(args.path, context)) ?? undefined;
            if (contents !== undefined) {
              files.set(args.path, contents);
            }
          }

          if (contents === undefined) {
            return {
              errors: [
                {
                  text: `File not found: ${args.path}`,
                  location: null,
                },
              ],
            };
          }

          return {
            contents: `export default ${JSON.stringify(contents)};`,
            loader: 'js',
          };
        });

        build.onLoad({ filter: /.*/, namespace: 'virtual-url' }, args => ({
          contents: `export default ${JSON.stringify(`res://${args.path}`)};`,
          loader: 'js',
        }));

        build.onLoad({ filter: /.*/, namespace: 'virtual-css' }, () => ({
          contents: 'export {};',
          loader: 'js',
        }));
      },
    };
  }

  private isExternalModule(path: string): boolean {
    return (
      path.startsWith('@pix3/') ||
      path === 'three' ||
      path.startsWith('three/') ||
      path.startsWith('@dimforge/') ||
      path === 'ios-haptics'
    );
  }

  private resolveVirtualImport(
    importPath: string,
    importer: string,
    files: Map<string, string>,
    fileLoader?: VirtualFileLoader
  ): Promise<{ path: string; namespace: VirtualNamespace } | null> {
    const querySuffix = importPath.endsWith('?raw')
      ? '?raw'
      : importPath.endsWith('?url')
        ? '?url'
        : '';
    const cleanImportPath = querySuffix ? importPath.slice(0, -querySuffix.length) : importPath;
    const resolvedBasePath = this.resolveUnresolvedPath(cleanImportPath, importer);
    const candidateBasePaths = this.getImportCandidateBasePaths(resolvedBasePath);

    if (querySuffix === '?url') {
      const assetPath =
        this.findExistingPath(candidateBasePaths[0] ?? resolvedBasePath, [''], files) ??
        this.findFirstExistingPath(candidateBasePaths, [''], files) ??
        resolvedBasePath;
      return Promise.resolve({ path: assetPath, namespace: 'virtual-url' });
    }

    if (querySuffix === '?raw') {
      return this.resolveLoadableVirtualPath(
        candidateBasePaths,
        [''],
        'virtual-raw',
        importer,
        importPath,
        files,
        fileLoader
      );
    }

    if (cleanImportPath.endsWith('.css')) {
      return this.resolveLoadableVirtualPath(
        candidateBasePaths,
        [''],
        'virtual-css',
        importer,
        importPath,
        files,
        fileLoader,
        resolvedBasePath
      );
    }

    const resolvedTsPath = this.findFirstExistingPath(
      candidateBasePaths,
      ['', '.ts', '/index.ts'],
      files
    );
    if (resolvedTsPath) {
      return Promise.resolve({ path: resolvedTsPath, namespace: 'virtual-fs' });
    }

    return this.resolveLoadableVirtualPath(
      candidateBasePaths,
      ['', '.ts', '/index.ts'],
      'virtual-fs',
      importer,
      importPath,
      files,
      fileLoader
    );
  }

  private getImportCandidateBasePaths(basePath: string): string[] {
    const candidates = [this.normalizePath(basePath)];

    if (basePath.startsWith('src/scripts/')) {
      candidates.push(this.normalizePath(`src/${basePath.slice('src/scripts/'.length)}`));
    }

    if (basePath.startsWith('scripts/')) {
      candidates.push(this.normalizePath(basePath.slice('scripts/'.length)));
    }

    return Array.from(new Set(candidates));
  }

  private findFirstExistingPath(
    basePaths: string[],
    suffixes: string[],
    files?: Map<string, string>
  ): string | null {
    for (const basePath of basePaths) {
      const match = this.findExistingPath(basePath, suffixes, files);
      if (match) {
        return match;
      }
    }

    return null;
  }

  private findExistingPath(
    basePath: string,
    suffixes: string[],
    files?: Map<string, string>
  ): string | null {
    for (const suffix of suffixes) {
      const candidate = this.normalizePath(`${basePath}${suffix}`);
      if (!files || files.has(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private async resolveLoadableVirtualPath(
    basePaths: string[],
    suffixes: string[],
    namespace: VirtualNamespace,
    importer: string,
    requestedImportPath: string,
    files: Map<string, string>,
    fileLoader?: VirtualFileLoader,
    fallbackPath?: string
  ): Promise<{ path: string; namespace: VirtualNamespace } | null> {
    if (fileLoader) {
      for (const basePath of basePaths) {
        for (const suffix of suffixes) {
          const candidate = this.normalizePath(`${basePath}${suffix}`);
          if (files.has(candidate)) {
            return { path: candidate, namespace };
          }

          const loaded = await fileLoader(candidate, {
            importer,
            requestedImportPath,
            namespace,
          });
          if (loaded !== null) {
            files.set(candidate, loaded);
            return { path: candidate, namespace };
          }
        }
      }
    }

    if (fallbackPath) {
      return { path: fallbackPath, namespace };
    }

    return null;
  }

  private resolveUnresolvedPath(importPath: string, importer: string): string {
    const importerDirectory = importer ? this.getDirectoryName(importer) : '';
    return this.normalizePath(
      importerDirectory ? `${importerDirectory}/${importPath}` : importPath
    );
  }

  private getVirtualFileLoadContext(
    pluginData: unknown,
    filePath: string,
    namespace: VirtualNamespace
  ): VirtualFileLoadContext {
    if (typeof pluginData !== 'object' || pluginData === null) {
      return {
        importer: '',
        requestedImportPath: filePath,
        namespace,
      };
    }

    const candidate = pluginData as Partial<VirtualFileLoadContext>;
    return {
      importer: typeof candidate.importer === 'string' ? candidate.importer : '',
      requestedImportPath:
        typeof candidate.requestedImportPath === 'string'
          ? candidate.requestedImportPath
          : filePath,
      namespace:
        candidate.namespace === 'virtual-fs' ||
        candidate.namespace === 'virtual-raw' ||
        candidate.namespace === 'virtual-url' ||
        candidate.namespace === 'virtual-css'
          ? candidate.namespace
          : namespace,
    };
  }

  private rewriteVirtualAssetUrls(contents: string, filePath: string): string {
    return contents.replace(
      /new URL\((['"])([^'"]+)\1,\s*import\.meta\.url\)\.href/g,
      (_match, _quote: string, relativePath: string) => {
        const absolutePath = this.resolveUnresolvedPath(relativePath, filePath);
        return JSON.stringify(`res://${absolutePath}`);
      }
    );
  }

  private getDirectoryName(filePath: string): string {
    const normalizedPath = this.normalizePath(filePath);
    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    return lastSlashIndex >= 0 ? normalizedPath.slice(0, lastSlashIndex) : '';
  }

  private normalizePath(path: string): string {
    const segments = path.replace(/\\/g, '/').split('/');
    const normalizedSegments: string[] = [];

    for (const segment of segments) {
      if (!segment || segment === '.') {
        continue;
      }

      if (segment === '..') {
        normalizedSegments.pop();
        continue;
      }

      normalizedSegments.push(segment);
    }

    return normalizedSegments.join('/');
  }

  /**
   * Format an esbuild message for display
   */
  private formatMessage(message: esbuild.Message): string {
    const location = message.location
      ? `${message.location.file}:${message.location.line}:${message.location.column}`
      : 'unknown location';
    return `${location}: ${message.text}`;
  }

  /**
   * Parse esbuild error into a user-friendly CompilationError
   */
  private parseCompilationError(error: unknown): CompilationError {
    if (
      error &&
      typeof error === 'object' &&
      'errors' in error &&
      Array.isArray(error.errors) &&
      error.errors.length > 0
    ) {
      const firstError = error.errors[0];
      return {
        message: firstError.text || 'Compilation failed',
        file: firstError.location?.file,
        line: firstError.location?.line,
        column: firstError.location?.column,
        details: error,
      };
    }

    // Safely extract message from unknown error object without using `any`
    const maybeMessage =
      error &&
      typeof error === 'object' &&
      'message' in error &&
      typeof (error as { message?: unknown }).message === 'string'
        ? ((error as { message?: unknown }).message as string)
        : 'Unknown compilation error';

    return {
      message: maybeMessage,
      details: error,
    };
  }

  /**
   * Dispose of the service (cleanup esbuild resources if needed)
   */
  dispose(): void {
    // esbuild-wasm doesn't require explicit cleanup in most cases
    // The WASM module will be garbage collected
    this.initialized = false;
    this.initPromise = null;
  }
}
