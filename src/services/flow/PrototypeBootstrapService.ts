import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import {
  createDefaultProjectManifest,
  createDefaultQualitySettings,
  type ProjectManifest,
} from '@/core/ProjectManifest';
import { ProjectService } from '@/services/project/ProjectService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { ProjectTemplateService } from '@/services/project/ProjectTemplateService';
import { BrowserProjectStorageService } from '@/services/project/BrowserProjectStorageService';
import { WorkspaceModeService } from '@/services/editor/WorkspaceModeService';
import { AgentChatService } from '@/services/agent/AgentChatService';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { AgentVisionService } from '@/services/agent/AgentVisionService';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import { base64ToBlob, extractPalette, tintImage } from '@/services/image-gen/image-ops';
import type { LlmImageBlock, LlmMessage } from '@/services/llm/LlmTypes';
import {
  applyScenePatches,
  looksLikeScene,
  paletteColorForRole,
  parseRecipePlaceholders,
  parseRecipeTunables,
  resolveTunables,
  type RecipePlaceholder,
  type RecipeTunable,
  type ScenePatch,
  type TunableResolution,
} from '@/services/flow/recipe-contract';
import {
  attachmentProjectPath,
  type ComposerAttachment,
  type ComposerImageAttachment,
} from '@/ui/shared/composer-attachments';
import { buildProjectMap } from '@/services/flow/flow-project-map';
import {
  FLOW_BRIEF_PATH,
  FLOW_DECISIONS_PATH,
  FLOW_PROGRESS_PATH,
} from '@/services/flow/FlowPlanService';

// ---------------------------------------------------------------------------
// The brief (design §5.3)
// ---------------------------------------------------------------------------

export interface PrototypeBriefStyle {
  readonly palette: string[];
  readonly artStyle: string;
  readonly mood: string;
}

export interface PrototypeBriefEntity {
  readonly role: 'player' | 'enemy' | 'collectible' | 'obstacle' | 'background' | 'ui' | string;
  readonly name: string;
  readonly assetSpec: { readonly prompt: string; readonly sizeHint?: number };
}

export interface PrototypeBriefReference {
  /** Project path of the already-saved file (`references/...` or `design/source/...`). */
  readonly path: string;
  readonly kind: 'image' | 'doc';
  /** Images only — how the reference may be used (see `AttachmentRole`). */
  readonly role?: 'style' | 'content' | 'layout';
  /** What was taken from it (style tokens, which GDD section). */
  readonly note?: string;
}

/**
 * The light IR between "a sentence the user typed" and "a project on disk" (design §5.3).
 *
 * Deliberately small and deliberately NOT a game blueprint: everything here is either a choice the
 * deterministic expander can act on (which recipe, which colours, which declared tunables) or text
 * the agent reads on its first turn. Game logic is not in this contract — that decision is argued in
 * design §5.1, and the measured result it protects is that a recipe skeleton plus a proving agent
 * beats a bigger up-front spec.
 */
export interface PrototypeBrief {
  readonly title: string;
  /** One line for the Flow header. */
  readonly pitch: string;
  /** Recipe id from the catalog (`recipe-*`). */
  readonly recipeId: string;
  /** Style tokens for EVERY later generation — palette comes from a reference when there is one. */
  readonly style: PrototypeBriefStyle;
  readonly entities: readonly PrototypeBriefEntity[];
  /** Values for tuning points the recipe declares. Unknown keys are reported, never guessed. */
  readonly tunables: Readonly<Record<string, number | string | boolean>>;
  readonly winLose: { readonly win: string; readonly lose: string };
  /** 3–5 steps; becomes the `design/progress.md` checklist the plan tracker reads. */
  readonly increments: readonly string[];
  /** Playable-ad recipe only. */
  readonly ctaUrl?: string;
  /** Attachments of the first prompt, already saved as project files (design §5.7). */
  readonly references?: readonly PrototypeBriefReference[];
}

/** Recipe the flow falls back to when the planner names one that does not exist (contract §1). */
export const FALLBACK_RECIPE_ID = 'recipe-arena-2d';

/** Recipe ids the planner may choose from, with the one-liners it needs to choose well. */
/**
 * Recipe ids the planner may pick that are served by an existing template folder under another
 * name. The playable-ad "recipe" is the shipped `playable-2d` template (tap-gate + CTA + store
 * hook) promoted into the catalog with a `design/recipe.md`; without this alias the planner's
 * correct answer would silently fall back to the arena recipe.
 */
const RECIPE_TEMPLATE_ALIASES: Readonly<Record<string, string>> = {
  'recipe-playable-ad': 'playable-2d',
};

const RECIPE_CATALOG: ReadonlyArray<{ id: string; blurb: string }> = [
  {
    id: 'recipe-tapper-2d',
    blurb:
      'objects appear and tapping them is the whole game; timer or lives. Tappers, whack-a-mole, catch-the-falling, clickers.',
  },
  {
    id: FALLBACK_RECIPE_ID,
    blurb:
      'an avatar moves in a bounded field while a spawner sends pickups/hazards at it; touching them scores or hurts. Dodgers, collectors, top-down survival, snake, runners.',
  },
  {
    id: 'recipe-bouncer-2d',
    blurb:
      'a ball under gravity bounces off walls, paddles and bumpers; a paddle keeps it in play. Breakout, pong, plinko, pinball.',
  },
  {
    id: 'recipe-playable-ad',
    blurb: 'a playable ad: tap-to-start audio gate, a short loop, then a CTA screen to the store.',
  },
];

// ---------------------------------------------------------------------------
// Observable status
// ---------------------------------------------------------------------------

export type PrototypeBootstrapPhase = 'idle' | 'planning' | 'expanding' | 'ready' | 'error';

export interface PrototypeBootstrapStatus {
  readonly phase: PrototypeBootstrapPhase;
  /** One line for the prompt-hero. Never a modal — nothing on this path may block (design §3.6). */
  readonly message: string;
  readonly brief: PrototypeBrief | null;
  readonly error: string | null;
}

export interface PrototypeBootstrapRequest {
  readonly prompt: string;
  readonly attachments?: readonly ComposerAttachment[];
  /**
   * Pin the recipe (the user clicked a recipe card), which skips the planner's genre choice but not
   * the rest of the brief.
   */
  readonly recipeId?: string;
  /** Skip handing the first increment to the agent (used by tests / headless callers). */
  readonly startAgentTurn?: boolean;
}

export interface PrototypeBootstrapResult {
  readonly brief: PrototypeBrief;
  /** Template actually used, which differs from `brief.recipeId` when it had to fall back. */
  readonly templateId: string;
  /** Everything that degraded on the way: bad planner output, unknown tunables, missing recipe. */
  readonly notes: readonly string[];
}

const IDLE_STATUS: PrototypeBootstrapStatus = {
  phase: 'idle',
  message: '',
  brief: null,
  error: null,
};

const MAX_PLANNER_TOKENS = 2048;
/** Cap on how much of an attached document reaches the planner (design §5.7 — never inline a GDD). */
const DOC_EXCERPT_CHARS = 4000;
/** At most this many images are described by the vision helper before the planner call. */
const MAX_VISION_IMAGES = 2;
/** Colours quantized out of a style reference. */
const PALETTE_SIZE = 5;
/** How long the first agent turn waits for the shell to open the scene before going anyway. */
const SCENE_WAIT_MS = 10_000;

/**
 * Turns one prompt (plus any references) into an open, playable project: one planner call for the
 * {@link PrototypeBrief}, then a **deterministic** expander that writes the project from a recipe.
 *
 * The split is the point. Everything a model is asked for here is a *choice* — genre, palette,
 * names, the increment list — and everything mechanical is code: creating the project, patching
 * scene YAML by node id, tinting placeholders, writing `design/*.md`. That is why a garbage planner
 * response is survivable rather than fatal: the expander still has a recipe, a prompt and a project
 * to hand the agent, which is strictly better than the status quo of an agent starting from an empty
 * folder (design §5.3, and the FAIL→PASS result in `.plans/agent-eval-results.md` that motivates it).
 *
 * Nothing here opens a dialog. The status is observable so the prompt-hero can narrate progress
 * inline while the shell has already switched to Flow (design §3.6 — no modal on the iteration path).
 */
@injectable()
export class PrototypeBootstrapService {
  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ProjectTemplateService)
  private readonly templates!: ProjectTemplateService;

  @inject(BrowserProjectStorageService)
  private readonly browserStore!: BrowserProjectStorageService;

  @inject(WorkspaceModeService)
  private readonly workspaceMode!: WorkspaceModeService;

  @inject(AgentChatService)
  private readonly agentChat!: AgentChatService;

  @inject(AgentSettingsService)
  private readonly agentSettings!: AgentSettingsService;

  @inject(AgentVisionService)
  private readonly vision!: AgentVisionService;

  @inject(LlmModelCatalogService)
  private readonly catalog!: LlmModelCatalogService;

  private status: PrototypeBootstrapStatus = IDLE_STATUS;
  private readonly listeners = new Set<(status: PrototypeBootstrapStatus) => void>();
  private running = false;

  getStatus(): PrototypeBootstrapStatus {
    return this.status;
  }

  isRunning(): boolean {
    return this.running;
  }

  subscribe(listener: (status: PrototypeBootstrapStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  /**
   * Prompt → open project. Resolves once the project is on disk and open; the agent's first
   * increment runs on after that, so the caller is never blocked on a model.
   */
  async run(request: PrototypeBootstrapRequest): Promise<PrototypeBootstrapResult> {
    if (this.running) {
      throw new Error('A prototype is already being created.');
    }
    this.running = true;
    const notes: string[] = [];
    try {
      const attachments = request.attachments ?? [];
      this.setStatus({
        phase: 'planning',
        message: 'Reading your idea…',
        error: null,
        brief: null,
      });

      // The palette is quantized from the user's own style reference rather than asked for as hex
      // codes: free, instant and exact where a model is none of those (design §5.7).
      const palette = await this.paletteFromReferences(attachments);
      const { brief, issues } = await this.plan(request, attachments, palette);
      notes.push(...issues);

      this.setStatus({
        phase: 'expanding',
        message: 'Building your project…',
        brief,
        error: null,
      });
      const { templateId, expandNotes } = await this.expand(brief, request.prompt, attachments);
      notes.push(...expandNotes);

      this.setStatus({
        phase: 'ready',
        message: 'Your prototype is live — the agent is taking the first step.',
        brief,
        error: null,
      });

      if (request.startAgentTurn !== false) {
        // Deliberately not awaited: the first increment is a full agent run, and the hero's job is
        // done the moment the project is open and playable.
        void this.startFirstTurn(brief, request.prompt).catch(error => {
          console.error('[PrototypeBootstrapService] First agent turn failed to start:', error);
        });
      }

      return { brief, templateId, notes };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({
        phase: 'error',
        message: 'Could not build the project.',
        brief: this.status.brief,
        error: message,
      });
      throw error;
    } finally {
      this.running = false;
    }
  }

  /** Reset back to idle (the hero calls this when the user edits the prompt after a failure). */
  reset(): void {
    if (this.running) {
      return;
    }
    this.setStatus(IDLE_STATUS);
  }

  // -- planner ---------------------------------------------------------------

  /**
   * ONE call to the user's selected provider, asking for JSON. Never throws: every failure mode
   * (no key, provider error, prose instead of JSON, a hallucinated recipe id) degrades to the
   * fallback brief plus a note that lands in `design/brief.md`, because the alternative — an error
   * screen where a playable skeleton could have been — is strictly worse for every one of them.
   */
  private async plan(
    request: PrototypeBootstrapRequest,
    attachments: readonly ComposerAttachment[],
    palette: string[]
  ): Promise<{ brief: PrototypeBrief; issues: string[] }> {
    const issues: string[] = [];
    const fallback = (): PrototypeBrief =>
      applyPlannerOverrides(fallbackBrief(request.prompt), request, palette, attachments);

    const provider = this.agentSettings.getSelectedProvider();
    const modelId = provider ? this.agentSettings.getSelectedModelId(provider.id) : undefined;
    const apiKey = provider ? await this.agentSettings.getApiKey(provider.id) : null;
    if (!provider || !modelId || !apiKey) {
      issues.push(
        'No LLM provider is configured, so the brief was derived from your prompt alone. Add an API key in agent settings for a planned brief.'
      );
      return { brief: fallback(), issues };
    }

    const images = attachments.filter(isImageAttachment);
    const supportsImages =
      this.catalog.getModel(provider.id, modelId)?.capabilities.supportsImages ?? false;
    const visionNotes =
      images.length > 0 && !supportsImages ? await this.describeReferences(images, issues) : [];

    const userText = buildPlannerPrompt(request, attachments, palette, visionNotes);
    const content: LlmMessage['content'] =
      supportsImages && images.length > 0
        ? [
            { type: 'text', text: userText },
            ...images.slice(0, MAX_VISION_IMAGES).map(toImageBlock),
          ]
        : userText;

    let raw = '';
    try {
      const result = await provider.chat(
        {
          messages: [{ role: 'user', content }],
          system: PLANNER_SYSTEM_PROMPT,
          maxTokens: MAX_PLANNER_TOKENS,
        },
        { apiKey, modelId, baseUrl: this.agentSettings.getBaseUrl(provider.id) }
      );
      raw = result.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('\n');
    } catch (error) {
      issues.push(
        `The planner call failed (${error instanceof Error ? error.message : String(error)}); started from the fallback recipe.`
      );
      return { brief: fallback(), issues };
    }

    const parsed = extractJsonObject(raw);
    if (!parsed) {
      issues.push('The planner did not return usable JSON; started from the fallback recipe.');
      return { brief: fallback(), issues };
    }

    const validated = validateBrief(parsed, request.prompt);
    issues.push(...validated.issues);
    return {
      brief: applyPlannerOverrides(validated.brief, request, palette, attachments),
      issues,
    };
  }

  /** Style tokens for images a text-only main model cannot see (design §5.7). Best-effort. */
  private async describeReferences(
    images: readonly ComposerImageAttachment[],
    issues: string[]
  ): Promise<string[]> {
    const notes: string[] = [];
    for (const image of images.slice(0, MAX_VISION_IMAGES)) {
      if (image.role === 'content') {
        // A content reference is for ITS asset only; describing it here would leak one object's
        // look into the whole game's style tokens (eval S2).
        continue;
      }
      try {
        const answer = await this.vision.analyze(
          toImageBlock(image),
          image.role === 'layout'
            ? 'Describe the screen layout: what regions exist and what sits in each.'
            : 'Give style tokens for this reference.'
        );
        notes.push(`${image.name} (${image.role}): ${answer}`);
      } catch {
        issues.push(`Could not analyze ${image.name}; its style was not used.`);
      }
    }
    return notes;
  }

  /** Quantized palette of the first style reference, or an empty array when there is none. */
  private async paletteFromReferences(
    attachments: readonly ComposerAttachment[]
  ): Promise<string[]> {
    const styleImage =
      attachments.filter(isImageAttachment).find(image => image.role === 'style') ??
      attachments.filter(isImageAttachment).find(image => image.role !== 'content');
    if (!styleImage) {
      return [];
    }
    try {
      const swatches = await extractPalette(
        base64ToBlob(styleImage.base64, styleImage.mimeType),
        PALETTE_SIZE
      );
      return swatches.map(swatch => swatch.hex);
    } catch {
      return [];
    }
  }

  // -- expander --------------------------------------------------------------

  /**
   * Create the project from the recipe and patch the copied files **in place, before any scene is
   * opened** (contract §5). Patching text on disk instead of mutating a loaded scene means no
   * races with the scene loader, no operations, and nothing in the undo stack that the user would
   * have to undo past to reach their own first edit.
   */
  private async expand(
    brief: PrototypeBrief,
    prompt: string,
    attachments: readonly ComposerAttachment[]
  ): Promise<{ templateId: string; expandNotes: string[] }> {
    const expandNotes: string[] = [];
    const templateId = this.resolveTemplateId(brief.recipeId, expandNotes);

    // OPFS is the anonymous user's storage and browsers may evict it under pressure.
    try {
      await this.browserStore.requestPersistence();
    } catch {
      // Best effort — a project that cannot be made persistent is still a working project.
    }

    await this.projectService.createNewProjectWithOptions(
      {
        name: brief.title,
        manifest: this.buildManifest(brief, templateId),
        templateId,
        backend: 'browser',
      },
      {
        beforeActivate: async () => {
          await this.seedProject(brief, prompt, attachments, templateId, expandNotes);
        },
      }
    );

    // A project born in Flow reopens in Flow after a reload.
    this.workspaceMode.remember('flow');
    return { templateId, expandNotes };
  }

  /** Everything written into the fresh project before its first scene loads. */
  private async seedProject(
    brief: PrototypeBrief,
    prompt: string,
    attachments: readonly ComposerAttachment[],
    templateId: string,
    notes: string[]
  ): Promise<void> {
    // Attachments become project files FIRST: a reference that lives only in the conversation is
    // gone the moment the context is compacted (design §5.7).
    const references = await this.persistAttachments(attachments, notes);

    const recipe = await this.readOptional('design/recipe.md');
    if (!recipe) {
      notes.push(
        `Template "${templateId}" has no design/recipe.md, so no tunables or placeholders were applied.`
      );
    }
    const declared: ReadonlyMap<string, RecipeTunable> = recipe
      ? parseRecipeTunables(recipe)
      : new Map<string, RecipeTunable>();
    const placeholders = recipe ? parseRecipePlaceholders(recipe) : [];

    const resolution = resolveTunables(brief.tunables, declared);
    await this.applyTunables(resolution, brief, declared, notes);
    await this.tintPlaceholders(placeholders, brief.style.palette, notes);
    await this.writeDesignDocs(brief, prompt, references, resolution, notes);
  }

  /** Images → `references/`, documents → `design/source/` (design §5.7's hard rule). */
  private async persistAttachments(
    attachments: readonly ComposerAttachment[],
    notes: string[]
  ): Promise<PrototypeBriefReference[]> {
    const references: PrototypeBriefReference[] = [];
    for (const attachment of attachments) {
      const path = attachmentProjectPath(attachment);
      try {
        if (attachment.kind === 'image') {
          const blob = base64ToBlob(attachment.base64, attachment.mimeType);
          await this.storage.writeBinaryFile(path, await blob.arrayBuffer());
          references.push({
            path: `res://${path}`,
            kind: 'image',
            role: attachment.role,
            note: `Attached with the first prompt as a ${attachment.role} reference.`,
          });
        } else {
          await this.storage.writeTextFile(
            path,
            `# ${attachment.name}\n\n> Attached by the user with the first prompt. Read the section you need; do not inline the whole file.\n\n${attachment.content}\n`
          );
          references.push({
            path,
            kind: 'doc',
            note: 'Source document supplied with the first prompt.',
          });
        }
      } catch (error) {
        notes.push(
          `Could not save ${attachment.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return references;
  }

  /** Write resolved tunables into every scene that carries the named node. */
  private async applyTunables(
    resolution: TunableResolution,
    brief: PrototypeBrief,
    declared: ReadonlyMap<string, { node: string; component?: string; property: string }>,
    notes: string[]
  ): Promise<void> {
    const patches: ScenePatch[] = resolution.applied.map(entry => ({
      node: entry.tunable.node,
      component: entry.tunable.component,
      property: entry.tunable.property,
      value: entry.value,
    }));

    // The palette's dominant colour is the background unless the brief asked for something else.
    const bgTunable = declared.get('bgColor');
    const backgroundColor = paletteColorForRole('background', brief.style.palette);
    if (bgTunable && backgroundColor && !('bgColor' in brief.tunables)) {
      patches.push({
        node: bgTunable.node,
        component: bgTunable.component,
        property: bgTunable.property,
        value: backgroundColor,
      });
    }

    if (patches.length === 0) {
      return;
    }

    const remaining = new Set(patches);
    for (const path of await this.listScenes()) {
      if (remaining.size === 0) break;
      try {
        const text = await this.storage.readTextFile(path);
        if (!looksLikeScene(text)) continue;
        const result = applyScenePatches(text, [...remaining]);
        if (result.applied.length > 0) {
          await this.storage.writeTextFile(path, result.text);
          for (const patch of result.applied) {
            remaining.delete(patch);
          }
        }
      } catch (error) {
        notes.push(
          `Could not patch ${path}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    for (const patch of remaining) {
      notes.push(`No node "${patch.node}" in any scene — "${patch.property}" was left at default.`);
    }
    for (const entry of resolution.applied.filter(applied => applied.clamped)) {
      notes.push(
        `Tunable "${entry.tunable.key}" was clamped to ${entry.value} (asked for ${entry.requested}).`
      );
    }
    for (const entry of resolution.rejected) {
      notes.push(`Tunable "${entry.key}" was ignored: ${entry.reason}.`);
    }
  }

  /** Recolour the recipe's near-white placeholder art so the skeleton looks deliberate at T0. */
  private async tintPlaceholders(
    placeholders: readonly RecipePlaceholder[],
    palette: readonly string[],
    notes: string[]
  ): Promise<void> {
    if (placeholders.length === 0 || palette.length === 0) {
      return;
    }
    for (const placeholder of placeholders) {
      const color = paletteColorForRole(placeholder.role, palette);
      if (!color || !/\.(png|jpe?g|webp)$/i.test(placeholder.file)) {
        continue;
      }
      const path = await this.resolvePlaceholderPath(placeholder.file);
      if (!path) {
        notes.push(`Placeholder "${placeholder.file}" is not in the project; nothing was tinted.`);
        continue;
      }
      try {
        const source = await this.storage.readBlob(path);
        const tinted = await tintImage(source, color);
        if (tinted.blob !== source) {
          await this.storage.writeBinaryFile(path, await tinted.blob.arrayBuffer());
        }
      } catch (error) {
        notes.push(
          `Could not tint ${path}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * Recipes name placeholders however reads best in their table — `sprites/ph-player.png` in one,
   * a bare `ph-avatar.png` in another — so the path is resolved against the conventional sprite
   * folders rather than requiring every recipe author to spell out the same prefix.
   */
  private async resolvePlaceholderPath(file: string): Promise<string | null> {
    const base = file.split('/').pop() ?? file;
    const candidates = [file, `sprites/${base}`, `assets/sprites/${base}`, base];
    for (const candidate of candidates) {
      try {
        await this.storage.readBlob(candidate);
        return candidate;
      } catch {
        // Try the next conventional location.
      }
    }
    return null;
  }

  private async writeDesignDocs(
    brief: PrototypeBrief,
    prompt: string,
    references: readonly PrototypeBriefReference[],
    resolution: TunableResolution,
    notes: string[]
  ): Promise<void> {
    const withReferences: PrototypeBrief = { ...brief, references };
    await this.writeFile(
      FLOW_BRIEF_PATH,
      renderBriefMarkdown(withReferences, prompt, resolution, notes),
      notes
    );
    await this.writeFile(FLOW_PROGRESS_PATH, renderProgressMarkdown(brief), notes);
    await this.writeFile(FLOW_DECISIONS_PATH, renderDecisionsMarkdown(), notes);
    if (brief.style.artStyle || brief.style.mood || brief.style.palette.length > 0) {
      await this.writeFile('design/style.md', renderStyleMarkdown(brief, references), notes);
    }
  }

  // -- first turn ------------------------------------------------------------

  /**
   * Hand the agent ONE increment. A fresh conversation per increment is the cheapest large
   * reliability win in the plan (design §5.4): the same task a long polluted thread circled on is
   * solved without hints when it starts from a compact brief.
   */
  async startFirstTurn(brief: PrototypeBrief, prompt: string): Promise<void> {
    // The system prompt carries a scene outline, and the Flow shell opens the scene as it starts the
    // stage — a turn sent a beat too early would start the agent on an empty outline and it would
    // spend its first tool calls re-discovering a project that was about to load anyway.
    await this.waitForActiveScene();
    await this.agentChat.newConversation();
    await this.agentChat.send(
      renderFirstTurnMessage(brief, prompt, await buildProjectMap(this.storage))
    );
  }

  /** Resolve once a scene is active, or after {@link SCENE_WAIT_MS} — never blocking forever. */
  private async waitForActiveScene(): Promise<void> {
    const deadline = Date.now() + SCENE_WAIT_MS;
    while (Date.now() < deadline) {
      if (appState.scenes.activeSceneId) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // -- helpers ---------------------------------------------------------------

  /** The recipe the planner named, else the fallback recipe, else whatever template exists. */
  private resolveTemplateId(recipeId: string, notes: string[]): string {
    const available = this.templates.getTemplates();
    const aliased = RECIPE_TEMPLATE_ALIASES[recipeId] ?? recipeId;
    if (available.some(template => template.id === aliased)) {
      return aliased;
    }
    if (available.some(template => template.id === FALLBACK_RECIPE_ID)) {
      notes.push(`Planner asked for \`${recipeId}\`; started from ${FALLBACK_RECIPE_ID}.`);
      return FALLBACK_RECIPE_ID;
    }
    const substitute =
      available.find(template => template.id === 'minigame-2d') ??
      available.find(template => template.projectType === '2d') ??
      available[0];
    if (!substitute) {
      throw new Error('No project templates are bundled with the editor.');
    }
    notes.push(
      `Recipe \`${recipeId}\` is not installed yet; started from the "${substitute.title}" template.`
    );
    return substitute.id;
  }

  private buildManifest(brief: PrototypeBrief, templateId: string): ProjectManifest {
    const template = this.templates.getTemplate(templateId);
    const manifest = createDefaultProjectManifest();
    const targetPlatform = template?.targetPlatform ?? manifest.targetPlatform;
    return {
      ...manifest,
      viewportBaseSize: {
        width: template?.viewport.width ?? manifest.viewportBaseSize.width,
        height: template?.viewport.height ?? manifest.viewportBaseSize.height,
      },
      projectType: template?.projectType ?? manifest.projectType,
      targetPlatform,
      quality: createDefaultQualitySettings(targetPlatform),
      ...(template?.entryScenePath ? { defaultExportScenePath: template.entryScenePath } : {}),
      metadata: {
        ...(manifest.metadata ?? {}),
        projectName: brief.title,
        templateId,
      },
    };
  }

  /** Every `.pix3scene` in the fresh project, scenes/ first (prefabs live under it). */
  private async listScenes(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (path: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let entries;
      try {
        entries = await this.storage.listDirectory(path);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.kind === 'directory') {
          await walk(entry.path, depth + 1);
        } else if (entry.name.endsWith('.pix3scene')) {
          found.push(entry.path);
        }
      }
    };
    await walk('scenes', 0);
    return found;
  }

  private async readOptional(path: string): Promise<string | null> {
    try {
      return await this.storage.readTextFile(path);
    } catch {
      return null;
    }
  }

  private async writeFile(path: string, contents: string, notes: string[]): Promise<void> {
    try {
      await this.storage.writeTextFile(path, contents);
    } catch (error) {
      notes.push(
        `Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private setStatus(status: PrototypeBootstrapStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const isImageAttachment = (attachment: ComposerAttachment): attachment is ComposerImageAttachment =>
  attachment.kind === 'image';

const toImageBlock = (image: ComposerImageAttachment): LlmImageBlock => ({
  type: 'image',
  mimeType: image.mimeType,
  data: image.base64,
});

const PLANNER_SYSTEM_PROMPT = [
  'You plan playable game prototypes for the Pix3 editor. You are given a short idea and you return',
  'a compact JSON brief that a deterministic expander turns into a real project.',
  '',
  'Rules:',
  '- Reply with ONE JSON object and nothing else. No prose, no markdown fences.',
  '- Pick `recipeId` from the catalog you are given. Never invent an id.',
  '- `increments` is 3 to 5 steps, smallest playable slice first (controls and the core loop),',
  '  polish last. The first step must be provable by playing the game.',
  '- `tunables` may only use keys the recipe declares; leave it empty when unsure. Guessing a key',
  '  is worse than omitting it.',
  '- `style.palette` is 3 to 5 `#rrggbb` colours. If a palette is supplied to you, keep it.',
  '- Keep every string short: `pitch` is one line, entity prompts are one sentence.',
].join('\n');

/** The planner's user turn: the idea, the catalog, references, and the exact JSON shape wanted. */
export const buildPlannerPrompt = (
  request: PrototypeBootstrapRequest,
  attachments: readonly ComposerAttachment[],
  palette: readonly string[],
  visionNotes: readonly string[]
): string => {
  const lines: string[] = [
    `IDEA: ${request.prompt.trim() || '(no text — see the references)'}`,
    '',
  ];

  if (request.recipeId) {
    lines.push(`The user already chose the recipe: use "${request.recipeId}" as \`recipeId\`.`, '');
  } else {
    lines.push('RECIPE CATALOG (choose exactly one id):');
    for (const recipe of RECIPE_CATALOG) {
      lines.push(`- ${recipe.id}: ${recipe.blurb}`);
    }
    lines.push('');
  }

  if (palette.length > 0) {
    lines.push(
      `PALETTE (already extracted from the user's style reference — reuse it verbatim): ${palette.join(', ')}`,
      ''
    );
  }

  for (const note of visionNotes) {
    lines.push(`REFERENCE IMAGE — ${note}`, '');
  }

  const docs = attachments.filter(attachment => attachment.kind === 'text');
  for (const doc of docs) {
    lines.push(
      `DOCUMENT "${doc.name}" (excerpt — the full file is saved in the project):`,
      summarizeDocument(doc.content),
      ''
    );
  }

  lines.push(
    'When the idea and a document disagree, the idea wins; a document beats an image.',
    '',
    'Return JSON of exactly this shape:',
    JSON.stringify(
      {
        title: 'short project name',
        pitch: 'one line',
        recipeId: RECIPE_CATALOG[1].id,
        style: { palette: ['#101820', '#f5ae39'], artStyle: 'flat vector', mood: 'playful' },
        entities: [
          { role: 'player', name: 'Hero', assetSpec: { prompt: 'one sentence', sizeHint: 128 } },
        ],
        tunables: {},
        winLose: { win: 'how the player wins', lose: 'how the player loses' },
        increments: ['controls + core loop', 'hazards', 'win/lose', 'art pass'],
      },
      null,
      2
    )
  );
  return lines.join('\n');
};

/**
 * Budgeted excerpt of an attached document: the headings plus the opening, capped.
 *
 * A 20-page GDD pasted into the prompt is the exact mistake that burned 472K input tokens in eval
 * S1. The full file is written to `design/source/` and the agent reads the section it needs.
 */
export const summarizeDocument = (content: string, budget = DOC_EXCERPT_CHARS): string => {
  const trimmed = content.trim();
  if (trimmed.length <= budget) {
    return trimmed;
  }
  const headings = trimmed
    .split('\n')
    .filter(line => /^\s{0,3}#{1,4}\s+\S/.test(line) || /^\s*[-*]\s+\S/.test(line))
    .slice(0, 40)
    .join('\n');
  const head = trimmed.slice(0, Math.max(0, budget - headings.length - 40));
  return `${head}\n…\nOUTLINE:\n${headings}`;
};

/**
 * Find and parse the outermost JSON object in a model reply.
 *
 * Providers disagree about structured output and several bridge-backed models ignore the request
 * entirely, so the parser assumes the worst: fences, a preamble ("Here's the brief:"), a trailing
 * explanation. Scans for the first `{` and its matching `}` while respecting string literals, which
 * is what makes a brace inside a `pitch` harmless. Returns null rather than throwing — the caller's
 * fallback is a normal outcome here, not an error path.
 */
export const extractJsonObject = (raw: string): Record<string, unknown> | null => {
  const text = raw.replace(/```[a-zA-Z]*\n?/g, '').trim();
  const start = text.indexOf('{');
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, index + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

/**
 * Field-by-field validation of a parsed planner reply.
 *
 * Every field is independently recoverable: a brief missing `increments` still expands, it just
 * gets the default checklist and a note. Nothing here throws, and nothing silently accepts a wrong
 * *type* — `tunables: "fast"` is dropped rather than coerced, because a coerced tunable would be
 * written into a scene while a dropped one becomes a sentence the agent can act on.
 */
export const validateBrief = (
  value: Record<string, unknown>,
  prompt: string
): { brief: PrototypeBrief; issues: string[] } => {
  const issues: string[] = [];
  const base = fallbackBrief(prompt);

  const title = asText(value.title) ?? base.title;
  const pitch = asText(value.pitch) ?? base.pitch;

  let recipeId = asText(value.recipeId) ?? '';
  if (!recipeId) {
    issues.push('The planner returned no recipeId.');
    recipeId = FALLBACK_RECIPE_ID;
  } else if (!RECIPE_CATALOG.some(recipe => recipe.id === recipeId)) {
    issues.push(`Planner asked for an unknown recipe \`${recipeId}\`.`);
    recipeId = FALLBACK_RECIPE_ID;
  }

  const styleValue = isRecord(value.style) ? value.style : {};
  const palette = Array.isArray(styleValue.palette)
    ? styleValue.palette.filter(
        (entry): entry is string => typeof entry === 'string' && /^#[0-9a-f]{3,8}$/i.test(entry)
      )
    : [];
  if (palette.length === 0) {
    issues.push('The planner returned no usable palette; placeholders keep their neutral colours.');
  }

  const entities: PrototypeBriefEntity[] = [];
  if (Array.isArray(value.entities)) {
    for (const raw of value.entities) {
      if (!isRecord(raw)) continue;
      const name = asText(raw.name);
      const role = asText(raw.role);
      if (!name || !role) continue;
      const spec = isRecord(raw.assetSpec) ? raw.assetSpec : {};
      const sizeHint =
        typeof spec.sizeHint === 'number' && spec.sizeHint > 0 ? spec.sizeHint : undefined;
      entities.push({
        role,
        name,
        assetSpec: {
          prompt: asText(spec.prompt) ?? name,
          ...(sizeHint ? { sizeHint } : {}),
        },
      });
    }
  }

  const tunables: Record<string, number | string | boolean> = {};
  if (isRecord(value.tunables)) {
    for (const [key, entry] of Object.entries(value.tunables)) {
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        tunables[key] = entry;
      } else if (typeof entry === 'string' || typeof entry === 'boolean') {
        tunables[key] = entry;
      } else {
        issues.push(`Tunable "${key}" had an unusable value and was dropped.`);
      }
    }
  }

  const winLoseValue = isRecord(value.winLose) ? value.winLose : {};
  const increments = Array.isArray(value.increments)
    ? value.increments.map(asText).filter((entry): entry is string => Boolean(entry))
    : [];
  if (increments.length === 0) {
    issues.push('The planner returned no increments; using the default checklist.');
  }

  return {
    brief: {
      title,
      pitch,
      recipeId,
      style: {
        palette,
        artStyle: asText(styleValue.artStyle) ?? '',
        mood: asText(styleValue.mood) ?? '',
      },
      entities,
      tunables,
      winLose: {
        win: asText(winLoseValue.win) ?? base.winLose.win,
        lose: asText(winLoseValue.lose) ?? base.winLose.lose,
      },
      increments: increments.length > 0 ? increments : base.increments,
      ...(asText(value.ctaUrl) ? { ctaUrl: asText(value.ctaUrl) as string } : {}),
    },
    issues,
  };
};

/**
 * The brief the flow uses when there is no usable planner output: the fallback recipe plus the
 * user's own words. Not an error state — the project still expands and the agent still gets the raw
 * prompt, which is the whole point of making the fallback a requirement (design §5.3).
 */
export const fallbackBrief = (prompt: string): PrototypeBrief => ({
  title: deriveTitle(prompt),
  pitch: prompt.trim().split('\n')[0]?.slice(0, 160) || 'A new prototype.',
  recipeId: FALLBACK_RECIPE_ID,
  style: { palette: [], artStyle: '', mood: '' },
  entities: [],
  tunables: {},
  winLose: { win: 'To be decided with the player.', lose: 'To be decided with the player.' },
  increments: [
    'Controls and the core loop',
    'Hazards or opposition',
    'Win / lose condition',
    'Art and feel pass',
  ],
});

/** A short project name out of the prompt's first words. */
export const deriveTitle = (prompt: string): string => {
  const words = prompt
    .trim()
    .replace(/["'`]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
  const title = words.slice(0, 48).trim();
  if (!title) {
    return 'New Prototype';
  }
  return title.charAt(0).toUpperCase() + title.slice(1);
};

/** Post-planner overrides the code owns, not the model: a pinned recipe and a measured palette. */
const applyPlannerOverrides = (
  brief: PrototypeBrief,
  request: PrototypeBootstrapRequest,
  palette: readonly string[],
  attachments: readonly ComposerAttachment[]
): PrototypeBrief => ({
  ...brief,
  recipeId: request.recipeId ?? brief.recipeId,
  style: {
    ...brief.style,
    palette: palette.length > 0 ? [...palette] : brief.style.palette,
  },
  references: attachments.map(attachment => ({
    path:
      attachment.kind === 'image'
        ? `res://${attachmentProjectPath(attachment)}`
        : attachmentProjectPath(attachment),
    kind: attachment.kind === 'image' ? ('image' as const) : ('doc' as const),
    ...(attachment.kind === 'image' ? { role: attachment.role } : {}),
  })),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

// -- generated documents -----------------------------------------------------

/**
 * `design/brief.md` — the agent's memory of the idea. `FlowPlanService` reads the `# Title` and the
 * `**Pitch:**` line out of it for the Flow header, so those two lines are load-bearing format.
 */
export const renderBriefMarkdown = (
  brief: PrototypeBrief,
  prompt: string,
  resolution: TunableResolution,
  notes: readonly string[]
): string => {
  const lines: string[] = [
    `# ${brief.title}`,
    '',
    `**Pitch:** ${brief.pitch}`,
    '',
    `**Recipe:** \`${brief.recipeId}\``,
    '',
    '## What the user asked for',
    '',
    prompt.trim() || '(no prompt text — see the references)',
    '',
    '## Win / lose',
    '',
    `- **Win:** ${brief.winLose.win}`,
    `- **Lose:** ${brief.winLose.lose}`,
    '',
    '## Style',
    '',
    `- Palette: ${brief.style.palette.length > 0 ? brief.style.palette.join(', ') : '(recipe defaults)'}`,
    `- Art style: ${brief.style.artStyle || '(unspecified)'}`,
    `- Mood: ${brief.style.mood || '(unspecified)'}`,
  ];

  if (brief.entities.length > 0) {
    lines.push('', '## Entities', '');
    for (const entity of brief.entities) {
      const size = entity.assetSpec.sizeHint ? ` (~${entity.assetSpec.sizeHint}px)` : '';
      lines.push(`- **${entity.name}** — \`${entity.role}\`: ${entity.assetSpec.prompt}${size}`);
    }
  }

  if (brief.ctaUrl) {
    lines.push('', `**CTA URL:** ${brief.ctaUrl}`);
  }

  if (brief.references && brief.references.length > 0) {
    lines.push('', '## References', '');
    for (const reference of brief.references) {
      const role = reference.role ? ` — ${reference.role}` : '';
      lines.push(`- \`${reference.path}\` (${reference.kind}${role})`);
    }
    lines.push(
      '',
      'Style references drive generate-prompts as WORDS; never pass a whole scene to the image',
      'generator as a reference — it copies the composition.'
    );
  }

  if (resolution.applied.length > 0) {
    lines.push('', '## Applied tunables', '');
    for (const entry of resolution.applied) {
      const clamped = entry.clamped ? ` (clamped from ${entry.requested})` : '';
      lines.push(`- \`${entry.tunable.key}\` = ${entry.value}${clamped}`);
    }
  }

  if (resolution.unknown.length > 0) {
    lines.push(
      '',
      '## For the agent — asked for, not applied',
      '',
      'The planner asked for these but the recipe declares no such tuning point, so nothing was',
      'guessed at. Decide whether each is worth building, and say so.',
      ''
    );
    for (const entry of resolution.unknown) {
      lines.push(`- \`${entry.key}\`: ${JSON.stringify(entry.value)}`);
    }
  }

  if (notes.length > 0) {
    lines.push('', '## Bootstrap notes', '');
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push('');
  return lines.join('\n');
};

/**
 * `design/progress.md` — the increment checklist. The format is parsed by `FlowPlanService` and
 * must not drift: `- [ ]` pending, `- [~]` in progress (exactly one), `- [x]` done, with an optional
 * `— note` tail that becomes the tracker's tooltip.
 */
export const renderProgressMarkdown = (brief: PrototypeBrief): string => {
  const lines = [
    `# Progress — ${brief.title}`,
    '',
    'One increment per turn. Mark the one you are working on `- [~]`, tick it `- [x]` only after',
    'you have PROVED it in the running game, and add how you proved it after an em dash.',
    '',
  ];
  brief.increments.forEach((increment, index) => {
    lines.push(`- [${index === 0 ? '~' : ' '}] ${increment}`);
  });
  lines.push('');
  return lines.join('\n');
};

/** `design/decisions.md` — the scaffold the agent appends to when a fork is resolved. */
export const renderDecisionsMarkdown = (): string =>
  [
    '# Decisions',
    '',
    'Every fork the user settled, so nothing is asked twice. Append one entry per decision:',
    '',
    '```',
    '## <the question>',
    '- **Chosen:** <the answer>',
    '- **Why:** <one line>',
    '```',
    '',
  ].join('\n');

/** `design/style.md` — the tokens every generate-prompt reuses, so the art stays consistent. */
export const renderStyleMarkdown = (
  brief: PrototypeBrief,
  references: readonly PrototypeBriefReference[]
): string => {
  const styleRefs = references.filter(reference => reference.role === 'style');
  return [
    `# Style — ${brief.title}`,
    '',
    'Paste these tokens into every `generate_asset` prompt so the art stays one set.',
    '',
    `- **Palette:** ${brief.style.palette.length > 0 ? brief.style.palette.join(', ') : '(recipe defaults)'}`,
    `- **Art style:** ${brief.style.artStyle || '(unspecified)'}`,
    `- **Mood:** ${brief.style.mood || '(unspecified)'}`,
    '',
    styleRefs.length > 0
      ? `Derived from ${styleRefs.map(reference => `\`${reference.path}\``).join(', ')} — the palette was measured from the image, not guessed.`
      : 'No style reference was supplied; the palette came from the brief.',
    '',
    'Use the tokens as WORDS. Pass a reference image to the generator only for the one asset it',
    'depicts — a full scene handed over as a reference comes back as a copied composition.',
    '',
  ].join('\n');
};

/**
 * The opening message: the brief in compact form and one instruction — take the FIRST increment,
 * prove it, then come back with options (design §3.2 step 4/5).
 */
export const renderFirstTurnMessage = (
  brief: PrototypeBrief,
  prompt: string,
  projectMap = ''
): string => {
  const lines: string[] = [
    `New prototype: **${brief.title}** — ${brief.pitch}`,
    '',
    `The project is already expanded from the \`${brief.recipeId}\` recipe and is running. Read`,
    '`design/recipe.md` for its node map, tunables and extension points, and `design/brief.md` for',
    'the idea (both are short, and they are your memory across compaction).',
    '',
    `What the user asked for: "${prompt.trim()}"`,
    '',
    'Plan (also in `design/progress.md`):',
  ];
  brief.increments.forEach((increment, index) => {
    lines.push(`${index + 1}. ${increment}${index === 0 ? '  ← take this one' : ''}`);
  });
  lines.push(
    '',
    'Take the **first increment only**. Do not attempt the rest of the list this turn.',
    'Prove it in the running game before you report: compile, play, drive it with `game_input`,',
    'and read errors. If a fork would change the structure of the scene or the scripts, ask with',
    '`ask_user` instead of guessing — that is a legitimate end of turn.',
    '',
    'Then update `design/progress.md` and reply with one short summary plus 2–3 concrete options',
    'for what to do next.'
  );
  if (projectMap) {
    lines.push('', '---', '', projectMap);
  }
  return lines.join('\n');
};
