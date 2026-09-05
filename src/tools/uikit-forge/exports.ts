/**
 * UI Kit Forge page — the export lanes.
 *
 * These lanes are the *deliverable* for the tool's first consumer: a person who wants a UI kit
 * and may never open the editor at all (plan §1, §2.1). Nothing here writes into a project —
 * that is the editor-side host's job, and it uses different plumbing (`AssetGenService`).
 *
 * Two rules shape all of it:
 *
 *  1. **Every PNG is rendered without its caption.** The engine draws the label at runtime
 *     (`UIControl2D.label`), so a baked word would be wrong in every other language and at
 *     every other count, and one sprite has to serve all of them. SVG exports and the HTML
 *     gallery keep their text — a design cannot be judged without words in it.
 *  2. **Stripping text must not lose information.** A card used to arrive with a hole where its
 *     number belonged and nothing said where; the core records an anchor for every caption it
 *     drops, and those anchors travel in the atlas manifest.
 */
import {
  buildAll,
  buildComponent,
  buildStyleMarkdown,
  buildTokensJson,
  buildTab,
  fontFamilies,
  normalizeTheme,
  TABS,
  type ForgeComponent,
} from '@/services/uikit';

import { buildAtlas, type AtlasFrame, type AtlasManifest, type AtlasResult } from './atlas';
import { embeddedFontCss, svgWithFont } from './fonts';
import { canvasToPng, rasterize } from './raster';
import { presetLabel } from './presets-store';
import { buildOptions, session, setTheme, withSessionTheme } from './session';
import { busy, busyDone, download, toast } from './ui';

// ---------------------------------------------------------------------------
// Single-component downloads (the SVG / PNG links on a card)
// ---------------------------------------------------------------------------

/** One component as an SVG, with its faces inlined so the file stands alone. */
export async function exportComponentSvg(component: ForgeComponent): Promise<void> {
  const css = await embeddedFontCss();
  download(
    `${component.name}.svg`,
    new Blob([svgWithFont(component.svg, css)], { type: 'image/svg+xml' })
  );
}

/** One component as a PNG — rebuilt stripped, because art carries no text. */
export async function exportComponentPng(component: ForgeComponent): Promise<void> {
  const bare = buildComponent(component.name, buildOptions(true)) ?? component;
  const canvas = await rasterize(bare.svg, bare.w, bare.h, session.scale);
  download(`${component.name}.png`, await canvasToPng(canvas));
}

// ---------------------------------------------------------------------------
// Bulk exports
// ---------------------------------------------------------------------------

interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<FileSystemDirectoryHandle>;
}

/** Every component as a loose SVG: into a chosen folder, or one download at a time. */
export async function exportAllSvg(): Promise<void> {
  // Ask for the folder while the user gesture is still alive — after the first `await` of the
  // font fetch the browser would refuse the picker.
  let directory: FileSystemDirectoryHandle | null = null;
  const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker;
  if (typeof picker === 'function') {
    try {
      directory = await picker.call(window, { mode: 'readwrite' });
    } catch {
      return; // the user cancelled
    }
  }

  busy('Preparing the fonts…');
  try {
    const css = await embeddedFontCss();
    const all = buildAll(buildOptions(false));
    if (directory) {
      for (let i = 0; i < all.length; i++) {
        const component = all[i];
        if (!component) continue;
        busy(`Saving SVG ${i + 1}/${all.length}: ${component.name}.svg`);
        const handle = await directory.getFileHandle(`${component.name}.svg`, { create: true });
        const writable = await handle.createWritable();
        await writable.write(svgWithFont(component.svg, css));
        await writable.close();
      }
      toast(`${all.length} SVG saved to the folder`);
    } else {
      // Fallback: a browser without `showDirectoryPicker` — sequential downloads, paced so the
      // browser does not treat the burst as a popup storm.
      for (let i = 0; i < all.length; i++) {
        const component = all[i];
        if (!component) continue;
        busy(`Downloading ${i + 1}/${all.length}: ${component.name}.svg`);
        download(
          `${component.name}.svg`,
          new Blob([svgWithFont(component.svg, css)], { type: 'image/svg+xml' })
        );
        await new Promise(resolve => window.setTimeout(resolve, 220));
      }
      toast(`${all.length} SVG downloaded`);
    }
  } catch (error) {
    console.error(error);
    toast('SVG export failed');
  } finally {
    busyDone();
  }
}

/** One HTML page with every element — the human-readable half of the kit's docs. */
export async function exportHtmlGallery(): Promise<void> {
  busy('Building the HTML gallery…');
  try {
    const css = await embeddedFontCss();
    let sections = '';
    for (const tab of TABS) {
      const components = buildTab(tab.id, buildOptions(false)); // the gallery keeps its text
      sections +=
        `<h2>${tab.name}</h2><div class="grid">` +
        components
          .map(c => `<figure>${c.svg}<figcaption>${c.name} · ${c.w}×${c.h}</figcaption></figure>`)
          .join('') +
        '</div>';
    }
    const families = withSessionTheme(() => fontFamilies()).join(' + ');
    const page = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>UI Kit — gallery</title>
<style>
${css}
body{margin:0;background:linear-gradient(180deg,#0a5aa0,#083b6e);min-height:100vh;
  font:14px/1.5 system-ui,sans-serif;color:#fff;padding:32px}
h1{font-size:22px;margin:0 0 4px}
.meta{color:rgba(255,255,255,.65);font-size:12px;margin-bottom:24px}
h2{font-size:15px;margin:34px 0 14px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,.2)}
.grid{display:flex;flex-wrap:wrap;gap:26px;align-items:flex-start}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px}
figcaption{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:rgba(255,255,255,.6);
  background:rgba(0,0,0,.28);padding:2px 8px;border-radius:5px}
details{margin-top:36px}
summary{cursor:pointer;color:rgba(255,255,255,.7);font-size:12px}
pre{background:rgba(0,0,0,.35);padding:12px;border-radius:8px;font-size:11px;overflow:auto}
</style></head><body>
<h1>UI Kit — component gallery</h1>
<div class="meta">Generated by UI Kit Forge · ${new Date().toLocaleString()} · font ${families}</div>
${sections}
<details><summary>Theme (JSON) — paste back into UI Kit Forge to reproduce</summary>
<pre>${JSON.stringify(session.theme, null, 2)}</pre></details>
</body></html>`;
    download('uikit-gallery.html', new Blob([page], { type: 'text/html' }));
    toast('HTML gallery saved');
  } catch (error) {
    console.error(error);
    toast('HTML export failed');
  } finally {
    busyDone();
  }
}

/**
 * Rasterize, pack and describe — everything the atlas lanes share.
 *
 * `tabId` narrows the sheet to one tab: `iconset` ships the glyphs as their own `icons.png`,
 * because a consumer composes a backing and a glyph with two draws and loose glyphs beat one
 * sprite per pair.
 */
async function runAtlas(tabId?: string): Promise<AtlasResult> {
  const image = tabId === 'iconset' ? 'icons' : 'uikit';
  busy('Building the components…');
  // Stripped: the engine draws the captions, so no font is needed here either.
  const components = buildAll(buildOptions(true), tabId);
  const result = await buildAtlas({
    components,
    theme: session.theme,
    scale: session.scale,
    trimPad: session.trimPad,
    image,
    onProgress: (done, total, name) => busy(`Rasterizing ${done}/${total}: ${name}`),
  });
  busy('Packing the atlas…');
  return result;
}

/**
 * The manifest alone, with nothing downloaded.
 *
 * Exposed on `window.__UIKIT_FORGE_DEBUG__` so the export can be *inspected* — by a person in
 * the console, or by an agent driving the page — without a file ever reaching the Downloads
 * folder, which is unreadable from a browser session.
 */
export async function buildManifest(tabId?: string): Promise<AtlasManifest> {
  try {
    return (await runAtlas(tabId)).manifest;
  } finally {
    busyDone();
  }
}

/** The atlas PNG plus its manifest. @returns the per-frame records, or null on failure. */
export async function exportAtlas(tabId?: string): Promise<Record<string, AtlasFrame> | null> {
  try {
    const result = await runAtlas(tabId);
    const base = result.manifest.meta.image.replace(/\.png$/, '');
    download(`${base}.png`, await canvasToPng(result.canvas));
    download(
      `${base}.json`,
      new Blob([JSON.stringify(result.manifest, null, 2)], { type: 'application/json' })
    );
    toast(
      `Atlas ${result.canvas.width}×${result.canvas.height}, ${result.count} sprites` +
        (result.warned ? `, warnings: ${result.warned}` : '')
    );
    if (result.warned) logWarnings(result.warnings);
    return result.frames;
  } catch (error) {
    console.error(error);
    toast('Atlas build failed');
    return null;
  } finally {
    busyDone();
  }
}

/**
 * The whole deliverable in one go: the atlas, its manifest, and the style contract
 * (`tokens.json` + `STYLE.md`) built from the SAME per-frame records the atlas just produced.
 *
 * A PNG plus a manifest is enough for a human with the pictures in front of them; anyone
 * *developing* against the kit — an agent especially — needs the contract: which colour plays
 * which role, which shape numbers the theme stands for, and the invariants a new call site must
 * not break.
 */
export async function exportKit(): Promise<void> {
  const frames = await exportAtlas();
  if (!frames) return; // exportAtlas already reported the failure
  try {
    const preset = presetLabel(session.preset);
    const tokens = JSON.stringify(
      buildTokensJson(session.theme, { preset, scale: session.scale }),
      null,
      2
    );
    const markdown = buildStyleMarkdown(session.theme, frames, { preset, scale: session.scale });
    download('tokens.json', new Blob([tokens], { type: 'application/json' }));
    download('STYLE.md', new Blob([markdown], { type: 'text/markdown' }));
    toast('Style contract: tokens.json, STYLE.md');
  } catch (error) {
    console.error(error);
    toast(`Failed to write the style contract: ${error instanceof Error ? error.message : error}`);
  }
}

/** Warnings go to the console in full: a toast can only carry the count. */
function logWarnings(warnings: Record<string, string[]>): void {
  console.group('UI Kit Forge — slice warnings');
  for (const [name, list] of Object.entries(warnings)) console.warn(name, list);
  console.groupEnd();
}

// ---------------------------------------------------------------------------
// The theme as text (so a look can be reproduced or handed over)
// ---------------------------------------------------------------------------

export async function copyTheme(): Promise<void> {
  const text = JSON.stringify(session.theme, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast('Theme copied to the clipboard');
  } catch {
    download('theme.json', new Blob([text], { type: 'application/json' }));
    toast('Clipboard unavailable — the theme was downloaded instead');
  }
}

/**
 * Take a theme back in from text.
 *
 * Everything goes through `normalizeTheme`: it validates the hexes (a bad one silently paints
 * the whole kit `#NaNNaN`), migrates the legacy single `shadowOff` to the `shadowDx`/`shadowDy`
 * pair, and drops unknown keys.
 *
 * @returns true when a theme was applied.
 */
export function pasteTheme(): boolean {
  const text = window.prompt('Paste the theme JSON:');
  if (!text) return false;
  try {
    setTheme(normalizeTheme(JSON.parse(text)));
    toast('Theme applied');
    return true;
  } catch {
    toast('Error: invalid JSON');
    return false;
  }
}
