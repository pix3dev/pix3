import { inject, injectable } from '@/fw/di';
import { ProjectService } from '@/services/project/ProjectService';
import { appState } from '@/state';

import { FLOW_TITLE_SOURCE_METADATA_KEY, FlowStageService } from './FlowStageService';

/** Longer than this is a sentence, not a name — the header truncates it and the recents list worse. */
const MAX_PROJECT_NAME_LENGTH = 48;

/**
 * Keeps the project's NAME on the title its design document carries.
 *
 * The idea path makes no model call on the way in (design §3.1), so the name the project is born
 * with is derived from the raw prompt — good enough to open with, never the name the game ends up
 * having. The agent's first turn is where a real title appears: it rewrites the `# Title` line of
 * `design/gdd.md`, and this carries that over to the project so the status bar, the browser tab and
 * the recents list say the same thing the header does.
 *
 * Two guards, both learned from what an automatic rename can do wrong:
 * - **The user's own rename wins forever.** The metadata marker records the name the editor set, so
 *   a project name that no longer matches it was typed by a human and is left alone.
 * - **Idea stage only.** Past the transition the project is a real game with files, exports and a
 *   recents entry the user recognises; a document edit is not a reason to rename it underneath them.
 */
@injectable()
export class FlowProjectNameService {
  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  @inject(FlowStageService)
  private readonly stageService!: FlowStageService;

  /** @returns whether the project was renamed. */
  async syncFromDocumentTitle(docTitle: string | null | undefined): Promise<boolean> {
    const title = (docTitle ?? '').replace(/\s+/g, ' ').trim();
    const manifest = appState.project.manifest;
    if (
      !title ||
      title.length > MAX_PROJECT_NAME_LENGTH ||
      appState.project.status !== 'ready' ||
      !manifest ||
      !this.stageService.isIdeaStage()
    ) {
      return false;
    }

    const current = appState.project.projectName?.trim() ?? '';
    if (current === title) {
      return false;
    }
    const source = manifest.metadata?.[FLOW_TITLE_SOURCE_METADATA_KEY];
    // No marker at all means the project was not named by this path (an older project, an imported
    // one) — renaming it from a document would be a surprise, not a feature.
    if (typeof source !== 'string' || (current !== '' && source !== current)) {
      return false;
    }

    appState.project.projectName = title;
    // The recents entry is what the name is read back from when a browser project reopens.
    this.projectService.syncProjectMetadata();
    try {
      await this.projectService.saveProjectManifest({
        ...manifest,
        metadata: {
          ...(manifest.metadata ?? {}),
          projectName: title,
          [FLOW_TITLE_SOURCE_METADATA_KEY]: title,
        },
      });
    } catch {
      // The name on screen is already right. An unwritten marker only costs the NEXT rename, which
      // will read the stale marker and stand down — the safe direction to fail in.
    }
    return true;
  }
}
