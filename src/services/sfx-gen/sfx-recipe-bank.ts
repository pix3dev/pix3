import { parse, recipeMeta, soundDurationMs } from '@txt2sfx/core';
import type { RecipeSource, RetrievedRecipes } from '@txt2sfx/agent';
import type { Recipe, SoundProfile } from '@txt2sfx/shared';

import checkpointChime from './recipes/checkpoint-chime.soundline?raw';
import coinDrop from './recipes/coin-drop.soundline?raw';
import dashWhoosh from './recipes/dash-whoosh.soundline?raw';
import engineIdle from './recipes/engine-idle.soundline?raw';
import explosionSmall from './recipes/explosion-small.soundline?raw';
import gunPistol from './recipes/gun-pistol.soundline?raw';
import impactWoodThud from './recipes/impact-wood-thud.soundline?raw';
import jump8bit from './recipes/jump-8bit.soundline?raw';
import jumpSoft from './recipes/jump-soft.soundline?raw';
import laserPistol from './recipes/laser-pistol.soundline?raw';
import landThump from './recipes/land-thump.soundline?raw';
import levelupFanfare from './recipes/levelup-fanfare.soundline?raw';
import magicSparkle from './recipes/magic-sparkle.soundline?raw';
import meleeSlashHit from './recipes/melee-slash-hit.soundline?raw';
import pickupGem from './recipes/pickup-gem.soundline?raw';
import retroCoin from './recipes/retro-coin.soundline?raw';
import retroSelect from './recipes/retro-select.soundline?raw';
import uiConfirm from './recipes/ui-confirm.soundline?raw';
import uiError from './recipes/ui-error.soundline?raw';
import uiHover from './recipes/ui-hover.soundline?raw';

/**
 * The few-shot bank: twenty soundline recipes bundled into the editor.
 *
 * ## Why a bundled subset rather than the txt2sfx bank server
 *
 * Retrieval quality decides output quality — a prompt carrying three examples of the *wrong kind of
 * sound* still looks like a healthy run and produces a stranger — so the examples have to be there,
 * and a browser tab cannot depend on a bank server being up. These are copied from txt2sfx's own
 * `presets/` and chosen against what a game prototype actually reaches for: interface blips, pickups
 * and rewards, jumps and movement, weapons, impacts, one spell and one engine loop. The HTTP/FTS5
 * bank stays a txt2sfx-server concern.
 *
 * ## Why the metadata is derived, not duplicated
 *
 * Each `.soundline` file carries its own `# prompt:` and `# tags:` markers, and its header carries the
 * name, category, duration and loop flag. So the {@link Recipe} objects are parsed out of the source
 * at first use instead of being re-typed beside it — the alternative is a table that goes quietly
 * stale the first time a recipe is edited.
 *
 * ## Why `profile` is unmeasured
 *
 * `Recipe.profile` is a measured acoustic fingerprint, and measuring one means rendering the sound.
 * Nothing on the few-shot path reads it: `staticBank` slices, `selectFewShot` re-validates the
 * soundline text, and the contract document prints only `name`, `prompt` and `soundline`. Rendering
 * twenty sounds at editor startup to fill a field nobody reads would be a real cost for no
 * information, so the field is explicitly {@link UNMEASURED_PROFILE} — a value that says "not
 * measured" rather than one that pretends to be a measurement. If a future caller starts reading
 * profiles from this bank, it must measure them (the analyzer's `extractProfile`) rather than trust
 * these zeros.
 */

/** Bundled recipe sources, in the order they are offered as a fallback slate. */
const RECIPE_SOURCES: readonly string[] = [
  // Interface — the sounds a prototype needs first and hears most.
  uiConfirm,
  uiHover,
  uiError,
  retroSelect,
  // Pickups and rewards.
  coinDrop,
  retroCoin,
  pickupGem,
  levelupFanfare,
  checkpointChime,
  magicSparkle,
  // Movement.
  jump8bit,
  jumpSoft,
  landThump,
  dashWhoosh,
  // Weapons and impacts.
  laserPistol,
  gunPistol,
  explosionSmall,
  impactWoodThud,
  meleeSlashHit,
  // One loop, so the `cycle` category is represented at all.
  engineIdle,
];

/**
 * A `SoundProfile`-shaped "no measurement taken". Zero-length arrays rather than plausible-looking
 * numbers: a consumer that reads this and finds nothing to work with is told the truth, where a
 * fabricated 64-point envelope would be indistinguishable from a real one.
 */
export const UNMEASURED_PROFILE: SoundProfile = {
  durationMs: 0,
  attackMs: 0,
  rmsEnvelope: [],
  centroidHz: [],
  flatness: 0,
  noiseRatio: 0,
  peakHz: 0,
  loudnessLufsApprox: 0,
};

let cached: readonly Recipe[] | null = null;

/**
 * The bundled recipes as {@link Recipe} objects, parsed once and memoised.
 *
 * A source that fails to parse is skipped rather than thrown: these files are copied in, and one bad
 * copy should cost the bank one example, not the whole SFX feature. (The bundled set is covered by a
 * spec that fails if any of them stops parsing, so this branch is a safety net, not a policy.)
 */
export function sfxRecipes(): readonly Recipe[] {
  if (cached) {
    return cached;
  }
  const recipes: Recipe[] = [];
  RECIPE_SOURCES.forEach((source, index) => {
    try {
      const ast = parse(source);
      const meta = recipeMeta(ast);
      recipes.push({
        id: index + 1,
        name: ast.name,
        prompt: meta.prompt ?? ast.name,
        soundline: source.endsWith('\n') ? source : `${source}\n`,
        profile: UNMEASURED_PROFILE,
        category: ast.category,
        tags: meta.tags,
        durationMs: Math.round(soundDurationMs(ast)),
        // Ordering within the bank is editorial, not a popularity signal; a flat rating keeps
        // retrieval from claiming otherwise.
        rating: 0,
        createdAt: new Date(0).toISOString(),
      });
    } catch {
      // A recipe that does not parse teaches nothing; leave it out.
    }
  });
  cached = recipes;
  return cached;
}

/** Words worth matching on: lowercase, de-punctuated, and long enough to mean something. */
export const keywordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3);

/**
 * How well one recipe answers a request: overlap between the request's words and everything the
 * recipe says about itself. Tags score highest because they were written to be matched on, the prompt
 * next, the name last (it is two words and mostly repeats a tag).
 */
export const scoreRecipe = (recipe: Recipe, words: readonly string[]): number => {
  if (words.length === 0) {
    return 0;
  }
  const tags = new Set(recipe.tags.map(tag => tag.toLowerCase()));
  const promptWords = new Set(keywordsOf(recipe.prompt));
  const nameWords = new Set(keywordsOf(recipe.name));
  let score = 0;
  for (const word of new Set(words)) {
    if (tags.has(word)) {
      score += 3;
    }
    if (promptWords.has(word)) {
      score += 2;
    }
    if (nameWords.has(word)) {
      score += 1;
    }
  }
  return score;
};

/**
 * The bundled bank as a `RecipeSource`.
 *
 * Deliberately more than `staticBank(sfxRecipes())`: `staticBank` returns the first `k` recipes
 * whatever was asked for, which would hand every request the same three interface blips. So this ranks
 * by keyword overlap and reports `fallback: true` when nothing matched — which is precisely what the
 * flag means, and what makes the panel's retrieval line honest instead of reassuring. The ranking is
 * local and free; no second model call is spent rewriting the query (txt2sfx's `searchQuery` exists
 * for the FTS5 case, where a non-English sentence matches literally nothing).
 */
export function sfxRecipeBank(): RecipeSource {
  return {
    retrieve(prompt: string, k: number): Promise<RetrievedRecipes> {
      const recipes = sfxRecipes();
      const words = keywordsOf(prompt);
      const scored = recipes
        .map((recipe, index) => ({ recipe, index, score: scoreRecipe(recipe, words) }))
        .filter(entry => entry.score > 0)
        // Stable: equal scores keep the bank's editorial order rather than shuffling per call.
        .sort((a, b) => b.score - a.score || a.index - b.index);
      if (scored.length === 0) {
        return Promise.resolve({ recipes: recipes.slice(0, k), fallback: true });
      }
      return Promise.resolve({
        recipes: scored.slice(0, k).map(entry => entry.recipe),
        fallback: false,
      });
    },
  };
}
