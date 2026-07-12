/**
 * MonacoIntelliSenseService
 *
 * Configures the in-editor Monaco TypeScript language service so user scripts
 * get real IntelliSense:
 *  - engine + vendor types (`@pix3/runtime` sources, three) as extra libs,
 *  - compiler options mirroring the esbuild runtime compile,
 *  - a live-regenerated ambient lib giving typed, autocompleting scene-node
 *    names (`this.getNode('Hero')` → the exact node type),
 *  - sibling project-script files mirrored so relative imports resolve.
 *
 * Monaco is passed into `ensureConfigured` rather than imported so the service
 * stays testable outside a browser (Monaco cannot load under happy-dom) and so
 * `monaco-loader.ts` remains a pure loader.
 */

import type * as Monaco from 'monaco-editor';

import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import * as RuntimeAPI from '@pix3/runtime';

import { LoggingService } from './LoggingService';
import { ProjectScriptLoaderService } from './ProjectScriptLoaderService';
import { generateSceneNodesLib } from './scene-nodes-dts';
import {
  createCompilerOptions,
  loadMonacoRuntimeLibs,
  SCENE_NODES_LIB_PATH,
  type MonacoLib,
} from '@/ui/code-editor/monaco-runtime-libs';

type MonacoApi = typeof Monaco;

@injectable()
export class MonacoIntelliSenseService {
  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(ProjectScriptLoaderService)
  private readonly scriptLoader!: ProjectScriptLoaderService;

  private monaco: MonacoApi | null = null;
  private configurePromise: Promise<void> | null = null;

  private staticLibs: MonacoLib[] = [];
  /** Dynamic libs keyed by virtual path (scene-nodes lib + sibling mirrors). */
  private readonly dynamicLibs = new Map<string, string>();

  private readonly disposers: Array<() => void> = [];
  private recomputeTimer: number | null = null;

  /**
   * Idempotent. Safe to call from every code tab as it initializes — the first
   * call does the work, later calls await the same promise.
   */
  ensureConfigured(monaco: MonacoApi): Promise<void> {
    if (!this.configurePromise) {
      this.configurePromise = this.configure(monaco).catch(error => {
        // IntelliSense is best-effort: log and swallow so callers can `void`
        // this without risking an unhandled rejection, and reset so a later
        // tab can retry.
        this.configurePromise = null;
        this.logger.error('Failed to configure code-editor IntelliSense', error);
      });
    }
    return this.configurePromise;
  }

  private async configure(monaco: MonacoApi): Promise<void> {
    this.monaco = monaco;
    const { typescriptDefaults, javascriptDefaults } = monaco.typescript;
    const compilerOptions = createCompilerOptions(monaco);

    typescriptDefaults.setCompilerOptions(compilerOptions);
    javascriptDefaults.setCompilerOptions(compilerOptions);
    typescriptDefaults.setEagerModelSync(true);
    javascriptDefaults.setEagerModelSync(true);

    this.staticLibs = await loadMonacoRuntimeLibs();

    // Regenerate scene names / re-mirror siblings on the signals that change
    // them. Node renames bump `scenes.nodeDataChangeSignal` (a reactive field),
    // add/remove rebuilds `scenes.hierarchies`; both fire this subscription.
    this.disposers.push(subscribe(appState.scenes, () => this.scheduleRecompute()));
    this.disposers.push(subscribe(appState.project, () => this.scheduleRecompute()));

    // A newly-opened model supersedes its mirror (same URI would otherwise
    // duplicate every declaration); closing one restores the mirror.
    const onCreate = monaco.editor.onDidCreateModel(() => this.scheduleRecompute());
    const onDispose = monaco.editor.onWillDisposeModel(() => this.scheduleRecompute());
    this.disposers.push(() => onCreate.dispose());
    this.disposers.push(() => onDispose.dispose());

    this.recomputeDynamicLibs();
  }

  private scheduleRecompute(): void {
    if (this.recomputeTimer !== null) {
      window.clearTimeout(this.recomputeTimer);
    }
    this.recomputeTimer = window.setTimeout(() => {
      this.recomputeTimer = null;
      this.recomputeDynamicLibs();
    }, 300);
  }

  /**
   * Rebuild the full dynamic-lib set (scene-node names + sibling mirrors) and
   * push everything to the TS worker in a single `setExtraLibs` call.
   */
  private recomputeDynamicLibs(): void {
    if (!this.monaco) {
      return;
    }

    this.dynamicLibs.clear();

    // Scene-node names from the union of all loaded scenes.
    try {
      const sceneRoots = Object.values(appState.scenes.hierarchies).map(
        hierarchy => hierarchy.rootNodes
      );
      const sceneLib = generateSceneNodesLib(
        sceneRoots,
        RuntimeAPI as unknown as Record<string, unknown>
      );
      this.dynamicLibs.set(SCENE_NODES_LIB_PATH, sceneLib);
    } catch (error) {
      this.logger.warn('Failed to generate scene-node types', error);
    }

    // Sibling project scripts, so relative imports (`./config`) resolve. Skip
    // files that currently have an open model — that model is the source of
    // truth and a same-URI lib would produce duplicate-identifier errors.
    const openModelUris = new Set(
      this.monaco.editor.getModels().map(model => model.uri.toString())
    );
    for (const [path, content] of this.scriptLoader.getCollectedFiles()) {
      const uri = this.monaco.Uri.parse(`res://${path}`).toString();
      if (!openModelUris.has(uri)) {
        this.dynamicLibs.set(uri, content);
      }
    }

    this.syncExtraLibs();
  }

  private syncExtraLibs(): void {
    if (!this.monaco) {
      return;
    }
    const libs: MonacoLib[] = [
      ...this.staticLibs,
      ...Array.from(this.dynamicLibs, ([filePath, content]) => ({ filePath, content })),
    ];
    const { typescriptDefaults, javascriptDefaults } = this.monaco.typescript;
    typescriptDefaults.setExtraLibs(libs);
    javascriptDefaults.setExtraLibs(libs);
  }

  dispose(): void {
    if (this.recomputeTimer !== null) {
      window.clearTimeout(this.recomputeTimer);
      this.recomputeTimer = null;
    }
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;
    this.dynamicLibs.clear();
    if (this.monaco) {
      this.monaco.typescript.typescriptDefaults.setExtraLibs([]);
      this.monaco.typescript.javascriptDefaults.setExtraLibs([]);
    }
    this.monaco = null;
    this.configurePromise = null;
  }
}
