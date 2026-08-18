import { describe, expect, it } from 'vitest';

import {
  clampSpriteSize,
  ensureSvgViewBox,
  extractSvgSource,
  prepareSvgForRaster,
  sanitizeSvgSource,
} from './svg-render';

/**
 * Everything the `svg-llm` provider does between "the model replied" and "a canvas draws it" is
 * pure string work, and it is tested here. Rasterization itself needs a real canvas and `Image`
 * decode, neither of which happy-dom has — it stays behind `rasterizeSvg` and is verified in the
 * running editor.
 */
describe('extractSvgSource', () => {
  it('reads a fenced ```svg block', () => {
    const reply = ['Here you go:', '```svg', '<svg viewBox="0 0 8 8"><rect /></svg>', '```'].join(
      '\n'
    );
    expect(extractSvgSource(reply)).toBe('<svg viewBox="0 0 8 8"><rect /></svg>');
  });

  it('reads an unlabelled fence and an xml-labelled one', () => {
    expect(extractSvgSource('```\n<svg><g /></svg>\n```')).toBe('<svg><g /></svg>');
    expect(extractSvgSource('```xml\n<svg><g /></svg>\n```')).toBe('<svg><g /></svg>');
  });

  it('falls back to a bare <svg> span when the model forgot the fence', () => {
    const reply = 'Sure! <svg width="4" height="4"><circle /></svg> Let me know if…';
    expect(extractSvgSource(reply)).toBe('<svg width="4" height="4"><circle /></svg>');
  });

  it('skips a fence that holds no svg and keeps looking', () => {
    const reply = ['```json', '{"nope": true}', '```', '```svg', '<svg><path /></svg>', '```'].join(
      '\n'
    );
    expect(extractSvgSource(reply)).toBe('<svg><path /></svg>');
  });

  it('returns null for prose, empty input and an unterminated root', () => {
    expect(extractSvgSource('I cannot draw that, sorry.')).toBeNull();
    expect(extractSvgSource('')).toBeNull();
    expect(extractSvgSource('<svg viewBox="0 0 4 4"><rect />')).toBeNull();
  });

  it('does not mistake a word starting with "svg" for the root tag', () => {
    expect(extractSvgSource('<svgfoo></svgfoo>')).toBeNull();
  });
});

describe('sanitizeSvgSource', () => {
  it('removes <script> elements with their content', () => {
    const out = sanitizeSvgSource('<svg><script>fetch("//evil")</script><rect id="keep" /></svg>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('evil');
    expect(out).toContain('id="keep"');
  });

  it('removes <foreignObject> (HTML smuggled into a vector document)', () => {
    const out = sanitizeSvgSource(
      '<svg><foreignObject><body><iframe src="//evil"></iframe></body></foreignObject><g /></svg>'
    );
    expect(out).not.toContain('foreignObject');
    expect(out).not.toContain('iframe');
    expect(out).toContain('<g />');
  });

  it('removes event-handler attributes in every quoting style', () => {
    const out = sanitizeSvgSource(
      `<svg onload="steal()"><rect onclick='go()' onmouseover=go /></svg>`
    );
    expect(out).not.toMatch(/\son[a-z]+=/i);
    expect(out).toContain('<rect');
  });

  it('drops a DOCTYPE with an internal entity subset (billion laughs)', () => {
    const out = sanitizeSvgSource(
      '<!DOCTYPE svg [<!ENTITY lol "lollol">]><svg><text>&lol;</text></svg>'
    );
    expect(out).not.toContain('DOCTYPE');
    expect(out).not.toContain('ENTITY');
    expect(out.startsWith('<svg')).toBe(true);
  });

  it('strips external href / xlink:href but keeps local fragment references', () => {
    const out = sanitizeSvgSource(
      '<svg>' +
        '<image xlink:href="https://evil.example/x.png" />' +
        '<use href="#star" />' +
        '<a href="//evil.example">x</a>' +
        '</svg>'
    );
    expect(out).not.toContain('evil.example');
    expect(out).toContain('href="#star"');
  });

  it('neutralises CSS url() to anything but a local fragment', () => {
    const out = sanitizeSvgSource(
      '<svg><rect fill="url(#grad)" style="mask:url(https://evil.example/m.svg)" /></svg>'
    );
    expect(out).toContain('url(#grad)');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('mask:none');
  });

  it('leaves clean vector art byte-identical apart from trimming', () => {
    const clean = '<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z" fill="#f5ae39" /></svg>';
    expect(sanitizeSvgSource(`\n${clean}\n`)).toBe(clean);
  });
});

describe('ensureSvgViewBox', () => {
  it('injects a viewBox from the author width/height when none is present', () => {
    const out = ensureSvgViewBox('<svg width="32" height="16"><rect /></svg>', {
      width: 96,
      height: 48,
    });
    expect(out).toContain('viewBox="0 0 32 16"');
    expect(out).toContain('width="96"');
    expect(out).toContain('height="48"');
  });

  it('falls back to the requested size when the root declares nothing', () => {
    const out = ensureSvgViewBox('<svg><rect /></svg>', { width: 64, height: 24 });
    expect(out).toContain('viewBox="0 0 64 24"');
  });

  it('keeps an existing viewBox and only rewrites the pixel size', () => {
    const out = ensureSvgViewBox('<svg viewBox="0 0 10 10" width="10" height="10"><g /></svg>', {
      width: 256,
      height: 256,
    });
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain('width="256"');
    expect(out).not.toContain('width="10"');
  });

  it('parses lengths carrying units', () => {
    const out = ensureSvgViewBox('<svg width="20px" height="10pt"></svg>', {
      width: 40,
      height: 20,
    });
    expect(out).toContain('viewBox="0 0 20 10"');
  });

  it('preserves other root attributes and the document body', () => {
    const out = ensureSvgViewBox(
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none"><path d="M0 0" /></svg>',
      { width: 8, height: 8 }
    );
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toContain('fill="none"');
    expect(out).toContain('<path d="M0 0" />');
  });

  it('handles a self-closing empty root', () => {
    const out = ensureSvgViewBox('<svg xmlns="http://www.w3.org/2000/svg" />', {
      width: 12,
      height: 12,
    });
    expect(out).toContain('viewBox="0 0 12 12"');
    expect(out.trimEnd().endsWith('/>')).toBe(true);
  });

  it('returns the input unchanged when there is no <svg> root', () => {
    expect(ensureSvgViewBox('<div />', { width: 8, height: 8 })).toBe('<div />');
  });
});

describe('prepareSvgForRaster', () => {
  it('sanitises and sizes in one pass', () => {
    const out = prepareSvgForRaster(
      '<svg width="10" height="10" onload="x()"><script>x()</script><rect /></svg>',
      { width: 128, height: 64 }
    );
    expect(out).not.toContain('script');
    expect(out).not.toContain('onload');
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain('width="128"');
    expect(out).toContain('height="64"');
  });
});

describe('clampSpriteSize', () => {
  it('rounds and clamps into the supported range', () => {
    expect(clampSpriteSize(96.4, 128)).toBe(96);
    expect(clampSpriteSize(1, 128)).toBe(8);
    expect(clampSpriteSize(99999, 128)).toBe(2048);
  });

  it('falls back for non-numeric or non-positive input', () => {
    expect(clampSpriteSize(Number.NaN, 128)).toBe(128);
    expect(clampSpriteSize(0, 64)).toBe(64);
    expect(clampSpriteSize(-32, 64)).toBe(64);
  });
});
