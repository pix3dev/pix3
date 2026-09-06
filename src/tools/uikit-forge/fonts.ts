/**
 * UI Kit Forge page — the fonts.
 *
 * Two problems, one loader.
 *
 * 1. **Export.** The SVG is rasterized through an `<img>`, and an `<img>` cannot see the
 *    page's fonts — the face has to be inlined into the document as a `data:` URI or the
 *    caption falls back to a system font at a different width. So every SVG/PNG/HTML export
 *    gets `@font-face` rules carrying the woff2 bytes.
 * 2. **Preview.** The page links no font CDN of its own, so picking a family used to change
 *    nothing at all: the SVG asked for it, the browser had never heard of it, and every
 *    caption fell through to the system stack. Injecting *the export's own* CSS into the page
 *    fixes that and guarantees preview and export cannot drift.
 *
 * Both blocks of a family are taken, **latin and cyrillic**: the kit is bilingual and the
 * second picker exists precisely to supply the Cyrillic glyphs. Faces are fetched per family
 * *and weight* — a Cyrillic caption is drawn in the supplier at the SUPPLIER's weight
 * (`ForgeTheme.faceFor`), and Google's `css2` answers an unavailable `wght` with an HTML
 * error page, so asking for the primary's weight would silently yield no face at all.
 *
 * Only a SUCCESS is cached: a CDN hiccup used to poison the family for the rest of the
 * session, and the caption stayed on the system face until a reload.
 */
import { faceSpecs, type FaceInlineSpec } from '@/services/uikit';

import { withSessionTheme } from './session';
import { toast } from './ui';

/** `family:weight` → the `@font-face` rules that carry it. Successes only. */
const faceCache = new Map<string, string>();

/** The faces already injected into the page's own `<style>`. */
const injected = new Map<string, string>();

async function toBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The `@font-face` CSS for ONE family at ONE weight, cached.
 *
 * @returns `''` when the face could not be obtained — the caller decides whether that is
 *   worth telling the user about.
 */
export async function faceCssFor(family: string, weight: number): Promise<string> {
  const key = `${family}:${weight}`;
  const cached = faceCache.get(key);
  if (cached !== undefined) return cached;

  let out = '';
  try {
    const familyParam = family.replace(/ /g, '+');
    const sheet = await (
      await fetch(
        `https://fonts.googleapis.com/css2?family=${familyParam}:wght@${weight}&display=swap`
      )
    ).text();

    // The stylesheet is a run of "/* subset */ @font-face {…}" pairs. Read the subset off
    // each pair rather than searching for one: we want cyrillic AND latin, and a family may
    // declare neither name (then take whatever single face is there).
    const WANTED = ['cyrillic', 'latin'];
    const pairs = [...sheet.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]+\})/g)];
    let blocks = pairs.filter(m => WANTED.includes(m[1] ?? '')).map(m => m[2] ?? '');
    if (!blocks.length) {
      const any = /@font-face\s*\{[^}]+\}/.exec(sheet)?.[0];
      blocks = any ? [any] : [];
    }
    if (!blocks.length) throw new Error('no @font-face block');

    const faces: string[] = [];
    for (const block of blocks) {
      const url = /url\((https:[^)]+)\)/.exec(block)?.[1];
      if (!url) continue;
      // The unicode-range has to travel with the face: both blocks are declared at the same
      // family and weight, and without a range the LAST rule wins for every character — the
      // Cyrillic file would answer for Latin too and have no glyphs for it.
      const range = /unicode-range:\s*([^;}]+)/.exec(block)?.[1];
      faces.push(
        `@font-face{font-family:'${family}';font-weight:${weight};` +
          (range ? `unicode-range:${range};` : '') +
          `src:url(data:font/woff2;base64,${await toBase64(url)}) format('woff2');}`
      );
    }
    if (!faces.length) throw new Error('no woff2 url');
    out = faces.join('');
  } catch (error) {
    console.warn(`could not inline ${family} ${weight}, falling back to a system face:`, error);
    out = '';
  }

  if (out) faceCache.set(key, out);
  return out;
}

/** The faces the CURRENT theme draws with — primary plus the Cyrillic supplier. */
export function currentFaceSpecs(): FaceInlineSpec[] {
  return withSessionTheme(() => faceSpecs());
}

/**
 * The CSS for every family a caption may need, plus the families that could not be inlined.
 *
 * A PARTIAL failure must be reported: with the Latin face inlined and the Cyrillic one
 * missing the page looks perfectly fine until a Russian word shows up, and then it drops to
 * the system font at the wrong weight.
 */
export async function fontCssReport(): Promise<{ css: string; missing: string[] }> {
  const parts: string[] = [];
  const missing: string[] = [];
  for (const spec of currentFaceSpecs()) {
    const css = await faceCssFor(spec.family, spec.weight);
    if (css) parts.push(css);
    else missing.push(`${spec.family} ${spec.weight}`);
  }
  return { css: parts.join(''), missing };
}

/** The same rules as one string — for the exports, which have nobody to tell. */
export async function embeddedFontCss(): Promise<string> {
  return (await fontCssReport()).css;
}

/** Put the inlined faces inside an SVG document so an `<img>` render can see them. */
export function svgWithFont(svg: string, fontCss: string): string {
  if (!fontCss) return svg;
  return svg.replace(/^(<svg[^>]*>)/, `$1<defs><style>${fontCss}</style></defs>`);
}

/**
 * Make sure the faces the current theme needs are available to the PAGE, then hand back
 * whether anything changed (so the caller can repaint).
 *
 * Faces accumulate — switching back to a family already seen costs nothing.
 */
export async function ensureFonts(): Promise<boolean> {
  const specs = currentFaceSpecs();
  const missing: string[] = [];
  let added = false;

  for (const spec of specs) {
    const key = `${spec.family}:${spec.weight}`;
    if (injected.has(key)) continue;
    const css = await faceCssFor(spec.family, spec.weight);
    if (!css) {
      missing.push(`${spec.family} ${spec.weight}`);
      continue;
    }
    injected.set(key, css);
    added = true;
  }

  if (added) {
    let style = document.getElementById('uikitFontFaces');
    if (!style) {
      style = document.createElement('style');
      style.id = 'uikitFontFaces';
      document.head.appendChild(style);
    }
    style.textContent = [...injected.values()].join('\n');
  }

  if (missing.length) {
    toast(`Font "${missing.join('", "')}" unavailable — drawing with the system one`);
  }

  try {
    // Warm up with text each face can actually render: a Cyrillic face restricted by
    // `unicode-range` does not load at all for the default Latin probe string, and then the
    // first repaint measures the fallback instead of it.
    await Promise.all(
      specs.map(spec =>
        document.fonts.load(`${spec.weight} 40px '${spec.family}'`, spec.cyr ? 'Аа' : 'BESbswy')
      )
    );
  } catch {
    // The faces are injected; a failed warm-up only costs one repaint.
  }

  return added;
}
