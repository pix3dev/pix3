import { injectable } from '@/fw/di';
import { appState } from '@/state';

/**
 * Which half of the Flow lifecycle a project is in: `idea` is the collaborative brief editor
 * (document + references, no runtime), `prototype` is the live game stage.
 */
export type FlowStage = 'idea' | 'prototype';

/** Manifest metadata key the stage is persisted under (design §3.2). */
export const FLOW_STAGE_METADATA_KEY = 'flowStage';

/**
 * Template id of the idea-stage scaffold. Declared here rather than in
 * `PrototypeBootstrapService` because this module is the one every consumer of the stage already
 * imports, and importing the bootstrap service back into it would close an import cycle through
 * `AgentChatService`.
 */
export const IDEA_TEMPLATE_ID = 'idea-blank';

/** Manifest metadata key carrying the recipe the welcome card hinted at (a hint, not a choice). */
export const FLOW_RECIPE_HINT_METADATA_KEY = 'recipeHint';

/**
 * Reads which Flow stage the open project is in.
 *
 * The stage lives in the project **manifest**, which is the only carrier that is loaded before the
 * shell renders, travels with the project (OPFS, cloud sync) and adds no read to the open path
 * (design §3.2). A localStorage flag would be lost on another machine and a marker file would cost
 * a read on every open.
 *
 * The fallback is deliberately `prototype`: every project that exists today has no `flowStage`, and
 * their behaviour must not change.
 */
@injectable()
export class FlowStageService {
  getStage(): FlowStage {
    const metadata = appState.project.manifest?.metadata;
    const stage = metadata?.[FLOW_STAGE_METADATA_KEY];
    if (stage === 'idea' || stage === 'prototype') {
      return stage;
    }
    // Belt and braces (design §3.2): a project scaffolded from `idea-blank` whose `flowStage` went
    // missing — a hand-edited manifest, a half-written write — is still an idea-stage project, and
    // reading it as a prototype would start a runtime over an empty canvas.
    return metadata?.templateId === IDEA_TEMPLATE_ID ? 'idea' : 'prototype';
  }

  isIdeaStage(): boolean {
    return this.getStage() === 'idea';
  }
}
