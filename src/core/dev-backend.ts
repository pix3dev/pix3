/**
 * Dev-only backend switch: which collab server a localhost editor talks to.
 *
 * In dev every `/api`, `/collaboration` and `/preview` request is same-origin and the Vite proxy
 * forwards it (see `routeToDevBackend` in `vite.config.ts`). The proxy picks the target per request
 * from the `pix3-dev-backend` cookie, so switching is "write the cookie, reload the page" — no
 * dev-server restart. Without the cookie the mode decides: `npm run dev` → local, `npm run
 * dev:prod` → prod. The proxy keeps each backend's session under its own cookie name, so switching
 * back and forth does not log you out of either.
 *
 * A production build has no proxy, so everything here reports "unavailable" there.
 */

export type DevBackendId = 'local' | 'prod';

const COOKIE_NAME = 'pix3-dev-backend';

/** Undefined outside a Vite build (e.g. under Vitest, which does not apply the define). */
function devBackends(): typeof __PIX3_DEV_BACKENDS__ | null {
  return typeof __PIX3_DEV_BACKENDS__ === 'undefined' ? null : __PIX3_DEV_BACKENDS__;
}

export function isDevBackendSwitchAvailable(): boolean {
  return import.meta.env.DEV && devBackends() !== null;
}

export function getDevBackendTargets(): Readonly<Record<DevBackendId, string>> {
  return (
    devBackends()?.targets ?? { local: 'http://localhost:4001', prod: 'https://cloud.pix3.dev' }
  );
}

export function getActiveDevBackend(): DevBackendId {
  const match = document.cookie
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE_NAME}=`));
  const value = match?.slice(COOKIE_NAME.length + 1);
  return value === 'local' || value === 'prod' ? value : (devBackends()?.default ?? 'local');
}

/** Human label for a backend: its host (`localhost:4001`, `cloud.pix3.dev`). */
export function describeDevBackend(id: DevBackendId): string {
  const target = getDevBackendTargets()[id];
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

/** Persists the choice and reloads, so every service reconnects against the new backend. */
export function switchDevBackend(id: DevBackendId): void {
  if (!isDevBackendSwitchAvailable() || id === getActiveDevBackend()) {
    return;
  }
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `${COOKIE_NAME}=${id}; path=/; max-age=${maxAge}; SameSite=Lax`;
  window.location.reload();
}
