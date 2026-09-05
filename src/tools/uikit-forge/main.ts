/**
 * UI Kit Forge page — the wiring.
 *
 * Everything that DRAWS lives in `src/services/uikit/` (the host-agnostic core). This file only
 * turns widgets into theme writes, paints the stage, and hangs the export lanes off the
 * footer buttons.
 *
 * The page is a SECOND Vite entry, not part of the editor bundle: it must cold-load with no
 * project, no DI container and no editor services (plan §1 — the first consumer is a person who
 * may never open the editor). Nothing here imports from `@/fw`, `@/state` or any editor
 * service; the only shared code is the core and this folder.
 */
import { buildTab, TABS, type ForgeComponent } from '@/services/uikit';

import { createControls, renderControls } from './controls';
import {
  buildManifest,
  copyTheme,
  exportAllSvg,
  exportAtlas,
  exportComponentPng,
  exportComponentSvg,
  exportHtmlGallery,
  exportKit,
  pasteTheme,
} from './exports';
import { currentFaceSpecs, ensureFonts } from './fonts';
import {
  deleteUserPreset,
  isUserPreset,
  presetLabel,
  saveUserPreset,
  themeForPreset,
} from './presets-store';
import { buildOptions, patchTheme, session, setTheme, type ForgeSession } from './session';
import { icon, toast, type IconName } from './ui';

import './uikit-forge.css';

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/**
 * Every tab is a section of ONE scrolling page and the tab strip scrolls to it.
 *
 * The point of the bench is seeing the kit whole — a tab that HIDES the rest defeats that, and
 * a style is judged on how the pieces sit together rather than on one swatch at a time.
 */
const BACKDROP_CLASS: Readonly<Record<string, string>> = {
  'Game gradient': 'bg-game',
  Checker: 'bg-checker',
  Dark: 'bg-dark',
  Light: 'bg-light',
};

let activeTab = TABS[0]?.id ?? '';
let renderQueued = false;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`UI Kit Forge: #${id} is missing from the page.`);
  return node as T;
};

function applyBackdrop(): void {
  const stage = el('stage');
  for (const className of Object.values(BACKDROP_CLASS)) stage.classList.remove(className);
  stage.classList.add(BACKDROP_CLASS[session.backdrop] ?? 'bg-game');
}

function card(component: ForgeComponent): HTMLElement {
  const node = document.createElement('div');
  node.className = 'card';

  const canvas = document.createElement('div');
  canvas.className = 'cv';
  canvas.innerHTML = component.svg;

  const name = document.createElement('div');
  name.className = 'nm';
  name.append(`${component.name} `);

  const svgLink = document.createElement('button');
  svgLink.type = 'button';
  svgLink.textContent = 'SVG';
  svgLink.addEventListener('click', () => {
    void exportComponentSvg(component);
  });

  const pngLink = document.createElement('button');
  pngLink.type = 'button';
  pngLink.textContent = 'PNG';
  pngLink.title = 'Rendered without the caption — the engine draws that at runtime';
  pngLink.addEventListener('click', () => {
    void exportComponentPng(component);
  });

  name.append(svgLink, pngLink);
  node.append(canvas, name);
  return node;
}

function render(): void {
  const stage = el('stage');
  stage.textContent = '';
  for (const tab of TABS) {
    const section = document.createElement('section');
    section.className = 'sec';
    section.id = `sec_${tab.id}`;

    const heading = document.createElement('h3');
    heading.textContent = tab.name;
    if (tab.noExport) {
      const note = document.createElement('small');
      note.textContent = 'a specification, not sprites';
      heading.appendChild(note);
    }
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'secgrid';
    for (const component of buildTabSafely(tab.id)) grid.appendChild(card(component));
    section.appendChild(grid);
    stage.appendChild(section);
  }
}

/**
 * Build one tab, and turn a generator throw into a visible message instead of a blank page.
 *
 * A half-finished generator is a normal state while the kit grows, and losing the whole stage
 * (and with it the sliders' feedback) to one bad component would make the tool useless exactly
 * when it is being extended.
 */
function buildTabSafely(tabId: string): ForgeComponent[] {
  try {
    return buildTab(tabId, buildOptions(false));
  } catch (error) {
    console.error(`UI Kit Forge: tab "${tabId}" failed to build`, error);
    toast(`Tab "${tabId}" failed to build — see the console`);
    return [];
  }
}

/** Coalesce repaints: a slider fires `input` far faster than the kit can be redrawn. */
function requestRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  window.requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// ---------------------------------------------------------------------------
// The tab strip
// ---------------------------------------------------------------------------

function buildTabs(): void {
  const strip = el('tabs');
  strip.textContent = '';
  for (const tab of TABS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tab${tab.id === activeTab ? ' on' : ''}`;
    button.dataset.id = tab.id;
    button.textContent = tab.name;
    button.addEventListener('click', () => {
      activeTab = tab.id;
      markActiveTab();
      document.getElementById(`sec_${tab.id}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
    strip.appendChild(button);
  }
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  strip.appendChild(spacer);
}

function markActiveTab(): void {
  for (const node of document.querySelectorAll<HTMLElement>('#tabs .tab')) {
    node.classList.toggle('on', node.dataset.id === activeTab);
  }
}

/** The strip follows the scroll, so the label always names what is under the eye. */
function watchScroll(): void {
  const wrap = el('stageWrap');
  wrap.addEventListener('scroll', () => {
    let current = TABS[0]?.id ?? '';
    for (const tab of TABS) {
      const section = document.getElementById(`sec_${tab.id}`);
      if (section && section.offsetTop - wrap.scrollTop <= 90) current = tab.id;
    }
    if (current !== activeTab) {
      activeTab = current;
      markActiveTab();
    }
  });
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

function rebuildControls(): void {
  renderControls(el('controls'), createControls(handlers));
}

function pickPreset(id: string): void {
  const theme = themeForPreset(id);
  if (!theme) {
    toast('Preset not found');
    return;
  }
  setTheme(theme);
  session.preset = id;
  rebuildControls();
  requestRender();
  void ensureFonts().then(added => {
    if (added) requestRender(); // a preset may bring a family the page has not fetched yet
  });
  toast(`Preset "${presetLabel(id)}" applied`);
}

// ---------------------------------------------------------------------------
// Randomize
// ---------------------------------------------------------------------------

const rnd = (min: number, max: number): number => min + Math.random() * (max - min);
const rndInt = (min: number, max: number): number => Math.round(rnd(min, max));
const pick = <T>(values: readonly T[]): T => values[rndInt(0, values.length - 1)] as T;

function randomize(): void {
  const shadowRoll = Math.random();
  patchTheme({
    hue: rndInt(-180, 180),
    sat: rndInt(-12, 16),
    light: rndInt(-6, 8),
    radius: rndInt(6, 26),
    bevel: rndInt(3, 12),
    outline: Number(rnd(1.5, 4.5).toFixed(1)),
    skew: Math.random() > 0.6 ? Number(rnd(3, 10).toFixed(1)) : 0,
    gradOn: Math.random() > 0.35 ? 1 : 0,
    gradK: rndInt(5, 18),
    glossOn: Math.random() > 0.25 ? 1 : 0,
    glossType: pick(['strip', 'dome', 'corner'] as const),
    puffy: Math.random() > 0.6 ? Number(rnd(3, 8).toFixed(1)) : 0,
    glossH: rndInt(18, 55),
    glossA: rndInt(10, 40),
    shadowMode: shadowRoll < 0.35 ? 0 : shadowRoll < 0.7 ? 1 : 2,
    shadowDx: rndInt(-5, 8),
    shadowDy: rndInt(3, 10),
    shadowBlur: rndInt(3, 8),
    shadowA: rndInt(25, 60),
    txtColor: pick(['white', 'white', 'auto', 'auto', 'dark'] as const),
    txtOut: Number(rnd(1, 5).toFixed(1)),
    txtDrop: Number(rnd(1, 4).toFixed(1)),
    // A random look uses the generic role palette rather than someone's pinned one.
    palette: null,
  });
  rebuildControls();
  requestRender();
  toast('A new kit variant');
}

// ---------------------------------------------------------------------------
// Control-panel callbacks
// ---------------------------------------------------------------------------

const handlers = {
  onThemeChange: () => requestRender(),
  onFontChange: () => {
    requestRender();
    void ensureFonts().then(added => {
      if (added) requestRender();
    });
  },
  onLangChange: () => {
    requestRender();
    void ensureFonts().then(added => {
      if (added) requestRender();
    });
  },
  onPresetChange: (id: string) => pickPreset(id),
  onBackdropChange: () => applyBackdrop(),
};

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/** Put the inline vector glyph in front of every button that asked for one. */
function decorateButtons(): void {
  for (const button of document.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = button.dataset.icon as IconName | undefined;
    if (!name) continue;
    button.insertAdjacentHTML('afterbegin', icon(name));
  }
}

function wireButtons(): void {
  el('btnRandom').addEventListener('click', randomize);
  el('btnReset').addEventListener('click', () => {
    pickPreset('Standard');
  });

  el('btnPresetSave').addEventListener('click', () => {
    const name = window.prompt('Preset name:');
    if (!name) return;
    const id = saveUserPreset(name, session.theme);
    if (!id) {
      toast('Local storage unavailable — the preset was not saved');
      return;
    }
    session.preset = id;
    rebuildControls();
    toast(`Preset "${name}" saved`);
  });

  el('btnPresetDel').addEventListener('click', () => {
    if (!isUserPreset(session.preset)) {
      toast('Only your own presets can be deleted');
      return;
    }
    const name = presetLabel(session.preset);
    if (!deleteUserPreset(session.preset)) {
      toast('Local storage unavailable');
      return;
    }
    pickPreset('Standard');
    toast(`Preset "${name}" deleted`);
  });

  el('btnThemeCopy').addEventListener('click', () => {
    void copyTheme();
  });
  el('btnThemePaste').addEventListener('click', () => {
    if (!pasteTheme()) return;
    session.preset = 'Standard';
    rebuildControls();
    requestRender();
    void ensureFonts().then(added => {
      if (added) requestRender();
    });
  });

  el('btnKit').addEventListener('click', () => {
    void exportKit();
  });
  el('btnAtlas').addEventListener('click', () => {
    void exportAtlas();
  });
  el('btnIconsAtlas').addEventListener('click', () => {
    void exportAtlas('iconset');
  });
  el('btnAllSvg').addEventListener('click', () => {
    void exportAllSvg();
  });
  el('btnHtml').addEventListener('click', () => {
    void exportHtmlGallery();
  });

  const scale = el<HTMLSelectElement>('expScale');
  scale.value = String(session.scale);
  scale.addEventListener('change', () => {
    session.scale = parseFloat(scale.value) || 2;
  });

  const trim = el<HTMLInputElement>('trimPad');
  trim.checked = session.trimPad;
  trim.addEventListener('change', () => {
    session.trimPad = trim.checked;
  });
}

// ---------------------------------------------------------------------------
// The debug surface
// ---------------------------------------------------------------------------

interface ForgeDebugApi {
  /** The live session: theme, caption language, preset, export options. */
  readonly session: ForgeSession;
  /** Build the atlas manifest and hand it back WITHOUT downloading anything. */
  buildManifest(tabId?: string): Promise<unknown>;
  /** The components of one tab (or all of them), as `{ name, tab, w, h }`. */
  listComponents(tabId?: string): { name: string; tab: string; w: number; h: number }[];
  /** The faces the current theme needs, each with the weight it is drawn at. */
  faces(): { family: string; weight: number; cyr: boolean }[];
  /** Patch the theme from code and repaint. */
  patchTheme(patch: Record<string, unknown>): void;
  /** Switch preset by id (`Flat`, `user:My kit`). */
  pickPreset(id: string): void;
  render(): void;
}

declare global {
  interface Window {
    __UIKIT_FORGE_DEBUG__?: ForgeDebugApi;
  }
}

/**
 * A console/agent handle on the page.
 *
 * Kept deliberately: the interesting outputs of this tool are files, and a downloaded file is
 * unreadable from the session that asked for it. `buildManifest()` returns the same object the
 * export writes, so "did the manifest come out right" is answerable without leaving the page.
 */
function installDebugApi(): void {
  window.__UIKIT_FORGE_DEBUG__ = {
    session,
    buildManifest: tabId => buildManifest(tabId),
    listComponents: tabId =>
      (tabId ? buildTabSafely(tabId) : TABS.flatMap(tab => buildTabSafely(tab.id))).map(c => ({
        name: c.name,
        tab: c.tab,
        w: c.w,
        h: c.h,
      })),
    faces: () => currentFaceSpecs(),
    patchTheme: patch => {
      patchTheme(patch);
      rebuildControls();
      render();
    },
    pickPreset,
    render,
  };
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

rebuildControls();
buildTabs();
applyBackdrop();
watchScroll();
decorateButtons();
wireButtons();
installDebugApi();

// Draw once with whatever faces the browser has, then fetch the real ones and redraw: the
// preview and the export must be the same face, and it cannot be waited for synchronously.
render();
void ensureFonts().then(added => {
  if (added) render();
});
