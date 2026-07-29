import { config } from '../../config.js';

/**
 * Which origins this deployment trusts with a session.
 *
 * One list, three consumers, because they are three faces of the same question — "may this origin act
 * as the signed-in user?":
 *
 * - **CORS** returns `Access-Control-Allow-Credentials` only to a trusted origin, so no other site can
 *   *read* a cookie-authenticated response.
 * - **The CSRF guard** lets a trusted origin *write* with the cookie.
 * - **`/api/rooms`** mints a room token for the cookie's user only when the caller is trusted; anyone
 *   else speaks as a guest, so a hostile page cannot mint a token bound to a victim's identity.
 *
 * Trust is explicit on purpose. A new domain needs an entry in `TRUSTED_ORIGINS` — the one inference
 * made is same-site (a sibling subdomain of this server's own public origin), because `editor.pix3.dev`
 * and `cloud.pix3.dev` are one deployment and pretending otherwise would only invite a wildcard later.
 */

/** Dev-server origin the repo documents (`npm run dev` on port 8123). */
const DEV_SERVER_ORIGIN = 'http://localhost:8123';

/** Parses an origin, returning null for anything that is not a usable absolute URL. */
export function parseOrigin(value: string | null | undefined): URL | null {
  if (!value || value === 'null') {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Normalized `scheme://host[:port]`, or null when `value` is not one. */
export function normalizeOrigin(value: string | null | undefined): string | null {
  return parseOrigin(value)?.origin ?? null;
}

/**
 * The registrable-domain-ish suffix of a host: its last two labels.
 *
 * A real answer needs the Public Suffix List, which would be a dependency to load and refresh for one
 * comparison. Two labels is exactly right for `pix3.dev` and wrong for a multi-label public suffix like
 * `co.uk` — where it would treat two unrelated sites as siblings. That is why this is only ever used
 * against **this server's own host**: the operator who deploys under `example.co.uk` is also the one who
 * would then have to list their origins explicitly, and the failure mode is a missing entry, not a
 * silent trust of a stranger.
 */
function parentDomain(host: string): string | null {
  const labels = host.split('.');
  return labels.length >= 2 ? labels.slice(-2).join('.') : null;
}

/** True when `origin` is this server's own site: same scheme, same host or a sibling subdomain. */
export function isSameSite(origin: string, selfOrigin: string | null): boolean {
  const candidate = parseOrigin(origin);
  const self = parseOrigin(selfOrigin);
  if (!candidate || !self || candidate.protocol !== self.protocol) {
    return false;
  }

  if (candidate.hostname === self.hostname) {
    return true;
  }

  const parent = parentDomain(self.hostname);
  return (
    parent !== null && (candidate.hostname === parent || candidate.hostname.endsWith(`.${parent}`))
  );
}

/**
 * Origins trusted by configuration: this server's own public origin (it serves the admin panel), the
 * editor deployment, the documented dev-server port, and whatever the operator added.
 */
export function resolveTrustedOrigins(): Set<string> {
  const configured = config.TRUSTED_ORIGINS.split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);

  const origins = new Set<string>();
  for (const candidate of [
    config.PREVIEW_PUBLIC_URL,
    config.DASHBOARD_EDITOR_URL,
    DEV_SERVER_ORIGIN,
    ...configured,
  ]) {
    const origin = normalizeOrigin(candidate);
    if (origin !== null) {
      origins.add(origin);
    }
  }

  return origins;
}

/** Everything needed to rule on an origin, resolved once at startup. */
export interface OriginTrust {
  readonly trusted: ReadonlySet<string>;
  readonly selfOrigin: string | null;
  isTrusted(origin: string | null | undefined): boolean;
}

/** Builds the trust rules from configuration. */
export function createOriginTrust(): OriginTrust {
  const trusted = resolveTrustedOrigins();
  const selfOrigin = normalizeOrigin(config.PREVIEW_PUBLIC_URL);

  return {
    trusted,
    selfOrigin,
    isTrusted(origin) {
      const normalized = normalizeOrigin(origin);
      if (normalized === null) {
        // No Origin header at all, or a literal "null" from a sandboxed document. Neither is an origin
        // we can vouch for; each caller decides what that means for it.
        return false;
      }

      return trusted.has(normalized) || isSameSite(normalized, selfOrigin);
    },
  };
}

/** Process-wide instance. Configuration cannot change without a restart, so neither can trust. */
export const originTrust: OriginTrust = createOriginTrust();

/**
 * May a request bearing a session cookie act as that user, judged only by where it came from?
 *
 * The `Origin` header being **absent** means no browser sent it — curl, an agent script, CI — and there
 * the cookie is the caller's own by definition, so it is honoured. This is the same reasoning the CSRF
 * guard uses to let header-less writes through, and keeping the two consistent matters: a rule that
 * downgraded curl to a guest here while letting it write there would be a trap for our own tooling.
 *
 * A literal `Origin: null` (sandboxed iframe, `data:` document) is a browser context that refuses to
 * name itself, and is refused in turn.
 */
export function mayActAsUser(originHeader: string | undefined): boolean {
  if (originHeader === undefined) {
    return true;
  }

  return originTrust.isTrusted(originHeader);
}
