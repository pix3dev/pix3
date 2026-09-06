/**
 * UI Kit Forge page — the page's own feedback bits: a toast, a busy overlay, a download, and
 * the inline vector icons its chrome is built from.
 *
 * Split out from the wiring so `exports.ts` can report progress without importing `main.ts`
 * (that would make the module graph circular). Everything here touches the DOM of
 * `tools/uikit-forge.html` and nothing else — no editor services, no DI, no `appState`: the
 * page has to work with no project open and, in principle, with no editor at all.
 *
 * Icons are inline SVG rather than emoji on purpose (AGENTS.md: "icons are vector, never
 * emoji"). The page cannot reach `IconService` — that is an editor service behind DI — so the
 * handful of glyphs it needs are inlined here in the same Feather geometry the editor uses,
 * drawn in `currentColor` so they follow the button they sit in.
 */

let toastTimer = 0;

const byId = (id: string): HTMLElement | null => document.getElementById(id);

/** A short message at the bottom of the page. */
export function toast(message: string): void {
  const el = byId('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

/**
 * The blocking overlay with a spinner. An export walks a hundred components and rasterizes
 * each one, which takes seconds — without this the page looks hung.
 */
export function busy(message: string): void {
  const overlay = byId('busy');
  const label = byId('busyMsg');
  if (label) label.textContent = message;
  if (overlay) overlay.classList.add('show');
}

export function busyDone(): void {
  byId('busy')?.classList.remove('show');
}

/**
 * Hand a blob to the browser as a download.
 *
 * An anchor click, not a `showSaveFilePicker` — the page is also framed by the editor's
 * `#uikit` route, and a same-origin frame keeps anchor downloads working while a sandboxed
 * one would kill them.
 */
export function download(name: string, blob: Blob): void {
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(anchor.href);
    anchor.remove();
  }, 500);
}

/** Feather-geometry glyph bodies, keyed by the Feather name. */
const ICON_PATHS: Readonly<Record<string, string>> = {
  shuffle:
    '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>' +
    '<polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>' +
    '<line x1="4" y1="4" x2="9" y2="9"/>',
  'rotate-ccw': '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  save:
    '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>' +
    '<polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  trash:
    '<polyline points="3 6 5 6 21 6"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
    '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  copy:
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  clipboard:
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' +
    '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  package:
    '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/>' +
    '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 ' +
    '1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>' +
    '<polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  grid:
    '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>' +
    '<rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>' +
    '<circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  'file-text':
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>' +
    '<line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
};

/** The name of every glyph this page can draw. */
export type IconName = keyof typeof ICON_PATHS;

/** One inline `currentColor` SVG, ready to drop into an `innerHTML`. */
export function icon(name: IconName): string {
  const body = ICON_PATHS[name] ?? '';
  return (
    '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
  );
}
