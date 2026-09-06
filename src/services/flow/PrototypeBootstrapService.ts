import { inject, injectable, injectLazy, type LazyService } from '@/fw/di';
import { IDEA_TEMPLATE_ID } from '@/services/flow/FlowStageService';
import { FLOW_REFERENCES_INDEX_PATH } from '@/services/flow/FlowReferencesService';
import { extractDecisionEntries } from '@/services/flow/decision-log';
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
import { base64ToBlob, tintImage } from '@/services/image-gen/image-ops';
import type { LlmImageBlock, LlmMessage } from '@/services/llm/LlmTypes';
import {
  applyScenePatches,
  listSceneNodes,
  looksLikeScene,
  paletteColorForRole,
  parseRecipePlaceholders,
  parseRecipeTunables,
  resolveTunables,
  IDEA_PRESERVED_PATHS,
  type RecipePlaceholder,
  type RecipeTunable,
  type ScenePatch,
  type TunableResolution,
} from '@/services/flow/recipe-contract';
import { FlowReferencesService } from '@/services/flow/FlowReferencesService';
import {
  hexToHsl,
  isHex,
  lum,
  normalizeTheme,
  presetTheme,
  type ForgeTheme,
  type PaletteId,
} from '@/services/uikit';
import { UI_CONTROL_NODE_TYPES, planSkinPatches } from '@/services/uikit-editor/skin-planner';
import type { UiKitThemeService } from '@/services/uikit-editor/UiKitThemeService';
import type { UiKitProjectWriter } from '@/services/uikit-editor/UiKitProjectWriter';
import { ideaTimeline } from '@/services/flow/idea-timeline';
import { FlowStageService } from '@/services/flow/FlowStageService';
import {
  attachmentProjectPath,
  type ComposerAttachment,
  type ComposerImageAttachment,
} from '@/ui/shared/composer-attachments';
import { buildProjectMap } from '@/services/flow/flow-project-map';
import {
  FLOW_BRIEF_PATH,
  FLOW_DECISIONS_PATH,
  FLOW_GDD_PATH,
  FLOW_PROGRESS_PATH,
} from '@/services/flow/FlowPlanService';
import {
  FLOW_RECIPE_HINT_METADATA_KEY,
  FLOW_STAGE_METADATA_KEY,
} from '@/services/flow/FlowStageService';

// ---------------------------------------------------------------------------
// The brief (design §5.3)
// ---------------------------------------------------------------------------

/**
 * A named look the expander can apply on its own, with no model in the loop.
 *
 * The point of naming looks at all is budget: ~70% of what reads as "designed" in a one-shot
 * generated game is static cosmetics (glow, bloom, a dark ground, a loud accent), and cosmetics
 * chosen by code cost nothing per project while the same choices made by an agent cost a turn.
 */
export type PrototypeTheme = 'neon' | 'pastel' | 'retro' | 'minimal';

export interface PrototypeBriefStyle {
  readonly palette: string[];
  readonly artStyle: string;
  readonly mood: string;
  /** Named look. Absent (the common case) → {@link defaultThemeForRecipe}. */
  readonly theme?: PrototypeTheme;
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
  /**
   * Render target, when the idea asks for one. Absent means "take the recipe's own" — which is
   * mobile for every recipe that ships. Only an explicit request for a high-end/desktop look sets
   * `desktop`, and that is what buys PBR materials (see `defaultMaterialTypeForProject`).
   */
  readonly targetPlatform?: 'mobile' | 'desktop';
  /** Style tokens for EVERY later generation — palette comes from a reference when there is one. */
  readonly style: PrototypeBriefStyle;
  readonly entities: readonly PrototypeBriefEntity[];
  /** Values for tuning points the recipe declares. Unknown keys are reported, never guessed. */
  readonly tunables: Readonly<Record<string, number | string | boolean>>;
  readonly winLose: { readonly win: string; readonly lose: string };
  /** 3–5 steps; becomes the `design/progress.md` checklist the plan tracker reads. */
  readonly increments: readonly string[];
  /**
   * 2–4 spectacle beats of the genre (a multiplier, combo popups, a tilt). They join the same
   * checklist as late items, so the agent can fold one in whenever it is a one-liner next to the
   * mechanic it is already building instead of deferring all feel to a final polish pass.
   */
  readonly wow?: readonly string[];
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
 * name. The playable-ad "recipe" is the shipped `playable-2d` template (tap-gate + CTA hook)
 * promoted into the catalog with a `design/recipe.md`; without this alias the planner's
 * correct answer would silently fall back to the arena recipe.
 */
export const RECIPE_TEMPLATE_ALIASES: Readonly<Record<string, string>> = {
  'recipe-playable-ad': 'playable-2d',
  'recipe-scene-3d': 'playable-3d',
};

/**
 * The recipe a 3D idea falls back to when nothing else is known about it. Kept as a named constant
 * because the fallbacks below have to reach for it: a 3D idea answered with a 2D recipe is not a
 * degraded version of the ask, it is a different game.
 *
 * The grid recipe rather than the generic 3D stage, because the stage is a *blank* — it hands the
 * agent a camera, two lights and a placeholder to replace, while the grid hands it a game that
 * already plays. "The one that plays is the better guess" holds only for **silence**, though: an
 * *invented* 3D id is the planner saying the catalog did not fit, and that case takes the blank 3D
 * stage instead (see {@link validateBrief}).
 */
export const FALLBACK_3D_RECIPE_ID = 'recipe-grid-3d';

/**
 * The recipe with no mechanics: score/lives/timer, a HUD and a win/lose overlay, and nothing else.
 *
 * It is the answer to an *affirmative* signal that the catalog does not fit — the planner naming a
 * recipe that does not exist. That is a different situation from the one {@link FALLBACK_RECIPE_ID}
 * covers (a reply that told us nothing about the idea at all), and the two used to share an answer:
 * an idea shaped like snake was answered with the arena's pointer steering and falling spawners, so
 * the agent's first increment went on *demolishing* a mechanic before it could build one.
 */
export const BLANK_RECIPE_ID = 'recipe-blank-2d';

/**
 * The 3D counterpart of {@link BLANK_RECIPE_ID}: `recipe-scene-3d` is already a bare stage (camera,
 * lights, ground, a 2D UI layer, a tap gate and a CTA), so 3D needs no second blank authored for it.
 */
export const BLANK_3D_RECIPE_ID = 'recipe-scene-3d';

export const RECIPE_CATALOG: ReadonlyArray<{ id: string; blurb: string }> = [
  {
    id: 'recipe-tapper-2d',
    blurb:
      'objects appear and tapping them is the whole game; timer or lives. Tappers, whack-a-mole, catch-the-falling, clickers.',
  },
  {
    id: FALLBACK_RECIPE_ID,
    blurb:
      'an avatar moves in a bounded field while a spawner sends pickups/hazards at it; touching them scores or hurts. Dodgers, collectors, top-down survival, runners. NOT grid or turn-based movement — its steering is continuous.',
  },
  {
    id: 'recipe-bouncer-2d',
    blurb:
      'a ball under gravity bounces off walls, paddles and bumpers; a paddle keeps it in play. Breakout, pong, plinko, pinball.',
  },
  {
    id: BLANK_RECIPE_ID,
    blurb:
      "NO mechanics — an empty 2D field with score/lives/timer bookkeeping, a HUD and a win/lose overlay already wired; the first increment builds the core mechanic itself, CONTROLS INCLUDED. Pick it when the idea's core loop is not what any recipe above ships: grid or turn-based movement (snake, sokoban, match-3), word/card/board games, builders, physics contraptions, idle games. Deleting a wrong mechanic costs more than building on this blank.",
  },
  {
    id: 'recipe-playable-ad',
    blurb: 'a playable ad: tap-to-start audio gate, a short loop, then a CTA screen to the store.',
  },
  {
    id: FALLBACK_3D_RECIPE_ID,
    blurb:
      'a solid block of cubes in 3D that you carve by tapping; some cubes are core and cost a life. Voxel carving, 3D minesweeper, layer puzzles, tap-to-mine, "chip away to reveal the shape".',
  },
  {
    id: 'recipe-scene-3d',
    blurb:
      'a bare 3D stage: perspective camera, lights and solid geometry on a ground plane under a 2D UI layer, with a tap-to-start gate and a CTA end screen. Pick it for a 3D idea that is NOT a grid of things to tap — anything else three-dimensional starts here. Faking 3D with 2D sprites is not the same game.',
  },
];

// ---------------------------------------------------------------------------
// Style packs (contract §C1)
// ---------------------------------------------------------------------------

/** Every theme the planner may name, in the order the prompt lists them. */
export const PROTOTYPE_THEMES: readonly PrototypeTheme[] = ['neon', 'pastel', 'retro', 'minimal'];

/** The look for a recipe whose brief names none. */
export const DEFAULT_THEME: PrototypeTheme = 'minimal';

/**
 * Genre → look for a brief that says nothing about style, which is most of them.
 *
 * Only the bouncer is opinionated so far: it is the recipe whose scene carries the bloom pass the
 * neon pack turns up, and a theme naming tunables a recipe does not declare buys nothing.
 */
const RECIPE_THEME_DEFAULTS: Readonly<Record<string, PrototypeTheme>> = {
  'recipe-bouncer-2d': 'neon',
};

/**
 * What each look means, expressed **only** as values for tunables recipes declare.
 *
 * Going through the tunables pipeline rather than editing scene YAML directly is the whole safety
 * story: a key the recipe does not declare is reported to the agent in `design/brief.md` and
 * nothing is guessed at (see `resolveTunables`), so a pack may name a forward-looking key —
 * `bloomIntensity` exists in the bouncer recipe and nowhere else — without breaking the recipes
 * that have not caught up.
 *
 * Every ground is dark on purpose. When no palette was measured the recipe's placeholder art stays
 * near-white, so a light "pastel" ground would hide the entire game; the pastel pack is a soft dusk
 * instead, and pastel accents still arrive through the palette.
 */
export const THEME_TUNABLES: Readonly<
  Record<PrototypeTheme, Readonly<Record<string, number | string | boolean>>>
> = {
  neon: { bgColor: '#05030f', boardColor: '#120a33', bloomIntensity: 1.2 },
  pastel: { bgColor: '#2b2740', boardColor: '#3b3559', bloomIntensity: 0.35 },
  retro: { bgColor: '#150d20', boardColor: '#241533', bloomIntensity: 0.6 },
  minimal: { bgColor: '#12141c', boardColor: '#1d212e' },
};

/** The look a recipe gets when the brief names none. */
export const defaultThemeForRecipe = (recipeId: string): PrototypeTheme =>
  RECIPE_THEME_DEFAULTS[recipeId] ?? DEFAULT_THEME;

/** The look actually used: the brief's own pick, else the recipe genre's default. */
export const effectiveTheme = (brief: PrototypeBrief): PrototypeTheme =>
  brief.style.theme ?? defaultThemeForRecipe(brief.recipeId);

/**
 * The tunable values the expander applies: the theme pack **under** whatever the brief asked for.
 *
 * Precedence is the point. A key in the brief always wins, because that one came from the user's
 * idea and the pack is a code-owned default; and a background measured from the user's own style
 * reference wins too, so the pack's `bgColor` steps aside whenever the palette has one (the palette
 * background is patched separately in `applyTunables`).
 */
export const themedTunables = (
  brief: PrototypeBrief,
  theme: PrototypeTheme = effectiveTheme(brief)
): Record<string, number | string | boolean> => {
  const paletteOwnsBackground = paletteColorForRole('background', brief.style.palette) !== null;
  const merged: Record<string, number | string | boolean> = {};
  for (const [key, value] of Object.entries(THEME_TUNABLES[theme])) {
    if (key === 'bgColor' && paletteOwnsBackground) {
      continue;
    }
    merged[key] = value;
  }
  return { ...merged, ...brief.tunables };
};

// ---------------------------------------------------------------------------
// The UI kit the expander bakes (plan Ф5)
// ---------------------------------------------------------------------------

/**
 * Which UI Kit Forge preset each named look stands for.
 *
 * Deliberately a 1:1 table rather than a set of theme deltas: the presets already ARE the
 * shape vocabulary ("Candy Pop" is round, glossy and soft-shadowed; "Flat" is none of those),
 * so a look only has to name one. An unmapped look falls back to `Standard`.
 */
export const UI_PRESET_FOR_THEME: Readonly<Record<PrototypeTheme, string>> = {
  neon: 'Brawl Stars',
  pastel: 'Candy Pop',
  retro: 'Bombastic',
  minimal: 'Flat',
};

/** The palette roles the expander bakes — everything the four UI node types can ask for. */
export const UI_KIT_BOOTSTRAP_ROLES: readonly PaletteId[] = ['green', 'blue', 'red', 'gray'];

export interface DerivedUiKitTheme {
  preset: string;
  theme: ForgeTheme;
}

/**
 * The project's `ForgeTheme`, derived from the brief with no model in the loop.
 *
 * Two inputs, both already settled by the time this runs: the named look picks the PRESET
 * (shape, gloss, shadow, font), and the brief's palette — the same list `design/style.md`
 * carries — pins the semantic ROLES as absolute hexes (plan §4: absolute colours, never
 * deltas).
 *
 * The role mapping follows the palette convention this file already uses everywhere else
 * ({@link paletteColorForRole}), NOT the raw array order: the palette arrives sorted by
 * coverage, so index 0 is the dominant/background colour and a primary action button painted
 * with it would vanish into the background. The accent (`player`) becomes the primary
 * action colour, the middle of the ramp (`ui`) the secondary one, and danger takes the
 * reddest hex the palette actually has, falling back to the second accent (`enemy`).
 */
export const deriveUiKitTheme = (brief: PrototypeBrief): DerivedUiKitTheme => {
  const preset = UI_PRESET_FOR_THEME[effectiveTheme(brief)] ?? 'Standard';
  const base = presetTheme(preset);

  const hexes = (brief.style.palette ?? [])
    .filter((value): value is string => isHex(value))
    .map(value => value.trim().toLowerCase());
  if (hexes.length === 0) {
    return { preset, theme: normalizeTheme(base) };
  }

  // The darkest palette entry is the outline / recess tone, but only when it is genuinely dark:
  // a pastel palette's darkest colour is still a pastel, and outlining with it loses every edge.
  const darkest = [...hexes].sort((a, b) => lum(a) - lum(b))[0];
  const darkTone = lum(darkest) < 40 ? darkest : base.darkTone;

  const palette: Partial<Record<PaletteId, string>> = {};
  const primary = paletteColorForRole('player', hexes);
  const danger = reddestHex(hexes) ?? paletteColorForRole('enemy', hexes);
  // The secondary action colour is what is LEFT after the other three roles have taken theirs:
  // one hex serving two roles would make every button on the screen the same button, and the
  // kit's own blue is a better secondary than a duplicate.
  const rest = hexes.filter(hex => hex !== primary && hex !== danger && hex !== darkest);
  const secondary = rest.length > 0 ? rest[rest.length - 1] : null;
  if (primary) palette.green = primary;
  if (secondary) palette.blue = secondary;
  if (danger && danger !== primary) palette.red = danger;

  return { preset, theme: normalizeTheme({ ...base, palette, darkTone }) };
};

/** The most saturated near-red hex of a palette, or null when it has none. */
const reddestHex = (hexes: readonly string[]): string | null => {
  let best: string | null = null;
  let bestScore = -1;
  for (const hex of hexes) {
    const [h, sat, light] = hexToHsl(hex);
    const distance = Math.min(Math.abs(h), Math.abs(360 - h));
    if (distance > 25 || sat < 30 || light < 15 || light > 75) continue;
    const score = sat - distance;
    if (score > bestScore) {
      bestScore = score;
      best = hex;
    }
  }
  return best;
};

/**
 * The colour role a UI node's NAME asks for.
 *
 * A heuristic, and cheap on purpose: the alternative is a model turn per button, and the plan's
 * whole argument for doing cosmetics in code is that a turn spent here buys nothing a table
 * cannot decide. Destructive is checked first so a "Reset progress" button does not read as a
 * confirmation just because it contains "set".
 */
export const uiKitRoleForNodeName = (name: string): PaletteId => {
  const n = name.toLowerCase();
  if (/(^|[^a-z])(quit|exit|delete|remove|reset|clear|danger|health|hp|lives?)/.test(n)) {
    return 'red';
  }
  if (/(^|[^a-z])(play|start|ok|confirm|accept|yes|go|next|continue|resume|retry)/.test(n)) {
    return 'green';
  }
  return 'blue';
};

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
  /**
   * The subset of the above the USER has to hear about, not just `design/brief.md` — currently a
   * dimensionality downgrade. Carried into the agent's first turn as an instruction to say it.
   */
  readonly userNotices: readonly string[];
}

/**
 * Template the idea stage scaffolds from: one empty 2D canvas and nothing else. A project is still
 * created up front so "Open in Studio", project activation and the storage layer all behave
 * normally — the recipe that fills it in is chosen later, on the way to the prototype (design §3.1).
 */
// Re-exported for the callers that already import it from here (`export … from` alone would not
// bind it locally, and this module uses it in four places).
export { IDEA_TEMPLATE_ID };

// Metadata sidecar for `references/` — role and origin per saved file (design §3.6). Owned by
// `FlowReferencesService` (the panel and the agent tool registry write it too) and re-exported here
// for the callers that already import it from this module.
export { FLOW_REFERENCES_INDEX_PATH };

export interface PrototypeIdeaResult {
  /** Project name, derived from the prompt with no model in the loop. */
  readonly title: string;
  readonly templateId: string;
  /** Attachments that became project files. */
  readonly references: readonly PrototypeBriefReference[];
  /** Everything that degraded on the way (a file that could not be written). */
  readonly notes: readonly string[];
}

const IDLE_STATUS: PrototypeBootstrapStatus = {
  phase: 'idle',
  message: '',
  brief: null,
  error: null,
};

/**
 * The style tokens document. Written by the expander here and — from V6 — by the references panel
 * when the user makes a mood board "the style", which is why the transition reads it back instead
 * of re-deriving the palette from an image.
 */
export const FLOW_STYLE_PATH = 'design/style.md';

const MAX_PLANNER_TOKENS = 2048;
/** Cap on how much of an attached document reaches the planner (design §5.7 — never inline a GDD). */
const DOC_EXCERPT_CHARS = 4000;
/** At most this many images are described by the vision helper before the planner call. */
const MAX_VISION_IMAGES = 2;
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

  @inject(FlowStageService)
  private readonly flowStage!: FlowStageService;

  @inject(FlowReferencesService)
  private readonly references!: FlowReferencesService;

  /**
   * The UI kit lane is injected LAZILY for two reasons: `UiKitThemeService` derives its own path
   * from this module's `FLOW_STYLE_PATH`, so a static import here would close an
   * initialization cycle, and the bake pulls the whole rasterization/asset pipeline behind it —
   * which a session that never expands a recipe should not pay for.
   */
  @injectLazy(() =>
    import('@/services/uikit-editor/UiKitThemeService').then(m => m.UiKitThemeService)
  )
  private readonly uiKitTheme!: LazyService<UiKitThemeService>;

  @injectLazy(() =>
    import('@/services/uikit-editor/UiKitProjectWriter').then(m => m.UiKitProjectWriter)
  )
  private readonly uiKitWriter!: LazyService<UiKitProjectWriter>;

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
   * Prompt → open project at the **idea stage**: no planner, no expander, no recipe, no LLM call at
   * all on the way in (design §3.1). Everything here is deterministic — a name derived from the
   * prompt, an empty canvas, the attachments saved as project files, and three seeded documents —
   * which is what makes this path faster than the prototype path it replaces rather than slower.
   *
   * The status is deliberately left alone: `planning`/`expanding` are the phases the prompt-hero
   * narrates with a spinner, and there is nothing to narrate here. The one model call on this path
   * is the agent's own first turn, which starts AFTER the project is open.
   */
  async startIdea(request: PrototypeBootstrapRequest): Promise<PrototypeIdeaResult> {
    if (this.running) {
      throw new Error('A prototype is already being created.');
    }
    this.running = true;
    // Times prompt → design document on screen. This span has no LLM call in it and was measured at
    // 10–16 s, so it is instrumented rather than guessed at — see `idea-timeline.ts`.
    ideaTimeline.begin();
    const notes: string[] = [];
    let references: PrototypeBriefReference[] = [];
    try {
      const attachments = request.attachments ?? [];
      const title = deriveTitle(request.prompt);

      // OPFS is the anonymous user's storage and browsers may evict it under pressure.
      try {
        await ideaTimeline.phase('requestPersistence', () =>
          this.browserStore.requestPersistence()
        );
      } catch {
        // Best effort — a project that cannot be made persistent is still a working project.
      }

      await this.projectService.createNewProjectWithOptions(
        {
          name: title,
          manifest: this.buildIdeaManifest(title, request.recipeId),
          templateId: IDEA_TEMPLATE_ID,
          backend: 'browser',
        },
        {
          beforeActivate: async () => {
            // Attachments become project files FIRST: a reference that lives only in the
            // conversation is gone the moment the context is compacted (design §5.7).
            references = await ideaTimeline.phase('persistAttachments', () =>
              this.persistAttachments(attachments, notes)
            );
            await ideaTimeline.phase('writeIdeaDocs', () =>
              this.writeIdeaDocs(title, request.prompt, request, references, notes)
            );
          },
        }
      );

      // The new project is open: from here a design document on screen is THIS project's, so the
      // stopwatch may be stopped by it (see armCompletion for the trap this closes).
      ideaTimeline.armCompletion();

      // A project born in Flow reopens in Flow after a reload.
      this.workspaceMode.remember('flow');

      if (request.startAgentTurn !== false) {
        // Deliberately not awaited: the caller's job is done once the editor is open, and the
        // first turn is a full agent run.
        void this.startIdeaTurn(request.prompt, request.recipeId, references).catch(error => {
          console.error('[PrototypeBootstrapService] First idea turn failed to start:', error);
        });
      }

      return { title, templateId: IDEA_TEMPLATE_ID, references, notes };
    } finally {
      this.running = false;
    }
  }

  /**
   * Idea stage → prototype, **in the project that is already open** (design §3.1, §2.4).
   *
   * Both halves of the retired welcome-to-prototype path are here, with different inputs: the
   * planner is fed the idea documents instead of the bare prompt (that is the whole reason the
   * stage exists — the recipe is the most expensive thing to get wrong, so it is chosen last, when
   * the input is richest), and the expander lays the recipe over this project rather than creating
   * a new one.
   *
   * Structurally one-way. Reusing the project id is not a detail: a new project would change it and
   * orphan the chat history, the recents entry and the remembered workspace mode, and leave a stub
   * project behind in the list.
   *
   * The status stream is the same one the prompt-hero and the shell already narrate
   * (`planning` → `expanding` → `ready`/`error`), so the CTA needs no second channel.
   */
  async startPrototype(options?: {
    readonly startAgentTurn?: boolean;
  }): Promise<PrototypeBootstrapResult> {
    if (this.running) {
      throw new Error('A prototype is already being created.');
    }
    if (appState.project.status !== 'ready') {
      throw new Error('Open the idea project first: there is nothing to turn into a prototype.');
    }
    if (!this.flowStage.isIdeaStage()) {
      throw new Error('This project is already a prototype.');
    }

    this.running = true;
    const notes: string[] = [];
    try {
      // Narrated before the first read: the CTA is a click the user is watching, and the reads
      // below are I/O.
      this.setStatus({
        phase: 'planning',
        message: 'Reading your design document…',
        brief: null,
        error: null,
      });
      const idea = await this.readIdeaContext();

      // The prompt is passed as the request's own `prompt` and NOT as `recipeId`: a pinned recipe
      // skips the planner's genre choice entirely, and `recipeHint` is a hint the document is
      // allowed to have outgrown (design §2.1). It travels in the prompt as a hint instead.
      const { brief, issues, userNotices } = await this.plan(
        { prompt: idea.prompt },
        [],
        idea.palette,
        idea
      );
      notes.push(...issues);

      this.setStatus({
        phase: 'expanding',
        message: 'Building your project…',
        brief,
        error: null,
      });
      const { templateId, expandNotes } = await this.expandIntoCurrentProject(brief, idea.prompt);
      notes.push(...expandNotes);

      this.setStatus({
        phase: 'ready',
        message: 'Your prototype is live — the agent is taking the first step.',
        brief,
        error: null,
      });

      if (options?.startAgentTurn !== false) {
        // Deliberately not awaited: the caller's job ends when the project is playable, and the
        // first increment is a full agent run.
        void this.startFirstTurn(brief, idea.prompt, userNotices).catch(error => {
          console.error('[PrototypeBootstrapService] First agent turn failed to start:', error);
        });
      }

      return { brief, templateId, notes, userNotices };
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
    palette: string[],
    idea?: PlannerIdeaContext
  ): Promise<{ brief: PrototypeBrief; issues: string[]; userNotices: string[] }> {
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
      return { brief: fallback(), issues, userNotices: [] };
    }

    const images = attachments.filter(isImageAttachment);
    const supportsImages =
      this.catalog.getModel(provider.id, modelId)?.capabilities.supportsImages ?? false;
    const visionNotes =
      images.length > 0 && !supportsImages ? await this.describeReferences(images, issues) : [];

    const userText = buildPlannerPrompt(request, attachments, palette, visionNotes, idea);
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
      return { brief: fallback(), issues, userNotices: [] };
    }

    const parsed = extractJsonObject(raw);
    if (!parsed) {
      issues.push('The planner did not return usable JSON; started from the fallback recipe.');
      return { brief: fallback(), issues, userNotices: [] };
    }

    const validated = validateBrief(parsed, request.prompt);
    issues.push(...validated.issues);
    return {
      brief: applyPlannerOverrides(validated.brief, request, palette, attachments),
      issues,
      userNotices: validated.userNotices,
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

  // -- expander --------------------------------------------------------------

  /**
   * The expander: the recipe is laid over the OPEN project (design §3.1).
   *
   * Three steps and then a fourth — copy the template, patch the copied files on disk, write the
   * design docs, and only then reactivate, because the editor is holding the idea-stage version of
   * everything the copy just replaced. That order is what keeps it race-free: nothing re-opens a
   * scene until the scene files on disk are final.
   */
  private async expandIntoCurrentProject(
    brief: PrototypeBrief,
    prompt: string
  ): Promise<{ templateId: string; expandNotes: string[] }> {
    const expandNotes: string[] = [];
    const templateId = this.resolveTemplateId(brief.recipeId, expandNotes);
    const template = this.templates.getTemplate(templateId);
    // The project keeps the name it was created with: it is what the user has been looking at, what
    // the recents entry says, and what `{{PROJECT_NAME}}` in the recipe's own files should become.
    const projectName = appState.project.projectName?.trim() || brief.title;

    const manifest = this.buildPrototypeManifest(brief, templateId, projectName);
    // The stage flips LAST. The copy is the one step here that can fail half-done, and a manifest
    // that already said `prototype` over a half-copied recipe would be unrecoverable: the CTA
    // refuses a project that is not at the idea stage, so the user would be left with a broken
    // project and no way to ask for it again. Written as `idea` first, a failed transition is
    // simply a transition to retry.
    await this.projectService.applyTemplateFiles(
      projectName,
      { ...manifest, metadata: { ...manifest.metadata, [FLOW_STAGE_METADATA_KEY]: 'idea' } },
      templateId,
      { skip: IDEA_PRESERVED_PATHS }
    );

    // The references were saved as project files back at `startIdea` (and by the panel and the
    // agent since), so there is nothing to persist — only to read back, so the brief and the style
    // doc point at them.
    const references = await this.collectProjectReferences(expandNotes);
    await this.applyRecipe(brief, prompt, references, templateId, expandNotes, {
      preserveDecisions: true,
    });

    await this.projectService.saveProjectManifest(manifest);
    try {
      await this.projectService.reactivateCurrentProject({
        ...(template?.entryScenePath ? { entryScenePath: template.entryScenePath } : {}),
      });
    } catch (error) {
      // By this point the recipe is on disk and the manifest says `prototype`: the transition
      // itself succeeded, and the only thing that can still fail here is opening the scene — which
      // the Flow stage retries on its own. Failing the whole call would put an error banner over a
      // project that is fine, so it degrades to a note.
      expandNotes.push(
        `The project was built, but its first scene did not open yet: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return { templateId, expandNotes };
  }

  /**
   * Patch the copied recipe files and write the design docs.
   *
   * Kept separate from {@link expandIntoCurrentProject} because the two halves fail differently:
   * everything here degrades into `notes` (a scene without the node a tunable names, a placeholder
   * that is not in the project), while the copy and the reactivation around it are the steps that
   * are allowed to fail the transition.
   */
  private async applyRecipe(
    brief: PrototypeBrief,
    prompt: string,
    references: readonly PrototypeBriefReference[],
    templateId: string,
    notes: string[],
    options?: { readonly preserveDecisions?: boolean }
  ): Promise<void> {
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

    // The theme pack rides the same rails as the brief's own tunables: declared keys are clamped
    // and patched, undeclared ones become a sentence for the agent instead of a blind YAML edit.
    const resolution = resolveTunables(themedTunables(brief), declared);
    await this.applyTunables(resolution, brief, declared, notes);
    await this.tintPlaceholders(placeholders, brief.style.palette, notes);
    await this.skinRecipeUi(brief, notes);
    await this.writeDesignDocs(brief, prompt, references, resolution, notes, options);
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
   * Dress the recipe's UI controls in a generated kit — deterministically, with no agent turn.
   *
   * Same brief in, same files out: the theme comes from the brief ({@link deriveUiKitTheme}), the
   * kit folder is named by a hash of that theme, and the colour role of each control comes from
   * its NAME. The whole thing is the argument in this file's header made concrete — cosmetics
   * chosen by code cost nothing per project, while the same choices made by an agent cost a turn
   * each.
   *
   * Two guards, both deliberate. A project with no 2D UI nodes is skipped in silence (a 3D-only
   * or HUD-less recipe has nothing to wear a kit, and a note about it would be noise), and every
   * failure degrades into a note: a prototype whose buttons are grey is a working prototype,
   * whereas a transition that fails over a cosmetic bake is not.
   */
  private async skinRecipeUi(brief: PrototypeBrief, notes: string[]): Promise<void> {
    try {
      const targets: {
        path: string;
        text: string;
        nodes: { id: string; name: string; type: string }[];
      }[] = [];
      for (const path of await this.listScenes()) {
        const text = await this.storage.readTextFile(path);
        if (!looksLikeScene(text)) continue;
        const nodes = listSceneNodes(text).filter(node =>
          UI_CONTROL_NODE_TYPES.includes(node.type)
        );
        if (nodes.length > 0) targets.push({ path, text, nodes });
      }
      if (targets.length === 0) return;

      const { preset, theme } = deriveUiKitTheme(brief);
      const themeService = await this.uiKitTheme();
      // The writer saves whatever theme the service currently holds, so the service is the one
      // that has to be told first — otherwise `design/ui-theme.json` and the baked PNGs describe
      // two different kits.
      themeService.replaceTheme(theme, preset);

      const writer = await this.uiKitWriter();
      const kit = await writer.writeKit(theme, {
        colorRoles: UI_KIT_BOOTSTRAP_ROLES,
        // Glyph buttons are for dialogs and templates; a recipe's HUD has none, and baking 28
        // pictures nothing references would just slow the transition down.
        iconButtons: false,
      });

      let skinned = 0;
      for (const target of targets) {
        const patches: ScenePatch[] = [];
        for (const node of target.nodes) {
          const role = uiKitRoleForNodeName(node.name);
          for (const write of planSkinPatches(node.type, kit.manifest, role)) {
            patches.push({ node: node.id, property: write.propertyPath, value: write.value });
          }
        }
        if (patches.length === 0) continue;

        const result = applyScenePatches(target.text, patches);
        if (result.applied.length === 0) continue;
        await this.storage.writeTextFile(target.path, result.text);
        skinned += target.nodes.length;
      }

      if (skinned > 0) {
        notes.push(
          `Skinned ${skinned} UI node${skinned === 1 ? '' : 's'} with the generated "${preset}" UI kit (sprites/ui/${kit.kitId}).`
        );
      }
    } catch (error) {
      notes.push(
        `The UI kit was not generated: ${error instanceof Error ? error.message : String(error)}`
      );
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
    notes: string[],
    options?: { readonly preserveDecisions?: boolean }
  ): Promise<void> {
    const withReferences: PrototypeBrief = { ...brief, references };
    await this.writeFile(
      FLOW_BRIEF_PATH,
      renderBriefMarkdown(withReferences, prompt, resolution, notes),
      notes
    );
    await this.writeFile(FLOW_PROGRESS_PATH, renderProgressMarkdown(brief), notes);
    // The scaffold is only written where there is nothing to scaffold over. Coming from the idea
    // stage the file holds every fork the user already settled, and re-seeding it would throw away
    // the one document the transition exists to carry forward.
    if (!options?.preserveDecisions) {
      await this.writeFile(FLOW_DECISIONS_PATH, renderDecisionsMarkdown(), notes);
    }
    if (
      brief.style.artStyle ||
      brief.style.mood ||
      brief.style.theme ||
      brief.style.palette.length > 0
    ) {
      await this.writeFile(FLOW_STYLE_PATH, renderStyleMarkdown(brief, references), notes);
    }
  }

  // -- idea stage ------------------------------------------------------------

  /**
   * The manifest of a project that has no recipe yet: the `idea-blank` template's own defaults plus
   * the two metadata fields the stage runs on. `recipeHint` is written as a HINT on purpose — the
   * welcome card said "tapper", and an idea is allowed to move to another genre before the planner
   * gets to choose (design §2.1).
   */
  private buildIdeaManifest(title: string, recipeId: string | undefined): ProjectManifest {
    const template = this.templates.getTemplate(IDEA_TEMPLATE_ID);
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
      metadata: {
        ...(manifest.metadata ?? {}),
        projectName: title,
        templateId: IDEA_TEMPLATE_ID,
        [FLOW_STAGE_METADATA_KEY]: 'idea',
        ...(recipeId ? { [FLOW_RECIPE_HINT_METADATA_KEY]: recipeId } : {}),
      },
    };
  }

  /**
   * The three files the idea stage starts from: the design document (the source of truth for the
   * idea), the decisions log, and the references index. Written through the same forgiving helper
   * as the prototype docs — a document that could not be written is a note, never a failed project.
   */
  private async writeIdeaDocs(
    title: string,
    prompt: string,
    request: PrototypeBootstrapRequest,
    references: readonly PrototypeBriefReference[],
    notes: string[]
  ): Promise<void> {
    await this.writeFile(
      FLOW_GDD_PATH,
      renderIdeaGddMarkdown(title, prompt, request.recipeId, references),
      notes
    );
    await this.writeFile(FLOW_DECISIONS_PATH, renderDecisionsMarkdown(), notes);
    // `writeTextFile` does NOT create missing parents, and a first prompt with no attachments never
    // creates `references/` on its way through `persistAttachments` — so the index write failed
    // silently into `notes` (observed live) until this directory was ensured first.
    try {
      await this.storage.createDirectory('references');
    } catch {
      // Already there, or unwritable — the index write below reports the real problem either way.
    }
    await this.writeFile(FLOW_REFERENCES_INDEX_PATH, renderReferencesIndex(references), notes);
  }

  /**
   * The agent's first idea-stage turn. No `buildProjectMap` and no wait for a scene: the project is
   * an empty canvas nobody opens at this stage, so a map of it would be a list of the files this
   * very method just wrote, and the scene wait would only spend ten seconds finding nothing.
   */
  async startIdeaTurn(
    prompt: string,
    recipeId: string | undefined,
    references: readonly PrototypeBriefReference[]
  ): Promise<void> {
    await this.agentChat.newConversation();
    await this.agentChat.send(renderIdeaFirstTurnMessage(prompt, recipeId, references));
  }

  // -- first turn ------------------------------------------------------------

  /**
   * Hand the agent ONE increment. A fresh conversation per increment is the cheapest large
   * reliability win in the plan (design §5.4): the same task a long polluted thread circled on is
   * solved without hints when it starts from a compact brief.
   */
  async startFirstTurn(
    brief: PrototypeBrief,
    prompt: string,
    userNotices: readonly string[] = []
  ): Promise<void> {
    // The system prompt carries a scene outline, and the Flow shell opens the scene as it starts the
    // stage — a turn sent a beat too early would start the agent on an empty outline and it would
    // spend its first tool calls re-discovering a project that was about to load anyway.
    await this.waitForActiveScene();
    await this.agentChat.newConversation();
    await this.agentChat.send(
      renderFirstTurnMessage(brief, prompt, await buildProjectMap(this.storage), userNotices)
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
    // Visible templates only: a hidden template (`idea-blank`) is stage scaffolding, and expanding
    // a prototype from an empty canvas would hand the agent the empty folder the recipes exist to
    // avoid — including through the substitute branch below, which picks "any 2d template".
    const available = this.templates.getVisibleTemplates();
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
    // The brief wins over the template: the planner sets `desktop` only when the user explicitly
    // asked for a high-end look, and that choice is what unlocks PBR materials for new geometry.
    const targetPlatform =
      brief.targetPlatform ?? template?.targetPlatform ?? manifest.targetPlatform;
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

  /**
   * The manifest the project gets when the recipe lands on it: the recipe template's own shape
   * (viewport, project type, entry scene) with the idea stage's metadata carried over.
   *
   * Carrying `metadata` is not cosmetic. `recipeHint` is what the "Idea" tab and any later planner
   * run read to know where the idea came from, and dropping keys the idea stage wrote would make
   * the transition a quiet data loss. `flowStage` flips to `prototype` — that flip is the whole
   * persisted meaning of the transition (design §3.2), and it is one-way.
   */
  private buildPrototypeManifest(
    brief: PrototypeBrief,
    templateId: string,
    projectName: string
  ): ProjectManifest {
    const base = this.buildManifest(brief, templateId);
    const existing = appState.project.manifest?.metadata ?? {};
    return {
      ...base,
      metadata: {
        ...existing,
        ...base.metadata,
        projectName,
        [FLOW_STAGE_METADATA_KEY]: 'prototype',
      },
    };
  }

  /**
   * The references already on disk, as brief entries: `references/**` plus the read-only
   * `design/source/**`, through the same service the references column is built from.
   *
   * Style CANDIDATES are left out on purpose (design §3.9): a mood board the user did not pick is a
   * question that was already answered, and feeding all four to the planner re-opens it.
   */
  private async collectProjectReferences(notes: string[]): Promise<PrototypeBriefReference[]> {
    let list;
    try {
      list = await this.references.list();
    } catch (error) {
      notes.push(
        `Could not read the references folder: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
    const references: PrototypeBriefReference[] = [];
    for (const item of [...list.references, ...list.sources]) {
      if (item.missing || item.role === 'style-candidate') {
        continue;
      }
      const isImage = item.kind === 'image';
      references.push({
        path: isImage ? `res://${item.path}` : item.path,
        kind: isImage ? 'image' : 'doc',
        ...(isImage && (item.role === 'style' || item.role === 'content' || item.role === 'layout')
          ? { role: item.role }
          : {}),
        ...(item.caption ? { note: item.caption } : {}),
      });
    }
    return references;
  }

  /**
   * Everything the planner gets at the transition, read from the project's own files.
   *
   * The prompt comes out of `design/gdd.md` rather than being kept in memory or in the manifest:
   * the transition can happen days and one reload after the prompt was typed, and the document is
   * the copy that survives that (it is also the copy the user may have edited, which is the right
   * one to plan from).
   */
  private async readIdeaContext(): Promise<
    PlannerIdeaContext & { prompt: string; palette: string[] }
  > {
    const [gdd, style, decisions] = await Promise.all([
      this.readOptional(FLOW_GDD_PATH),
      this.readOptional(FLOW_STYLE_PATH),
      this.readOptional(FLOW_DECISIONS_PATH),
    ]);
    const hint = appState.project.manifest?.metadata?.[FLOW_RECIPE_HINT_METADATA_KEY];
    return {
      prompt: gdd ? extractIdeaPrompt(gdd) : '',
      ...(gdd ? { gddExcerpt: summarizeDocument(gdd) } : {}),
      ...(style ? { style: style.trim() } : {}),
      decisions: decisions ? extractDecisionLines(decisions) : [],
      ...(typeof hint === 'string' && hint.trim() ? { recipeHint: hint.trim() } : {}),
      // Quantized from the reference the user made the style, by the panel, at pick time — so the
      // palette that reaches the recipe is measured rather than a model's memory of a hex code.
      palette: style ? parseStylePalette(style) : [],
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

/**
 * The planner's rules. Exported so the spec can hold the load-bearing ones — that the recipe
 * already plays, so the first increment is the game's own mechanic and not its controls.
 */
export const PLANNER_SYSTEM_PROMPT = [
  'You plan playable game prototypes for the Pix3 editor. You are given a short idea and you return',
  'a compact JSON brief that a deterministic expander turns into a real project.',
  '',
  'Rules:',
  '- Reply with ONE JSON object and nothing else. No prose, no markdown fences.',
  '- Pick `recipeId` from the catalog you are given. Never invent an id.',
  '- Pick a GENRE recipe only when its shipped mechanic survives the first increment. If that',
  `  mechanic would first have to be removed or replaced, pick \`${BLANK_RECIPE_ID}\` (2D) or`,
  `  \`${BLANK_3D_RECIPE_ID}\` (3D) instead: extending beats demolishing, and demolishing loses to`,
  '  starting from a blank. A breakout still takes the bouncer; a snake or a sokoban takes the blank.',
  '- A genre recipe ALREADY ships a playable skeleton: menu, game, win/lose, working controls, a',
  '  score and a HUD. It runs before the first increment starts. So `increments` EXTENDS that',
  '  skeleton — never write "controls", "core loop", "menu" or "score" as a step; those exist.',
  '  The BLANK recipes are the exception: they ship the bookkeeping, the HUD and the win/lose screen',
  '  but NO mechanic and NO controls, so there the first increment IS the core mechanic, controls',
  '  included — and there is no menu to extend.',
  '- `increments` is 3 to 5 steps. The FIRST one is the mechanic that makes this game THIS game and',
  '  nothing else: flippers for a pinball, grid movement plus growth for a snake, brick rows for a',
  '  breakout, a chasing enemy for a survival game. Then stakes, then escalation, then an art pass.',
  '  Every step must be provable by playing the game.',
  '- `wow` is 2 to 4 spectacle beats of the genre — a score multiplier, combo popups, a board tilt,',
  '  a slow-motion last life. These are the moments that make it feel alive, not the mechanics.',
  '- `style.theme` is one of neon, pastel, retro, minimal — the look the idea asks for ("neon',
  '  pinball" is neon, "cozy" is pastel, "8-bit" is retro). Omit it when the idea says nothing.',
  '- `tunables` may only use keys the recipe declares; leave it empty when unsure. Guessing a key',
  '  is worse than omitting it.',
  '- `style.palette` is 3 to 5 `#rrggbb` colours. If a palette is supplied to you, keep it.',
  '- `targetPlatform` is "mobile" unless the user explicitly asked for a desktop / high-end /',
  '  "make it beautiful" look. It is a performance budget, not a taste: "desktop" buys PBR',
  '  materials and heavier effects, which cost every phone that runs the game. Omit it when unsure.',
  '- Keep every string short: `pitch` is one line, entity prompts are one sentence, an increment or',
  '  a wow item is a phrase. Never use an em dash inside one — the tracker reads it as a note.',
].join('\n');

/**
 * What the idea stage adds to the planner's turn (design §3.1): the documents the user and the
 * agent worked out, on top of the prompt they started from.
 *
 * All optional and all budgeted by the caller. The prompt itself is NOT in here — it stays the
 * request's own `prompt`, so it keeps its position as the first thing the planner reads, which is
 * the "explicit prompt beats the document beats the image" priority of parent §5.7 expressed as
 * ordering rather than as a rule the model has to remember.
 */
export interface PlannerIdeaContext {
  /** Budgeted excerpt of `design/gdd.md` — never the whole document. */
  readonly gddExcerpt?: string;
  /** `design/style.md` verbatim (it is short by construction). */
  readonly style?: string;
  /** One line per settled fork, from `design/decisions.md`. */
  readonly decisions?: readonly string[];
  /** The recipe card the user clicked on the launcher. A hint, never an instruction. */
  readonly recipeHint?: string;
}

/** The planner's user turn: the idea, the catalog, references, and the exact JSON shape wanted. */
export const buildPlannerPrompt = (
  request: PrototypeBootstrapRequest,
  attachments: readonly ComposerAttachment[],
  palette: readonly string[],
  visionNotes: readonly string[],
  idea?: PlannerIdeaContext
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
    if (idea?.recipeHint) {
      lines.push(
        `The user clicked the "${idea.recipeHint}" card before writing any of this down. It is a` +
          ' HINT, not an instruction: pick the recipe the design document below actually describes,',
        'even when that is a different genre.',
        ''
      );
    }
  }

  if (idea?.gddExcerpt) {
    lines.push(
      'DESIGN DOCUMENT `design/gdd.md` (excerpt — the full file stays in the project and the agent',
      'reads the section it needs):',
      idea.gddExcerpt,
      ''
    );
  }

  if (idea?.style) {
    lines.push('STYLE `design/style.md` (already agreed with the user — keep it):', idea.style, '');
  }

  if (idea?.decisions && idea.decisions.length > 0) {
    lines.push('DECISIONS ALREADY SETTLED (do not re-open these):');
    for (const decision of idea.decisions) {
      lines.push(`- ${decision}`);
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
        recipeId: FALLBACK_RECIPE_ID,
        targetPlatform: 'mobile',
        style: {
          palette: ['#101820', '#f5ae39'],
          artStyle: 'flat vector',
          mood: 'playful',
          theme: 'minimal',
        },
        entities: [
          { role: 'player', name: 'Hero', assetSpec: { prompt: 'one sentence', sizeHint: 128 } },
        ],
        tunables: {},
        winLose: { win: 'how the player wins', lose: 'how the player loses' },
        increments: [
          'the trail: the hero leaves segments behind and grows on every pickup',
          'running into your own trail costs a life',
          'the field speeds up as the trail gets longer',
          'art and feel pass',
        ],
        wow: ['combo popups on a fast pickup chain', 'a burst and a shake when a life is lost'],
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
 * The user's original words, recovered from `design/gdd.md`.
 *
 * Three sources in falling order of fidelity: the `## What the user asked for` section the seed
 * writes the prompt into verbatim, the `**Pitch:**` line the agent fills in, then the `# H1`. The
 * order is the priority rule of parent §5.7 applied to one file — what the user *typed* outranks
 * what the agent *wrote about* what they typed — and it matters because this string is the first
 * thing the planner reads at the transition.
 */
export const extractIdeaPrompt = (markdown: string): string => {
  // Deliberately NOT the `m` flag: with it the `$` in the lookahead matches the end of the first
  // line, the lazy group captures nothing, and every document reads as "the section is empty".
  const section =
    /(?:^|\n)##[ \t]+What the user asked for[ \t]*\r?\n([\s\S]*?)(?=\r?\n#{1,6}[ \t]|$)/i
      .exec(markdown)?.[1]
      ?.trim();
  if (section && !/^\((?:no prompt text|nothing typed)/i.test(section)) {
    return section;
  }
  const pitch = /^\*\*Pitch:\*\*[ \t]*(.+)$/m.exec(markdown)?.[1]?.trim();
  // `_to be filled_` is the seeded placeholder; treating it as the idea would plan a game out of
  // the scaffold's own words.
  if (pitch && !/^_?to be filled_?$/i.test(pitch)) {
    return pitch;
  }
  return /^#[ \t]+(.+)$/m.exec(markdown)?.[1]?.trim() ?? '';
};

/**
 * `design/decisions.md` → one line per settled fork, for the planner prompt.
 *
 * The parsing lives in `decision-log.ts`, next to the writers — the format has four callers and
 * would drift the moment any one of them owned it. What this adds is the planner's VIEW of an
 * entry: question, choice, and the reason when there is one; never the date or the rejected
 * options, which cost tokens in a prompt that is charged for every one of them.
 */
export const extractDecisionLines = (markdown: string, limit = 30): string[] =>
  extractDecisionEntries(markdown)
    .slice(0, limit)
    .map(entry =>
      entry.reason
        ? `${entry.question} → ${entry.choice}. ${entry.reason}.`
        : `${entry.question} → ${entry.choice}`
    );

/**
 * The palette out of `design/style.md`'s `- **Palette:** #… , #…` line.
 *
 * Read back rather than re-measured: the colours were quantized from the reference image the user
 * chose (`extractPalette`), and a model asked to remember them instead returns colours that are
 * nearly right, which is the one kind of wrong a palette must not be.
 */
export const parseStylePalette = (markdown: string): string[] => {
  const line = /^[ \t]*[-*][ \t]*\*\*Palette:\*\*[ \t]*(.+)$/im.exec(markdown)?.[1] ?? '';
  return [...line.matchAll(/#[0-9a-f]{3,8}\b/gi)].map(match => match[0]);
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
): { brief: PrototypeBrief; issues: string[]; userNotices: string[] } => {
  const issues: string[] = [];
  const userNotices: string[] = [];
  const base = fallbackBrief(prompt);

  const title = asText(value.title) ?? base.title;
  const pitch = asText(value.pitch) ?? base.pitch;

  let recipeId = asText(value.recipeId) ?? '';
  if (!recipeId) {
    issues.push('The planner returned no recipeId.');
    recipeId = FALLBACK_RECIPE_ID;
  } else if (!RECIPE_CATALOG.some(recipe => recipe.id === recipeId)) {
    issues.push(`Planner asked for an unknown recipe \`${recipeId}\`.`);
    // An INVENTED id is a signal, not just noise: the planner reached past the catalog because
    // nothing in it fit, so the answer is the recipe with no mechanics rather than the genre
    // fallback. (Silence — no `recipeId` at all — keeps the genre fallback above: there the reply
    // said nothing about the idea, and a game that already plays beats a blank stage.)
    //
    // Dimensionality still comes first, because it is the one substitution the user notices
    // instantly and blames on the agent: asked for a 3D puzzle, handed 2D sprites pretending to be
    // one. An invented id that says "3d" gets the blank 3D stage; if no 3D recipe is installed at
    // all, say so out loud instead of shipping the substitute silently.
    const wants3D = /3d/i.test(recipeId);
    const blank3D = RECIPE_CATALOG.some(recipe => recipe.id === BLANK_3D_RECIPE_ID)
      ? BLANK_3D_RECIPE_ID
      : RECIPE_CATALOG.some(recipe => recipe.id === FALLBACK_3D_RECIPE_ID)
        ? FALLBACK_3D_RECIPE_ID
        : null;
    if (wants3D && blank3D) {
      recipeId = blank3D;
    } else {
      if (wants3D) {
        userNotices.push(
          `The idea reads as 3D (the planner reached for \`${recipeId}\`), but no 3D recipe is installed, so the project started from a 2D one. Say this to the user in your FIRST message, before the plan, and offer the fork: build the 3D scene by hand (GeometryMesh + lights + Camera3D — slower, but genuinely 3D) or keep the 2D take. Never present the 2D substitute as if it were what they asked for.`
        );
      }
      recipeId = RECIPE_CATALOG.some(recipe => recipe.id === BLANK_RECIPE_ID)
        ? BLANK_RECIPE_ID
        : FALLBACK_RECIPE_ID;
    }
  }

  const requestedPlatform = asText(value.targetPlatform)?.toLowerCase();
  const targetPlatform =
    requestedPlatform === 'desktop' || requestedPlatform === 'mobile'
      ? (requestedPlatform as 'mobile' | 'desktop')
      : undefined;
  if (requestedPlatform && !targetPlatform) {
    issues.push(`Planner asked for an unknown targetPlatform \`${requestedPlatform}\`.`);
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

  // An unknown theme is dropped rather than mapped onto a guess: with the field absent the recipe
  // genre's own default applies, which is a better look than any theme picked out of a bad word.
  const requestedTheme = styleValue.theme;
  const theme = asTheme(requestedTheme);
  if (!theme && requestedTheme !== undefined && requestedTheme !== null) {
    issues.push(
      `Planner asked for an unknown theme \`${asText(requestedTheme) ?? typeof requestedTheme}\`; used the recipe's default look.`
    );
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
  // No default for `wow`: spectacle only reads as spectacle when it belongs to the genre, and a
  // generic "add particles" item on every project is noise in the checklist the user watches.
  const wow = Array.isArray(value.wow)
    ? value.wow.map(asText).filter((entry): entry is string => Boolean(entry))
    : [];

  return {
    brief: {
      title,
      pitch,
      recipeId,
      style: {
        palette,
        artStyle: asText(styleValue.artStyle) ?? '',
        mood: asText(styleValue.mood) ?? '',
        ...(theme ? { theme } : {}),
      },
      entities,
      tunables,
      winLose: {
        win: asText(winLoseValue.win) ?? base.winLose.win,
        lose: asText(winLoseValue.lose) ?? base.winLose.lose,
      },
      increments: increments.length > 0 ? increments : base.increments,
      ...(wow.length > 0 ? { wow } : {}),
      ...(targetPlatform ? { targetPlatform } : {}),
      ...(asText(value.ctaUrl) ? { ctaUrl: asText(value.ctaUrl) as string } : {}),
    },
    issues,
    userNotices,
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
  // The recipe skeleton already plays, so even the blind fallback checklist starts at what makes
  // THIS game itself rather than at controls the project shipped with (contract §C2).
  increments: [
    'The one mechanic this idea needs that the recipe does not have yet',
    'Opposition or a real stake',
    'Escalation so a run builds',
    'Art and feel pass',
  ],
});

/** A short project name out of the prompt's first words. */
export const deriveTitle = (prompt: string): string => {
  const cleaned = prompt.trim().replace(/["'`]/g, '');
  // Cut at the first clause boundary when there is one: "ant colony strategy: build tunnels,
  // gather food" names itself in its first clause, and taking a flat five words instead produced
  // titles that ended mid-phrase on a comma ("Ant colony strategy: build tunnels,").
  const clause = cleaned.split(/\s*[:;.!?—–]\s*|\s*,\s*/)[0] ?? '';
  const source = clause.split(/\s+/).filter(Boolean).length >= 2 ? clause : cleaned;
  const words = source.split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  // Trailing punctuation survives the word split ("coins," when the cut lands on a comma).
  const title = words
    .slice(0, 48)
    .replace(/[\s,;:.!?—–-]+$/, '')
    .trim();
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

/** A theme name the packs actually know, case-folded — models capitalize what they please. */
const asTheme = (value: unknown): PrototypeTheme | undefined => {
  const text = asText(value)?.toLowerCase();
  return PROTOTYPE_THEMES.find(theme => theme === text);
};

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
    `- Theme: ${effectiveTheme(brief)}${brief.style.theme ? '' : ' (recipe default)'}`,
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
      'These were asked for — by the planner or by the style theme — but the recipe declares no such',
      'tuning point, so nothing was guessed at. Decide whether each is worth building, and say so.',
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
  // The spectacle beats are the same kind of item, just later ones: they are unchecked steps in the
  // one checklist the tracker renders, so the user can see the fun is planned rather than forgotten.
  if (brief.wow && brief.wow.length > 0) {
    lines.push(
      '',
      'Spectacle beats for the later increments. Fold one in whenever it is a one-liner next to the',
      'mechanic you are already building — `scene.juice.burst/floatText`, `scene.audio.sfx`, a glow.',
      ''
    );
    for (const beat of brief.wow) {
      lines.push(`- [ ] ${beat}`);
    }
  }
  lines.push('');
  return lines.join('\n');
};

/**
 * `design/gdd.md` — the idea-stage design document (design §3.1 step 2).
 *
 * A fixed skeleton of empty sections rather than a generated draft: the sections are what tells the
 * agent (and the user) which questions the idea still owes an answer to, and filling them is the
 * agent's own first turn — generating a draft here would cost a second model call to say what that
 * turn is about to say anyway. The `# Title` and `**Pitch:**` lines mirror `brief.md`'s format so
 * `FlowPlanService` reads the header out of either file.
 */
export const renderIdeaGddMarkdown = (
  title: string,
  prompt: string,
  recipeId: string | undefined,
  references: readonly PrototypeBriefReference[] = []
): string => {
  const lines: string[] = [
    `# ${title}`,
    '',
    '**Pitch:** _to be filled_',
    '',
    '## What the user asked for',
    '',
    prompt.trim() || '(no prompt text — see the references)',
    '',
    '## Concept',
    '',
  ];
  if (recipeId) {
    // A hint, not a decision: the genre is chosen by the planner on the way to the prototype, and
    // the idea is allowed to have moved by then.
    lines.push(`Genre hint from the launcher: \`${recipeId}\`.`, '');
  }
  lines.push(
    '## Core loop & mechanics',
    '',
    '## Controls',
    '',
    '## Screens & UI',
    '',
    '## Art & audio',
    '',
    '## Progression & difficulty',
    '',
    '## Open questions',
    ''
  );
  if (references.length > 0) {
    lines.push('## References', '');
    for (const reference of references) {
      const role = reference.role ? ` — ${reference.role}` : '';
      lines.push(`- \`${reference.path}\` (${reference.kind}${role})`);
    }
    lines.push('');
  }
  return lines.join('\n');
};

/**
 * `references/index.json` — role and origin per saved reference (design §3.6).
 *
 * Keyed by FILE NAME rather than project path: the index sits in the folder it describes, and the
 * references panel builds its list from `listDirectory('references')`, whose entries are names.
 * Missing entries degrade to "name + role `style`", so this file is a convenience, not a contract.
 */
export const renderReferencesIndex = (references: readonly PrototypeBriefReference[]): string => {
  const entries: Record<string, { readonly role: string; readonly origin: 'user' }> = {};
  for (const reference of references) {
    // Only images live in `references/`; documents went to `design/source/` and are not part of
    // this index (see `attachmentProjectPath`).
    if (reference.kind !== 'image') {
      continue;
    }
    const fileName = reference.path.split('/').pop();
    if (!fileName) {
      continue;
    }
    entries[fileName] = {
      // The role is the chip the user set (or `guessAttachmentRole`'s default) — nothing here is
      // classified by a model, that is deferred to the transition (design §3.1).
      role: reference.role ?? 'style',
      origin: 'user',
    };
  }
  return `${JSON.stringify(entries, null, 2)}\n`;
};

/**
 * The agent's opening message at the idea stage: the prompt, the references, and one job — work
 * through the `idea-stage` skill, keep `design/gdd.md` current, and end the turn with a question.
 *
 * The instruction to ask is load-bearing rather than polite: a turn that fills every section by
 * guessing produces a document nobody agreed to, which is the exact failure this stage exists to
 * prevent (design §1.1).
 */
export const renderIdeaFirstTurnMessage = (
  prompt: string,
  recipeId: string | undefined,
  references: readonly PrototypeBriefReference[] = []
): string => {
  const lines: string[] = [
    'New idea — we are at the **idea stage**: there is no game yet, and there will not be one this',
    'turn. What exists is a design document to work out together.',
    '',
    `What the user asked for: "${prompt.trim() || '(nothing typed — read the references)'}"`,
  ];
  if (recipeId) {
    lines.push('', `They picked the \`${recipeId}\` card on the launcher — treat it as a hint.`);
  }
  if (references.length > 0) {
    lines.push('', 'They attached (already saved as project files):');
    for (const reference of references) {
      const role = reference.role ? `, role \`${reference.role}\`` : '';
      lines.push(`- \`${reference.path}\` (${reference.kind}${role})`);
    }
  }
  lines.push(
    '',
    'Read the `idea-stage` skill first (`read_skill { id: "idea-stage" }`) and work by it.',
    '',
    `The source of truth is \`${FLOW_GDD_PATH}\` — it is already seeded with the section skeleton and`,
    'the prompt. Fill in what the prompt and the references actually say, in the same turn, editing',
    'with `str_replace`. Everything you and the user agree on lives in that file; this conversation',
    'gets compacted and the file does not.',
    '',
    'Do NOT guess the parts the user has not decided. End this turn with **one or two** questions',
    'through `ask_user` — the forks where a wrong guess would mean redoing the game later.',
    '',
    'There is no scene, no script and no play mode at this stage. Nothing to compile, nothing to run.'
  );
  return lines.join('\n');
};

/**
 * `design/decisions.md` — the log of settled forks, one line each.
 *
 * The scaffold no longer shows a shape to copy: entries are written by the `record_decision` tool
 * and by the code that files every `ask_user` answer, so a hand-written example would only invite a
 * second format into a file four callers parse. The reader still accepts the older `## question` +
 * `- **Chosen:**` block, for projects seeded before the tool existed.
 */
export const renderDecisionsMarkdown = (): string =>
  [
    '# Decisions',
    '',
    'Every fork the user settled, so nothing is asked twice. One line per decision, appended by',
    '`record_decision` — and automatically for every answer to an `ask_user` question.',
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
    `- **Theme:** ${effectiveTheme(brief)}${brief.style.theme ? '' : ' (default for this recipe)'} — already applied to the scene; keep new art in this look.`,
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
  projectMap = '',
  userNotices: readonly string[] = []
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
    'judge the outcome with `game_run` (an `until` that says what success IS), and read errors.',
    'If a fork would change the structure of the scene or the scripts, ask with',
    '`ask_user` instead of guessing — that is a legitimate end of turn.',
    '',
    'Then update `design/progress.md` and reply with one short summary plus 2–3 concrete options',
    'for what to do next.'
  );
  if (userNotices.length > 0) {
    lines.push('', 'TELL THE USER FIRST:', ...userNotices.map(notice => `- ${notice}`));
  }
  if (projectMap) {
    lines.push('', '---', '', projectMap);
  }
  return lines.join('\n');
};
