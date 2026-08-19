import { hasErrors, parse, validate } from '@txt2sfx/core';
import { describe, expect, it } from 'vitest';

import {
  UNMEASURED_PROFILE,
  keywordsOf,
  scoreRecipe,
  sfxRecipeBank,
  sfxRecipes,
} from './sfx-recipe-bank';

/**
 * The bank is a bundled copy of txt2sfx presets, so what is worth testing here is the copy itself (a
 * recipe that stopped parsing or started failing validation would teach the model a defect) and the
 * retrieval this module adds on top of `staticBank`'s "first k, whatever you asked".
 */
describe('bundled SFX recipes', () => {
  const recipes = sfxRecipes();

  it('bundles the whole curated set', () => {
    expect(recipes).toHaveLength(20);
    expect(new Set(recipes.map(recipe => recipe.name)).size).toBe(recipes.length);
  });

  it('derives name, prompt, tags, category and duration from each source', () => {
    for (const recipe of recipes) {
      expect(recipe.name).not.toBe('');
      expect(recipe.prompt).not.toBe('');
      // The presets contract requires at least two tags; retrieval scores highest on them.
      expect(recipe.tags.length).toBeGreaterThanOrEqual(2);
      expect(recipe.durationMs).toBeGreaterThan(0);
      expect(recipe.soundline.endsWith('\n')).toBe(true);
    }
  });

  it('every recipe parses and passes validation, so no example teaches a defect', () => {
    for (const recipe of recipes) {
      const issues = validate(parse(recipe.soundline));
      expect(hasErrors(issues), `${recipe.name} breaks an invariant`).toBe(false);
    }
  });

  it('marks the profile as unmeasured rather than fabricating a fingerprint', () => {
    expect(UNMEASURED_PROFILE.rmsEnvelope).toEqual([]);
    expect(UNMEASURED_PROFILE.centroidHz).toEqual([]);
    for (const recipe of recipes) {
      expect(recipe.profile).toBe(UNMEASURED_PROFILE);
    }
  });

  it('covers the interface, pickup and impact families a prototype reaches for first', () => {
    const categories = new Set(recipes.map(recipe => recipe.category));
    for (const category of ['ui', 'pickup', 'impact', 'laser', 'explosion', 'cycle']) {
      expect(categories, `no ${category} example`).toContain(category);
    }
  });
});

describe('keywordsOf', () => {
  it('lowercases, splits on punctuation and drops noise-length words', () => {
    expect(keywordsOf('A crisp UI click, for a menu-button!')).toEqual([
      'crisp',
      'click',
      'for',
      'menu',
      'button',
    ]);
  });
});

describe('scoreRecipe', () => {
  const gem = sfxRecipes().find(recipe => recipe.name === 'gem pickup');

  it('scores a tag hit above a prompt-only hit', () => {
    expect(gem).toBeDefined();
    const tagHit = scoreRecipe(gem!, ['pickup']);
    const promptOnly = scoreRecipe(gem!, ['glassy']);
    expect(tagHit).toBeGreaterThan(promptOnly);
    expect(promptOnly).toBeGreaterThan(0);
  });

  it('scores nothing for an empty query', () => {
    expect(scoreRecipe(gem!, [])).toBe(0);
  });
});

describe('sfxRecipeBank', () => {
  it('ranks by relevance instead of returning the head of the list', async () => {
    const { recipes, fallback } = await sfxRecipeBank().retrieve('coin pickup jingle', 3);
    expect(fallback).toBe(false);
    expect(recipes).toHaveLength(3);
    // The whole point: an interface blip must not be the first example for a coin.
    expect(recipes[0].tags.join(' ')).toMatch(/coin|pickup/);
  });

  it('admits a fallback slate when nothing matched, rather than looking like a hit', async () => {
    const { recipes, fallback } = await sfxRecipeBank().retrieve('щщщ', 3);
    expect(fallback).toBe(true);
    expect(recipes).toHaveLength(3);
  });

  it('honours k', async () => {
    const { recipes } = await sfxRecipeBank().retrieve('laser', 1);
    expect(recipes).toHaveLength(1);
    expect(recipes[0].name).toContain('laser');
  });
});
