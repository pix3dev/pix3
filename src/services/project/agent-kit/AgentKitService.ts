import { inject, injectable } from '@/fw/di';
import { appState, type AppState } from '@/state';
import { CURRENT_EDITOR_VERSION } from '@/version';
import { ProjectService } from '@/services/project/ProjectService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { ProjectTemplateService } from '@/services/project/ProjectTemplateService';
import { FileSystemAPIError } from '@/services/project/FileSystemAPIService';
import { WorkspaceError } from '@/services/project/workspace/workspace-protocol';
import {
  installAgentKit,
  type AgentKitFileSystem,
  type BundledAgentKit,
} from './agent-kit-install';
import { buildAgentHandoff, type AgentHandoff } from './agent-handoff';
import {
  pinnedCliVersion,
  resolvePublishedCliVersion,
  type CliVersionResolution,
} from './cli-version-gate';

/**
 * "Work with your own agent" (plan §1.1): writes the agent kit `pix3 kit` writes into the open
 * project — right after a project is created from a recipe, or on demand (File → Install Agent
 * Kit…) — and holds the "Continue in your agent" screen the editor shell renders afterwards.
 *
 * Paths the agent can reach are the only ones it makes sense for: a local folder, or a
 * `pix3 serve` workspace. In-browser (OPFS) and cloud projects have no folder an agent could open.
 */

/**
 * Paths of the in-editor agent overlay (`src/templates/agent/`) a project made for an external
 * agent does not get: its `AGENTS.md` / `CLAUDE.md` describe the built-in chat, and its skills are
 * written for the editor's own tool loop. Without this the kit would find an `AGENTS.md` that is
 * not its own and step aside into `AGENTS.pix3.md`. What remains of the overlay (`design/README.md`,
 * `.gitignore`) is harmless, and the result matches `pix3 new` file for file otherwise.
 */
export const EXTERNAL_AGENT_TEMPLATE_SKIP: readonly string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude',
];

type ProjectState = AppState['project'];

export type AgentKitAvailability =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const isNotFound = (error: unknown): boolean => {
  if (error instanceof FileSystemAPIError) return error.code === 'not-found';
  if (error instanceof WorkspaceError) return error.code === 'not_found' || error.status === 404;
  if (error instanceof DOMException) return error.name === 'NotFoundError';
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof DOMException && cause.name === 'NotFoundError';
};

const confirmedCliVersionFromBuild = (): string | null => {
  const value: unknown = import.meta.env.VITE_PIX3_CLI_CONFIRMED_VERSION;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

@injectable()
export class AgentKitService {
  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ProjectTemplateService)
  private readonly templates!: ProjectTemplateService;

  private active: AgentHandoff | null = null;
  private readonly listeners = new Set<(handoff: AgentHandoff | null) => void>();
  private nextId = 0;

  /** Test seam: the registry lookup (default: `resolvePublishedCliVersion` against npm). */
  resolveCliVersion: () => Promise<CliVersionResolution> = () =>
    resolvePublishedCliVersion({
      editorVersion: CURRENT_EDITOR_VERSION.version,
      confirmedVersion: confirmedCliVersionFromBuild(),
    });

  /** Test seam: the bundled kit (a lazy chunk in the app). */
  loadKit: () => Promise<BundledAgentKit> = async () =>
    (await import('./bundled-kit')).loadBundledAgentKit();

  availability(
    project: Pick<ProjectState, 'status' | 'backend'> = appState.project
  ): AgentKitAvailability {
    if (project.status !== 'ready') {
      return { ok: false, reason: 'Open a project first.' };
    }
    switch (project.backend) {
      case 'local':
      case 'workspace':
        return { ok: true };
      case 'browser':
        return {
          ok: false,
          reason:
            'An in-browser project has no folder an agent can open. Move it to a folder first (File → Move Project to Folder…).',
        };
      default:
        return {
          ok: false,
          reason:
            'A cloud project has no folder an agent can open. Sync it to a local folder first (File → Sync to Local Folder…).',
        };
    }
  }

  /**
   * Write (or update) the kit into the open project, record `metadata.agentKit`, and open the
   * "Continue in your agent" screen. `update` replaces kit files the user has not edited — the
   * menu command's mode; a fresh project has nothing to update.
   */
  async installAndShow(options: { readonly update?: boolean } = {}): Promise<AgentHandoff> {
    const availability = this.availability();
    if (!availability.ok) {
      throw new Error(availability.reason);
    }
    const [cli, kit] = await Promise.all([this.resolveCliVersion(), this.loadKit()]);
    const report = await installAgentKit(this.createFileSystem(), kit, {
      update: options.update ?? true,
      mcpCliVersion: pinnedCliVersion(cli),
    });

    const manifest = appState.project.manifest;
    if (manifest) {
      const current = JSON.stringify(manifest.metadata?.agentKit ?? null);
      const next = {
        version: report.agentKitMetadata.version,
        files: [...report.agentKitMetadata.files],
      };
      if (current !== JSON.stringify(next)) {
        await this.projectService.saveProjectManifest({
          ...manifest,
          metadata: { ...(manifest.metadata ?? {}), agentKit: next },
        });
      }
    }

    const templateId = manifest?.metadata?.templateId;
    const template = typeof templateId === 'string' ? this.templates.getTemplate(templateId) : null;
    const backend = appState.project.backend === 'workspace' ? 'workspace' : 'local';
    const handoff = buildAgentHandoff({
      id: `agent-handoff-${this.nextId++}`,
      folderName: this.folderName(),
      backend,
      kit: report,
      cli,
      editorVersion: CURRENT_EDITOR_VERSION.version,
      recipeTitle: template?.title ?? null,
      hasRecipeDoc: await this.storage.fileExists('design/recipe.md').catch(() => false),
    });
    this.active = handoff;
    this.notify();
    return handoff;
  }

  close(): void {
    if (!this.active) return;
    this.active = null;
    this.notify();
  }

  getActive(): AgentHandoff | null {
    return this.active;
  }

  subscribe(listener: (handoff: AgentHandoff | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.active);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.active = null;
    this.listeners.clear();
  }

  /** The folder `cd` goes to: the absolute path from Project Settings when set, else its name. */
  private folderName(): string {
    const project = appState.project;
    const absolute = project.backend === 'local' ? project.localAbsolutePath?.trim() : '';
    return absolute || project.directoryHandle?.name || project.projectName || 'my-game';
  }

  private createFileSystem(): AgentKitFileSystem {
    const created = new Set<string>();
    return {
      read: async path => {
        try {
          return await this.storage.readTextFile(path);
        } catch (error) {
          if (isNotFound(error)) return null;
          throw error;
        }
      },
      write: async (path, contents) => {
        const slash = path.lastIndexOf('/');
        if (slash > 0) {
          const dir = path.slice(0, slash);
          if (!created.has(dir)) {
            await this.storage.createDirectory(dir);
            created.add(dir);
          }
        }
        await this.storage.writeTextFile(path, contents);
      },
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.active);
  }
}
