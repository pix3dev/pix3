import { describe, expect, it } from 'vitest';

import {
  AGENT_DEFAULT_MODEL_ID,
  buildSvgRetryPrompt,
  buildSvgSystemPrompt,
  buildSvgUserPrompt,
  formatSvgModelId,
  isSvgEditRequest,
  parseSvgModelId,
  type SvgSpriteRequest,
} from './SvgSpriteGenerator';

/**
 * The generator's decision-making is in its prompts and its model-id encoding; the rest is one
 * `chat()` call plus rasterization, neither of which happy-dom can run. Those are exercised in the
 * running editor — what is asserted here is what makes a reply parseable and a lane resolvable.
 */
describe('svg-llm model ids', () => {
  it('round-trips a provider/model pair', () => {
    const composite = formatSvgModelId('anthropic-bridge', 'claude-sonnet-4-5');
    expect(composite).toBe('anthropic-bridge/claude-sonnet-4-5');
    expect(parseSvgModelId(composite)).toEqual({
      providerId: 'anthropic-bridge',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('splits on the FIRST slash so gateway model ids keep their own', () => {
    expect(parseSvgModelId('zen/anthropic/claude-sonnet-4.5')).toEqual({
      providerId: 'zen',
      modelId: 'anthropic/claude-sonnet-4.5',
    });
  });

  it('treats the agent-default sentinel and malformed ids as "not a pinned lane"', () => {
    expect(parseSvgModelId(AGENT_DEFAULT_MODEL_ID)).toBeNull();
    expect(parseSvgModelId('')).toBeNull();
    expect(parseSvgModelId('/leading')).toBeNull();
    expect(parseSvgModelId('trailing/')).toBeNull();
  });

  it('keeps the sentinel free of a slash so it can never collide with a composite', () => {
    expect(AGENT_DEFAULT_MODEL_ID).not.toContain('/');
  });
});

describe('buildSvgSystemPrompt', () => {
  it('pins the output contract the extractor depends on', () => {
    const system = buildSvgSystemPrompt();
    expect(system).toContain('```svg');
    expect(system).toContain('viewBox');
    expect(system).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('forbids exactly what the sanitizer would strip, so a good reply survives intact', () => {
    const system = buildSvgSystemPrompt();
    for (const banned of ['<script>', '<foreignObject>', 'on*', 'href', 'url()']) {
      expect(system).toContain(banned);
    }
  });

  it('warns that webfonts do not load in SVG-as-image mode', () => {
    expect(buildSvgSystemPrompt()).toContain('generic families');
  });
});

describe('buildSvgUserPrompt', () => {
  const base: SvgSpriteRequest = { prompt: 'a red health potion', width: 64, height: 96 };

  it('states the exact target size and matching viewBox', () => {
    const text = buildSvgUserPrompt(base);
    expect(text).toContain('64×96');
    expect(text).toContain('viewBox="0 0 64 96"');
    expect(text).toContain('a red health potion');
  });

  it('is a draw request when no source is supplied', () => {
    expect(isSvgEditRequest(base)).toBe(false);
    expect(buildSvgUserPrompt(base)).toContain('Draw this sprite');
  });

  it('switches to edit mode when a source is supplied, quoting it in a fence', () => {
    const svgSource = '<svg viewBox="0 0 64 96"><rect id="body" /></svg>';
    const request = { ...base, prompt: 'thicker outline', svgSource };
    expect(isSvgEditRequest(request)).toBe(true);
    const text = buildSvgUserPrompt(request);
    expect(text).toContain('current SVG source');
    expect(text).toContain(svgSource);
    expect(text).toContain('Change requested: thicker outline');
    expect(text).not.toContain('Draw this sprite');
  });

  it('tells the model to preserve everything the edit does not touch', () => {
    const text = buildSvgUserPrompt({ ...base, svgSource: '<svg />' });
    expect(text).toMatch(/keep every element the request does not touch/i);
  });

  it('treats a whitespace-only source as no source at all', () => {
    expect(isSvgEditRequest({ svgSource: '   \n' })).toBe(false);
    expect(buildSvgUserPrompt({ ...base, svgSource: '  ' })).toContain('Draw this sprite');
  });
});

describe('buildSvgRetryPrompt', () => {
  it('quotes the failure back and restates the format', () => {
    const retry = buildSvgRetryPrompt('the reply contained no complete <svg>…</svg> element');
    expect(retry).toContain('no complete <svg>');
    expect(retry).toContain('```svg');
  });
});
