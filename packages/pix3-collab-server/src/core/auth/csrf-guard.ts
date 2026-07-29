import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { normalizeOrigin as normalizeOriginValue, originTrust } from './origin-trust.js';

/**
 * CSRF protection for the cookie-authenticated surface.
 *
 * The session cookie has to be `SameSite=None`, because the editor lives on `editor.pix3.dev` and the
 * API on `cloud.pix3.dev` — different sites, so a `Strict` (or even `Lax`) cookie would simply never be
 * sent and the editor could not talk to the backend at all. That is the whole reason this file exists:
 * the cookie cannot be the defence, so the *request's provenance* is.
 *
 * A token-based scheme (synchronizer or double-submit) was the alternative and was rejected: the editor
 * deploys independently of this server, so the day the server started demanding a token, every cached
 * client build would start failing writes until it reloaded. This check needs no client cooperation at
 * all, which is exactly what makes it deployable on a live system.
 *
 * The decision, in order:
 *
 * 1. **Safe methods pass.** GET/HEAD/OPTIONS change nothing.
 * 2. **No session cookie → pass.** With no cookie there is no privilege to abuse; the route's own
 *    `requireAuth` will answer 401 if it needed one.
 * 3. **`Sec-Fetch-Site` decides when the browser sent it.** `same-origin` (the admin panel, or a dev
 *    server proxying `/api`) and `same-site` (`editor.pix3.dev` → `cloud.pix3.dev`) pass; `none` is a
 *    user-initiated navigation. The header is browser-controlled and unforgeable by page script, so it
 *    is the strongest signal available — and it needs no allowlist for our own domains.
 * 4. **Otherwise the `Origin` (or `Referer`) must be allowlisted.** This is the path a browser without
 *    Fetch Metadata takes, and the escape hatch for a genuinely cross-site origin we choose to trust
 *    (a dev server pointed straight at production, say).
 * 5. **No `Origin` and no `Referer` → pass.** That is not a browser: every browser attaches `Origin` to
 *    a cross-site POST/PUT/DELETE, so a header-less request cannot be a page attacking us on a user's
 *    behalf. It is curl, an agent script, or CI — and blocking those would break real tooling to defend
 *    against a threat model they are not part of.
 *
 * Deliberately NOT guarded: `/api/rooms` and `/api/preview`. Those are reached from arbitrary origins
 * by design — a published game or a shared player link — and they authorize with their own per-session
 * tokens rather than the cookie, so an Origin check there would break the feature without adding
 * protection. `/api/auth` is likewise unguarded: login and register do not act on an existing session.
 */

/** Methods that cannot change state, so they never need a provenance check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `Sec-Fetch-Site` values that are safe on their own. */
const TRUSTED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

/** Error code the rejection answers with, so a client can tell it from an authorization failure. */
export const CSRF_REJECTED_CODE = 'csrf_origin_rejected';

/** Why a request was allowed or refused. Returned separately from the middleware so it can be tested. */
export type CsrfVerdict =
  | {
      allowed: true;
      reason: 'safe-method' | 'no-session' | 'fetch-site' | 'allowlisted' | 'no-origin';
    }
  | { allowed: false; reason: 'cross-site'; origin: string };

/** The subset of a request the decision reads. */
export interface CsrfRequestFacts {
  readonly method: string;
  readonly hasSessionCookie: boolean;
  readonly fetchSite: string | null;
  readonly origin: string | null;
  readonly referer: string | null;
}

/**
 * Normalizes an origin string for the decision below.
 *
 * A literal `null` — what a sandboxed iframe or a `data:` document sends — is kept as the string
 * `'null'` rather than folded into "absent": treating it as absent would let exactly those contexts
 * fall through to the no-Origin pass.
 */
function normalizeOrigin(value: string | null): string | null {
  return value === 'null' ? 'null' : normalizeOriginValue(value);
}

/** Decides one request. Pure, so the table of cases can be tested without an HTTP server. */
export function decideCsrf(
  facts: CsrfRequestFacts,
  allowedOrigins: ReadonlySet<string>
): CsrfVerdict {
  if (SAFE_METHODS.has(facts.method.toUpperCase())) {
    return { allowed: true, reason: 'safe-method' };
  }

  if (!facts.hasSessionCookie) {
    return { allowed: true, reason: 'no-session' };
  }

  if (facts.fetchSite !== null && TRUSTED_FETCH_SITES.has(facts.fetchSite)) {
    return { allowed: true, reason: 'fetch-site' };
  }

  const origin = normalizeOrigin(facts.origin) ?? normalizeOrigin(facts.referer);
  if (origin === null) {
    return { allowed: true, reason: 'no-origin' };
  }

  if (allowedOrigins.has(origin)) {
    return { allowed: true, reason: 'allowlisted' };
  }

  return { allowed: false, reason: 'cross-site', origin };
}

/** Reads the facts the decision needs out of an Express request. */
function readFacts(req: Request): CsrfRequestFacts {
  const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  const token = cookies?.token;

  return {
    method: req.method,
    hasSessionCookie: typeof token === 'string' && token.trim().length > 0,
    fetchSite: req.get('sec-fetch-site')?.toLowerCase() ?? null,
    origin: req.get('origin') ?? null,
    referer: req.get('referer') ?? null,
  };
}

/**
 * Builds the middleware.
 *
 * The allowlist comes from {@link originTrust} — the same set CORS uses to decide who may read a
 * cookie-authenticated response, because "may write as the user" and "may read as the user" must never
 * drift apart.
 */
export function createCsrfGuard(): RequestHandler {
  const allowedOrigins = originTrust.trusted;

  return (req: Request, res: Response, next: NextFunction): void => {
    const verdict = decideCsrf(readFacts(req), allowedOrigins);
    if (verdict.allowed) {
      next();
      return;
    }

    // Worth a log line: a rejection is either an attack or a deployment whose origin needs adding, and
    // both are things an operator wants to see. The cookie value is never logged.
    console.warn(
      `[pix3-collab] CSRF: refused ${req.method} ${req.originalUrl} from origin ${verdict.origin}`
    );

    res.status(403).json({
      error: CSRF_REJECTED_CODE,
      message:
        'This request carries a session cookie but comes from an origin this server does not trust. ' +
        'Add it to TRUSTED_ORIGINS if that is intentional.',
    });
  };
}
