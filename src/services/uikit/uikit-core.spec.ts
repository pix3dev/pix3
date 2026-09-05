/**
 * Structural tests for the UI Kit Forge core.
 *
 * Deliberately NOT string snapshots (plan §6 Ф1): the id counter and the generator signatures
 * are exactly what this phase changes, so a snapshot would pin the thing under construction
 * and say nothing about whether the art is right. Instead the SVG is parsed and the
 * INVARIANTS are asserted — canvas size, finite geometry, colours equal to the theme's own
 * accessors, "no text in a stripped build, text otherwise", determinism, and the slicing
 * contract.
 */
import { describe, expect, it } from 'vitest';

import { C, DARK, DEFAULT_THEME, normalizeTheme, type ForgeTheme } from './ForgeTheme';
import { runBuild } from './build-context';
import { label } from './svg-primitives';
import { compTabBar } from './skins';
import { buildAll, buildComponent, buildTab, listAll } from './registry';
import { sliceBorder } from './slices';
import {
  BUTTON_STATES,
  MIN_GLOSS_BAND,
  STRETCHED_COMPONENTS,
  buildButtonStates,
  buildSkin,
  capGlossForStretch,
  FLAT_COMPONENTS,
} from './SkinSpec';
import { buildTemplate, walkTemplate, type TemplateNode } from './TemplateSpec';
import { PRESETS, presetTheme } from './presets';
import { missingKeys } from './strings';
import { buildStyleMarkdown, buildTokensJson } from './style-doc';

const THEME = DEFAULT_THEME;

// ---------------------------------------------------------------------------
// A minimal SVG reader: the markup is ours, so element/attribute regexes are enough
// and cost nothing compared with a DOM.
// ---------------------------------------------------------------------------

interface SvgElement {
  tag: string;
  attrs: Record<string, string>;
}

function elements(svg: string): SvgElement[] {
  const out: SvgElement[] = [];
  const elementRe = /<([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = elementRe.exec(svg)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:-]+)="([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[2])) !== null) attrs[a[1]] = a[2];
    out.push({ tag: m[1], attrs });
  }
  return out;
}

/** The text between every `<text>` and `</text>` — what a viewer actually reads. */
function textContents(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(m => m[1]);
}

function root(svg: string): SvgElement {
  const el = elements(svg)[0];
  expect(el.tag).toBe('svg');
  return el;
}

/** Attributes whose value must always be a plain number (percentages allowed on filters). */
const NUMERIC_ATTRS = [
  'x',
  'y',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'x1',
  'y1',
  'x2',
  'y2',
  'stroke-width',
  'opacity',
  'font-size',
  'stop-opacity',
  'offset',
  'font-weight',
  'letter-spacing',
  'stdDeviation',
  'flood-opacity',
];

function badNumbers(svg: string): string[] {
  const bad: string[] = [];
  for (const el of elements(svg)) {
    if (el.tag === 'svg') continue; // viewBox is checked separately
    for (const name of NUMERIC_ATTRS) {
      const raw = el.attrs[name];
      if (raw === undefined) continue;
      const value = raw.endsWith('%') ? raw.slice(0, -1) : raw;
      if (!Number.isFinite(Number(value))) bad.push(`<${el.tag} ${name}="${raw}">`);
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------

describe('registry builds', () => {
  const built = buildAll({ theme: THEME, lang: 'en' });

  it('covers every descriptor', () => {
    expect(built.length).toBe(listAll().length);
    expect(built.length).toBeGreaterThan(60);
  });

  it('declares a canvas matching the reported size', () => {
    for (const comp of built) {
      const attrs = root(comp.svg).attrs;
      expect(Number(attrs.width), comp.name).toBe(comp.w);
      expect(Number(attrs.height), comp.name).toBe(comp.h);
      expect(attrs.viewBox, comp.name).toBe(`0 0 ${comp.w} ${comp.h}`);
    }
  });

  it('emits only finite geometry', () => {
    for (const comp of built) {
      expect(badNumbers(comp.svg), comp.name).toEqual([]);
    }
  });

  it('closes every document', () => {
    for (const comp of built) {
      expect(comp.svg.startsWith('<svg'), comp.name).toBe(true);
      expect(comp.svg.endsWith('</svg>'), comp.name).toBe(true);
    }
  });

  it('builds the showcase screens too (they are noExport, not unbuildable)', () => {
    const screens = buildTab('showcase', { theme: THEME, lang: 'en' });
    expect(screens.map(s => s.name)).toContain('sc_settings');
    for (const s of screens) expect(badNumbers(s.svg), s.name).toEqual([]);
    // ...but they are not in the exportable inventory.
    expect(listAll().some(d => d.name === 'sc_settings')).toBe(false);
  });

  it("paints with the theme's own colours, not with literals of its own", () => {
    const green = buildComponent('btn_green', { theme: THEME, lang: 'en' });
    expect(green).not.toBeNull();
    // The face is C('green') and the outline is DARK() — the two accessors the theme exposes.
    expect(green?.svg).toContain(`fill="${C_of(THEME, 'green')}"`);
    expect(green?.svg).toContain(`stroke="${DARK_of(THEME)}"`);
  });

  it('shifts every painted colour when the theme shifts', () => {
    const shifted: ForgeTheme = { ...THEME, hue: 40, sat: 12, light: 5 };
    const a = buildComponent('btn_green', { theme: THEME, lang: 'en' });
    const b = buildComponent('btn_green', { theme: shifted, lang: 'en' });
    expect(a?.svg).not.toBe(b?.svg);
    expect(b?.svg).toContain(`fill="${C_of(shifted, 'green')}"`);
  });
});

/** `C()` / `DARK()` need a build context; these wrap one for the assertions above. */
function C_of(theme: ForgeTheme, id: string): string {
  return runBuild({ theme }, () => C(id));
}
function DARK_of(theme: ForgeTheme): string {
  return runBuild({ theme }, () => DARK());
}

describe('text stripping and anchors', () => {
  it('keeps captions when not stripping', () => {
    const comp = buildComponent('btn_green', { theme: THEME, lang: 'en' });
    expect(comp?.svg).toContain('<text ');
    expect(comp?.anchors).toBeUndefined();
  });

  it('drops every caption and records an anchor instead', () => {
    const built = buildAll({ theme: THEME, lang: 'en', stripText: true });
    for (const comp of built) expect(comp.svg, comp.name).not.toContain('<text');
    const labelled = built.filter(c => c.anchors && c.anchors.length);
    expect(labelled.length).toBeGreaterThan(10);
    const button = built.find(c => c.name === 'btn_green');
    expect(button?.anchors?.[0]).toMatchObject({ role: 'label', align: 'middle' });
    expect(Number.isFinite(button?.anchors?.[0].x)).toBe(true);
  });

  it('leaves a caption-free component without anchors', () => {
    const built = buildAll({ theme: THEME, lang: 'en', stripText: true });
    const glyph = built.find(c => c.name === 'ic_gear');
    expect(glyph?.anchors).toBeUndefined();
  });

  it('switches language without changing geometry class', () => {
    const en = buildComponent('btn_banner_claim', { theme: THEME, lang: 'en' });
    const ru = buildComponent('btn_banner_claim', { theme: THEME, lang: 'ru' });
    expect(en?.svg).not.toBe(ru?.svg);
    expect(en?.w).toBe(ru?.w);
  });
});

describe('determinism', () => {
  it('gives a byte-identical document for the same theme, name and language', () => {
    for (const name of ['btn_green', 'panel_window', 'counter_coins']) {
      const a = buildComponent(name, { theme: THEME, lang: 'ru' });
      const b = buildComponent(name, { theme: THEME, lang: 'ru' });
      expect(a?.svg, name).toBe(b?.svg);
    }
  });

  it('resets the id counter per top-level build, not per component call', () => {
    // A whole showcase screen nests a dozen parts; their ids must be unique inside ONE
    // document and must start from 0 again in the next one.
    const gradient: ForgeTheme = { ...THEME, gradOn: 1 };
    const screens = buildTab('showcase', { theme: gradient, lang: 'en' });
    for (const s of screens) {
      const ids = [...s.svg.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
      expect(new Set(ids).size, s.name).toBe(ids.length);
    }
    const twice = buildTab('showcase', { theme: gradient, lang: 'en' });
    expect(twice[0].svg).toBe(screens[0].svg);
  });

  it('refuses to draw outside a build context', () => {
    expect(() => label(0, 0, 'x', 12)).toThrow(/runBuild/);
  });
});

describe('button states', () => {
  const size = { colorRole: 'green' as const, width: 200, height: 80 };
  const parts = BUTTON_STATES.map(state => ({
    state,
    part: buildSkin({ component: 'button', ...size, state }, THEME),
  }));

  it('shares one outer silhouette across all four states', () => {
    const shells = parts.map(p => {
      const rect = elements(p.part.svg).find(e => e.tag === 'rect');
      expect(rect, p.state).toBeDefined();
      const a = rect!.attrs;
      return `${a.x}|${a.y}|${a.width}|${a.height}|${a.rx}`;
    });
    expect(new Set(shells).size).toBe(1);
  });

  it('still differs — a state that changes nothing is a bug too', () => {
    expect(new Set(parts.map(p => p.part.svg)).size).toBe(4);
  });

  it('pushes the pressed face down by the bevel and lightens the hovered one', () => {
    const faceY = (svg: string): number => {
      const rects = elements(svg).filter(e => e.tag === 'rect');
      return Number(rects[1].attrs.y); // [0] is the shell, [1] the face
    };
    const normal = parts.find(p => p.state === 'normal')!.part.svg;
    const pressed = parts.find(p => p.state === 'pressed')!.part.svg;
    const hover = parts.find(p => p.state === 'hover')!.part.svg;
    expect(faceY(pressed) - faceY(normal)).toBeCloseTo(THEME.bevel, 6);
    expect(faceY(hover)).toBe(faceY(normal));
    const faceFill = (svg: string): string =>
      elements(svg).filter(e => e.tag === 'rect')[1].attrs.fill;
    expect(faceFill(hover)).not.toBe(faceFill(normal));
  });

  it('bakes no caption into a state texture', () => {
    for (const p of parts) expect(p.part.svg, p.state).not.toContain('<text');
  });
});

describe('label escaping', () => {
  it('escapes markup and ampersands in a caption', () => {
    const svg = runBuild({ theme: THEME }, () => label(10, 10, '<script>a & b"', 20));
    expect(svg).toContain('&lt;script&gt;a &amp; b&quot;');
    expect(svg).not.toContain('<script>');
  });

  it('escapes a caption on the raw <text> path too', () => {
    // An INACTIVE tab caption is written by hand rather than through label(), so it needs its
    // own escape — this is the path an agent-supplied string would otherwise slip through.
    const comp = runBuild({ theme: THEME, lang: 'en' }, () => compTabBar(['ok', '<b>&"'], 0));
    expect(textContents(comp.svg)).toContain('&lt;b&gt;&amp;&quot;');
    expect(comp.svg).not.toContain('<b>');
  });

  it('leaves no raw markup in any caption of the whole kit', () => {
    for (const comp of buildAll({ theme: THEME, lang: 'ru' })) {
      for (const text of textContents(comp.svg)) {
        expect(text, `${comp.name}: ${text}`).not.toMatch(/[<>]/);
        expect(text, `${comp.name}: ${text}`).not.toMatch(/&(?!(amp|lt|gt|quot);)/);
      }
    }
  });
});

describe('normalizeTheme', () => {
  it('migrates the legacy shadowOff slider to the dx/dy pair', () => {
    const t = normalizeTheme({ shadowOff: 10 });
    expect(t.shadowDy).toBe(10);
    expect(t.shadowDx).toBe(Math.round(10 * 0.45));
  });

  it('rejects a bad hex and falls back to the default', () => {
    expect(normalizeTheme({ darkTone: 'not a colour' }).darkTone).toBe(DEFAULT_THEME.darkTone);
    expect(normalizeTheme({ darkTone: '#12345' }).darkTone).toBe(DEFAULT_THEME.darkTone);
    expect(normalizeTheme({ darkTone: '#abc' }).darkTone).toBe('#abc');
  });

  it('drops unknown keys', () => {
    const t = normalizeTheme({ radius: 3, iAmNotAThemeField: 'boo' }) as unknown as Record<
      string,
      unknown
    >;
    expect(t.radius).toBe(3);
    expect('iAmNotAThemeField' in t).toBe(false);
    expect(Object.keys(t).sort()).toEqual(Object.keys(DEFAULT_THEME).sort());
  });

  it('coerces numeric strings and clamps enums', () => {
    const t = normalizeTheme({
      radius: '12.5',
      glossType: 'NONSENSE',
      txtColor: 'DARK',
      shadowMode: 7,
    });
    expect(t.radius).toBe(12.5);
    expect(t.glossType).toBe(DEFAULT_THEME.glossType);
    expect(t.txtColor).toBe('dark');
    expect(t.shadowMode).toBe(DEFAULT_THEME.shadowMode);
  });

  it('keeps only known palette ids in the absolute override', () => {
    const t = normalizeTheme({ palette: { green: '#00ff00', nosuch: '#ff0000', red: 'bad' } });
    expect(t.palette).toEqual({ green: '#00ff00' });
  });

  it('accepts every preset and reproduces the defaults for Standard', () => {
    for (const name of Object.keys(PRESETS)) {
      const t = presetTheme(name);
      expect(Object.keys(t).sort(), name).toEqual(Object.keys(DEFAULT_THEME).sort());
    }
    expect(presetTheme('Standard')).toEqual(DEFAULT_THEME);
    expect(presetTheme('there is no such preset')).toEqual(DEFAULT_THEME);
  });
});

describe('sliceBorder', () => {
  const base = { width: 200, height: 80 };
  const flat: ForgeTheme = { ...DEFAULT_THEME, pad: 0, glossOn: 0, shadowMode: 0 };

  it('grows with the corner radius', () => {
    const small = sliceBorder({ ...flat, radius: 4 }, base);
    const big = sliceBorder({ ...flat, radius: 20 }, base);
    expect(big.left).toBeGreaterThan(small.left);
    expect(big.top).toBeGreaterThan(small.top);
  });

  it('grows at the BOTTOM with the bevel, and only there', () => {
    const thin = sliceBorder({ ...flat, bevel: 0 }, base);
    const thick = sliceBorder({ ...flat, bevel: 12 }, base);
    expect(thick.bottom).toBeGreaterThan(thin.bottom);
    expect(thick.top).toBe(thin.top);
  });

  it('grows at the TOP with a gloss band', () => {
    const off = sliceBorder(flat, base);
    const strip = sliceBorder({ ...flat, glossOn: 1, glossType: 'strip', glossH: 50 }, base);
    expect(strip.top).toBeGreaterThan(off.top);
  });

  it('widens the sides for a corner gloss instead', () => {
    const off = sliceBorder(flat, base);
    const corner = sliceBorder({ ...flat, glossOn: 1, glossType: 'corner' }, base);
    expect(corner.right).toBeGreaterThan(off.right);
    expect(corner.left).toBeGreaterThan(off.left);
  });

  it('grows on the side a drop shadow points to', () => {
    const off = sliceBorder(flat, base);
    const shadow = sliceBorder(
      { ...flat, shadowMode: 2, shadowDx: 4, shadowDy: 6, shadowBlur: 5 },
      base
    );
    expect(shadow.right).toBeGreaterThan(off.right);
    expect(shadow.bottom).toBeGreaterThan(off.bottom);
    expect(shadow.right - off.right).toBeGreaterThan(shadow.left - off.left);
  });

  it('never lets opposite caps meet', () => {
    const b = sliceBorder({ ...flat, radius: 200 }, { ...base, frameW: 40, frameH: 20 });
    expect(b.left + b.right).toBeLessThan(40);
    expect(b.top + b.bottom).toBeLessThan(20);
  });
});

describe('buildSkin (the engine lane)', () => {
  it('renders at exactly the requested size, with no padding and no filter', () => {
    const part = buildSkin(
      { component: 'button', colorRole: 'blue', width: 180, height: 64 },
      { ...THEME, pad: 24, shadowMode: 2 }
    );
    expect(part.w).toBe(180);
    expect(part.h).toBe(64);
    expect(Number(root(part.svg).attrs.width)).toBe(180);
    expect(part.svg).not.toContain('feDropShadow');
    expect(part.svg).not.toContain('filter=');
  });

  it('reports the nine-slice insets in design units', () => {
    const theme: ForgeTheme = { ...THEME, pad: 24, shadowMode: 2 };
    const part = buildSkin(
      { component: 'button', colorRole: 'blue', width: 180, height: 64 },
      theme
    );
    // pad and shadow are forced off, so the border must match a pad-0 / shadow-0 computation.
    expect(part.sliceBorder).toEqual(
      sliceBorder(
        { ...theme, pad: 0, shadowMode: 0 },
        { width: 180, height: 64, scale: 1, frameW: 180, frameH: 64 }
      )
    );
  });

  it('refuses to promise a nine-slice for a skewed or puffy theme', () => {
    const spec = {
      component: 'panel-body' as const,
      colorRole: 'sky' as const,
      width: 120,
      height: 120,
    };
    expect(buildSkin(spec, THEME).sliceBorder).not.toBeNull();
    expect(buildSkin(spec, { ...THEME, skew: 7 }).sliceBorder).toBeNull();
    expect(buildSkin(spec, { ...THEME, puffy: 6 }).sliceBorder).toBeNull();
  });

  it('draws every component of the union', () => {
    const components = [
      'button',
      'panel',
      'panel-body',
      'header-plate',
      'slot',
      'checkbox',
      'checkbox-mark',
      'slider-track',
      'slider-thumb',
      'bar-trough',
      'bar-fill',
    ] as const;
    for (const component of components) {
      const part = buildSkin({ component, colorRole: 'green', width: 96, height: 48 }, THEME);
      expect(part.w, component).toBe(96);
      expect(part.h, component).toBe(48);
      expect(badNumbers(part.svg), component).toEqual([]);
      expect(part.svg, component).not.toContain('<text');
    }
  });
});

describe('buildSkin: the gloss cap on stretchable parts', () => {
  /**
   * The bug this pins: `glossH` is a PERCENT OF THE FACE, so a 256-tall panel drew a 127 px
   * band, `sliceBorder()` had to fold the whole band into the top inset (a nine-slice stretches
   * the middle, so a band crossing the boundary grows with the node), and top + bottom then ate
   * any window shorter than ~2 x 127.
   */
  it('keeps a 256-tall panel body well under a squashing inset', () => {
    const part = buildSkin(
      { component: 'panel-body', colorRole: 'sky', width: 256, height: 256 },
      THEME
    );
    expect(part.sliceBorder).not.toBeNull();
    expect(part.sliceBorder!.top).toBeLessThan(64);
  });

  it('caps the band at max(radius, 16) design px on every stretchable part', () => {
    const themes: ForgeTheme[] = [
      THEME,
      { ...THEME, radius: 40 },
      { ...THEME, glossType: 'dome' },
      { ...THEME, glossH: 90, glossType: 'dome' },
    ];
    // Flat parts (recess / fill) derive their own radius from the height — a 256 px slider
    // track is a circle — and are pinned in skin-flat-border.spec.ts instead.
    for (const component of STRETCHED_COMPONENTS.filter(c => !FLAT_COMPONENTS.includes(c))) {
      for (const theme of themes) {
        const part = buildSkin({ component, colorRole: 'sky', width: 256, height: 256 }, theme);
        const cap = Math.max(theme.radius, MIN_GLOSS_BAND);
        // The engine lane forces pad 0; +1 for the rounding up of a slice edge.
        const ceiling = Math.ceil(theme.outline + Math.max(theme.radius, cap) + 1);
        expect(part.sliceBorder, component).not.toBeNull();
        expect(part.sliceBorder!.top, `${component} @ radius ${theme.radius}`).toBeLessThanOrEqual(
          ceiling
        );
      }
    }
  });

  it('leaves a button alone — it is baked at its real size, not stretched', () => {
    const tall = buildSkin(
      { component: 'button', colorRole: 'blue', width: 250, height: 256 },
      THEME
    );
    const panel = buildSkin(
      { component: 'panel-body', colorRole: 'blue', width: 250, height: 256 },
      THEME
    );
    expect(tall.sliceBorder!.top).toBeGreaterThan(panel.sliceBorder!.top);
  });

  it('lowers the band height and nothing else', () => {
    for (const glossType of ['strip', 'dome'] as const) {
      const theme: ForgeTheme = { ...THEME, glossType, glossH: 51 };
      const capped = capGlossForStretch(theme, 256);
      expect(capped.glossH, glossType).toBeLessThan(theme.glossH);
      // The KIND of highlight is the author's choice; only its height is structural.
      expect({ ...capped, glossH: theme.glossH }, glossType).toEqual(theme);
    }
  });

  it('leaves a theme whose band already fits untouched', () => {
    const modest: ForgeTheme = { ...THEME, glossH: 4 };
    expect(capGlossForStretch(modest, 256)).toBe(modest);
    // Corner highlights widen the SIDE caps, not the top one — nothing to cap.
    const corner: ForgeTheme = { ...THEME, glossType: 'corner' };
    expect(capGlossForStretch(corner, 256)).toBe(corner);
  });
});

describe('buildSkin: icon buttons', () => {
  it('draws a glyph, carries the state, and promises no nine-slice', () => {
    const part = buildSkin(
      { component: 'icon-button', colorRole: 'red', width: 64, height: 64, icon: 'close' },
      THEME
    );
    expect(part.w).toBe(64);
    expect(part.h).toBe(64);
    expect(part.state).toBe('normal');
    // The glyph sits in the middle — the region a nine-slice stretches.
    expect(part.sliceBorder).toBeNull();
    expect(part.svg).not.toContain('<text');
    expect(badNumbers(part.svg)).toEqual([]);
    expect(elements(part.svg).filter(el => el.tag === 'path').length).toBeGreaterThan(0);
  });

  it('accepts a function alias for the glyph', () => {
    const gear = buildSkin(
      { component: 'icon-button', colorRole: 'blue', width: 64, height: 64, icon: 'gear' },
      THEME
    );
    const settings = buildSkin(
      { component: 'icon-button', colorRole: 'blue', width: 64, height: 64, icon: 'settings' },
      THEME
    );
    expect(settings.svg).toBe(gear.svg);
  });

  it('defaults to the close glyph and differs from a captionless button', () => {
    const icon = buildSkin(
      { component: 'icon-button', colorRole: 'red', width: 64, height: 64 },
      THEME
    );
    const plain = buildSkin(
      { component: 'button', colorRole: 'red', width: 64, height: 64 },
      THEME
    );
    expect(icon.svg).not.toBe(plain.svg);
    expect(icon.svg.length).toBeGreaterThan(plain.svg.length);
  });

  it('builds all four states through buildButtonStates', () => {
    const states = buildButtonStates(
      { component: 'icon-button', colorRole: 'red', width: 64, height: 64, icon: 'close' },
      THEME
    );
    expect(Object.keys(states).sort()).toEqual([...BUTTON_STATES].sort());
    for (const state of BUTTON_STATES) {
      expect(states[state].state, state).toBe(state);
      expect(states[state].sliceBorder, state).toBeNull();
    }
    // Every state is a different picture; a swap that changed nothing would be a dead affordance.
    expect(new Set(BUTTON_STATES.map(state => states[state].svg)).size).toBe(BUTTON_STATES.length);
  });
});

describe('buildTemplate', () => {
  const collect = (root: TemplateNode): TemplateNode[] => {
    const all: TemplateNode[] = [];
    walkTemplate(root, n => all.push(n));
    return all;
  };

  for (const id of ['dialog', 'settings'] as const) {
    it(`gives ${id} unique node names`, () => {
      const spec = buildTemplate(id, THEME, { lang: 'en' });
      const names = collect(spec.root).map(n => n.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it(`references only parts it ships for ${id}`, () => {
      const spec = buildTemplate(id, THEME, { lang: 'en' });
      const missing: string[] = [];
      for (const node of collect(spec.root)) {
        if (node.part && !(node.part in spec.parts)) missing.push(`${node.name}.part=${node.part}`);
        for (const [state, key] of Object.entries(node.states ?? {})) {
          if (!(key in spec.parts)) missing.push(`${node.name}.states.${state}=${key}`);
        }
      }
      expect(missing).toEqual([]);
    });

    it(`lays ${id} out inside its own bounds`, () => {
      const spec = buildTemplate(id, THEME, { lang: 'en', width: 400, height: 500 });
      expect(spec.root.w).toBe(400);
      expect(spec.root.h).toBe(500);
      for (const node of collect(spec.root)) {
        expect(node.x, node.name).toBeGreaterThanOrEqual(0);
        expect(node.x + node.w, node.name).toBeLessThanOrEqual(spec.root.w);
        expect(node.y + node.h, node.name).toBeLessThanOrEqual(spec.root.h);
      }
    });
  }

  it('dresses the close control as a glyph button with no caption', () => {
    const spec = buildTemplate('dialog', THEME, { lang: 'en' });
    const close = collect(spec.root).find(n => n.name === 'CloseButton')!;
    expect(close.label).toBe('');
    for (const key of Object.values(close.states ?? {})) {
      expect(spec.parts[key].sliceBorder, key).toBeNull();
    }
  });

  it('gives every button all four state parts', () => {
    const spec = buildTemplate('settings', THEME, { lang: 'en' });
    const buttons = collect(spec.root).filter(n => n.type === 'Button2D');
    expect(buttons.length).toBeGreaterThan(3);
    for (const b of buttons) {
      expect(Object.keys(b.states ?? {}).sort(), b.name).toEqual([...BUTTON_STATES].sort());
    }
  });

  it('carries the captions as data, never as art', () => {
    const spec = buildTemplate('settings', THEME, { lang: 'ru' });
    const labels = collect(spec.root)
      .map(n => n.label)
      .filter(Boolean);
    expect(labels).toContain('НАСТРОЙКИ');
    for (const part of Object.values(spec.parts)) expect(part.svg).not.toContain('<text');
  });

  it('lays out one row per settings entry', () => {
    const spec = buildTemplate('settings', THEME, { lang: 'en' });
    const rows = collect(spec.root).filter(n => /^Row\d+Label$/.test(n.name));
    expect(rows.length).toBe(3);
    // The rows are stacked, not on top of each other.
    const ys = rows.map(r => r.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(new Set(ys).size).toBe(ys.length);
  });
});

describe('strings and the style contract', () => {
  it('has no half-translated caption', () => {
    expect(missingKeys()).toEqual([]);
  });

  it('reports the colours it actually painted', () => {
    const shifted: ForgeTheme = { ...THEME, hue: 30, palette: { green: '#00aa00' } };
    const tokens = buildTokensJson(shifted, { preset: 'Standard', now: '2026-01-01T00:00:00Z' });
    expect(tokens.palette.green.override).toBe('#00aa00');
    expect(tokens.palette.green.hex).toBe(C_of(shifted, 'green'));
    expect(tokens.tones.DARK).toBe(DARK_of(shifted));
    expect(tokens.meta.theme).toEqual(shifted);
    expect(tokens.components.length).toBe(listAll().length);
  });

  it("writes a style guide that carries the pix3 invariants and no other engine's", () => {
    const md = buildStyleMarkdown(THEME, null, { now: '2026-01-01T00:00:00Z' });
    expect(md).toContain('sliceBorderLeft/Right/Top/Bottom');
    expect(md).toContain('`pad: 0`');
    expect(md).toContain('Button2D');
    expect(md).not.toContain('SQ_CAP');
    expect(md).not.toContain('GAME_TOKENS');
  });
});
