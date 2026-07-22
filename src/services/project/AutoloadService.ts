import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import type { AutoloadConfig, ProjectManifest } from '@/core/ProjectManifest';
import { createDefaultProjectManifest } from '@/core/ProjectManifest';
import { NodeBase, ScriptRegistry, type ScriptComponent } from '@pix3/runtime';
import { subscribe } from 'valtio/vanilla';

@injectable()
export class AutoloadService {
  @inject(ScriptRegistry)
  private readonly scriptRegistry!: ScriptRegistry;

  private readonly autoloadInstances = new Map<string, ScriptComponent>();
  private globalRoot: NodeBase = this.createGlobalRoot();
  private disposeProjectSubscription?: () => void;
  private lastProjectId: string | null = null;
  private lastManifestHash = '';
  private lastScriptRefreshSignal = 0;

  constructor() {
    this.disposeProjectSubscription = subscribe(appState.project, () => {
      this.handleProjectStateChanged();
    });
  }

  get(singletonName: string): ScriptComponent | undefined {
    return this.autoloadInstances.get(singletonName);
  }

  getGlobalRoot(): NodeBase {
    return this.globalRoot;
  }

  getAutoloadInstances(): ScriptComponent[] {
    return Array.from(this.autoloadInstances.values());
  }

  async initialize(manifest: ProjectManifest | null): Promise<void> {
    const resolvedManifest: ProjectManifest = manifest ?? createDefaultProjectManifest();

    this.cleanup();

    for (const autoload of resolvedManifest.autoloads) {
      if (!autoload.enabled) {
        continue;
      }
      this.instantiateAutoload(autoload);
    }
  }

  cleanup(): void {
    for (const component of [...this.globalRoot.components]) {
      this.globalRoot.removeComponent(component);
    }

    for (const child of [...this.globalRoot.children]) {
      this.globalRoot.remove(child);
    }

    this.autoloadInstances.clear();
    this.globalRoot = this.createGlobalRoot();
  }

  dispose(): void {
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = undefined;
    this.cleanup();
  }

  private handleProjectStateChanged(): void {
    const project = appState.project;
    const manifestHash = JSON.stringify(project.manifest?.autoloads ?? []);
    const projectChanged = this.lastProjectId !== project.id;
    const scriptsChanged = this.lastScriptRefreshSignal !== project.scriptRefreshSignal;
    const manifestChanged = this.lastManifestHash !== manifestHash;

    if (project.status !== 'ready') {
      this.cleanup();
      this.lastProjectId = project.id;
      this.lastScriptRefreshSignal = project.scriptRefreshSignal;
      this.lastManifestHash = manifestHash;
      return;
    }

    if (projectChanged) {
      this.cleanup();
    }

    this.lastProjectId = project.id;
    this.lastScriptRefreshSignal = project.scriptRefreshSignal;
    this.lastManifestHash = manifestHash;

    if (project.scriptsStatus !== 'ready') {
      return;
    }

    if (projectChanged || scriptsChanged || manifestChanged) {
      void this.initialize(project.manifest);
    }
  }

  private instantiateAutoload(config: AutoloadConfig): void {
    const componentTypeId = this.getTypeIdFromScriptPath(config.scriptPath);
    const instanceId = `autoload:${config.singleton}`;
    const component = this.scriptRegistry.createComponent(componentTypeId, instanceId);

    if (!component) {
      console.warn('[AutoloadService] Failed to resolve autoload component', {
        singleton: config.singleton,
        scriptPath: config.scriptPath,
        typeId: componentTypeId,
      });
      return;
    }

    component.enabled = true;
    this.globalRoot.addComponent(component);
    this.autoloadInstances.set(config.singleton, component);
  }

  private getTypeIdFromScriptPath(scriptPath: string): string {
    const normalized = scriptPath.replace(/\\/g, '/');
    const fileName = normalized.split('/').pop() ?? normalized;
    const className = fileName.replace(/\.(t|j)sx?$/i, '');
    return `user:${className}`;
  }

  private createGlobalRoot(): NodeBase {
    return new NodeBase({
      id: '__global_root__',
      type: 'GlobalRoot',
      name: 'GlobalRoot',
      properties: {
        visible: false,
      },
      metadata: {
        internal: true,
      },
    });
  }
}
