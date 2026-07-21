import { subscribe } from 'valtio/vanilla';

import { appState } from '@/state';

const BASE_TITLE = 'Pix3';

/** Builds the tab title, prefixing the active project name when one is open. */
const composeTitle = (projectName: string | null): string =>
  projectName ? `${projectName} — ${BASE_TITLE}` : BASE_TITLE;

/**
 * Keeps the browser tab title in sync with the active project name
 * (e.g. "pix3 — Pix3"), falling back to the base title when no project is open.
 */
export function installDocumentTitleSync(): void {
  const apply = (): void => {
    document.title = composeTitle(appState.project.projectName);
  };

  apply();
  subscribe(appState.project, apply);
}
