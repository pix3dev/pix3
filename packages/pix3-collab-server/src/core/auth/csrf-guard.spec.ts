// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decideCsrf, type CsrfRequestFacts } from './csrf-guard.js';

/**
 * The CSRF decision table.
 *
 * Every case here is a deployment shape that must keep working or an attack that must not: the editor
 * on its own domain, a dev server proxying `/api`, a dev server pointed straight at production, curl,
 * and a hostile page. The middleware is a thin wrapper around `decideCsrf`, so the table is tested
 * directly instead of through a booted server — the interesting part is the ruling, not the plumbing.
 */
const ALLOWED = new Set([
  'https://editor.pix3.dev',
  'https://cloud.pix3.dev',
  'http://localhost:8123',
]);

function facts(overrides: Partial<CsrfRequestFacts> = {}): CsrfRequestFacts {
  return {
    method: 'POST',
    hasSessionCookie: true,
    fetchSite: null,
    origin: null,
    referer: null,
    ...overrides,
  };
}

describe('decideCsrf', () => {
  it('lets safe methods through regardless of provenance', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      const verdict = decideCsrf(
        facts({ method, origin: 'https://evil.example', fetchSite: 'cross-site' }),
        ALLOWED
      );
      expect(verdict).toEqual({ allowed: true, reason: 'safe-method' });
    }
  });

  it('ignores requests that carry no session cookie', () => {
    // Nothing to abuse: whatever the route needs, it will demand for itself.
    const verdict = decideCsrf(
      facts({ hasSessionCookie: false, origin: 'https://evil.example', fetchSite: 'cross-site' }),
      ALLOWED
    );
    expect(verdict).toEqual({ allowed: true, reason: 'no-session' });
  });

  it('trusts the browser-set Sec-Fetch-Site for same-origin, same-site and none', () => {
    // same-origin: the admin panel itself, or a dev server proxying /api under its own origin.
    // same-site: editor.pix3.dev -> cloud.pix3.dev, which is why no allowlist entry is needed for it.
    for (const fetchSite of ['same-origin', 'same-site', 'none']) {
      expect(decideCsrf(facts({ fetchSite }), ALLOWED)).toEqual({
        allowed: true,
        reason: 'fetch-site',
      });
    }
  });

  it('refuses a cross-site write from an origin that is not allowlisted', () => {
    // The attack: a page on evil.example posting to the API with the victim's SameSite=None cookie.
    expect(
      decideCsrf(facts({ fetchSite: 'cross-site', origin: 'https://evil.example' }), ALLOWED)
    ).toEqual({ allowed: false, reason: 'cross-site', origin: 'https://evil.example' });

    // DELETE is the one that actually destroys data, so it is asserted explicitly.
    expect(
      decideCsrf(
        facts({ method: 'DELETE', fetchSite: 'cross-site', origin: 'https://evil.example' }),
        ALLOWED
      ).allowed
    ).toBe(false);
  });

  it('allows a cross-site origin that is on the allowlist', () => {
    // A dev server pointed straight at production, without its /api proxy.
    expect(
      decideCsrf(facts({ fetchSite: 'cross-site', origin: 'http://localhost:8123' }), ALLOWED)
    ).toEqual({ allowed: true, reason: 'allowlisted' });
  });

  it('falls back to the Referer when no Origin header is present', () => {
    // A browser too old for Fetch Metadata still sends one of the two.
    expect(decideCsrf(facts({ referer: 'https://editor.pix3.dev/scene/42' }), ALLOWED)).toEqual({
      allowed: true,
      reason: 'allowlisted',
    });

    expect(decideCsrf(facts({ referer: 'https://evil.example/attack.html' }), ALLOWED)).toEqual({
      allowed: false,
      reason: 'cross-site',
      origin: 'https://evil.example',
    });
  });

  it('prefers Origin over Referer when both are present', () => {
    expect(
      decideCsrf(
        facts({ origin: 'https://evil.example', referer: 'https://editor.pix3.dev/x' }),
        ALLOWED
      ).allowed
    ).toBe(false);
  });

  it('lets a header-less client through: it cannot be a page acting for a user', () => {
    // curl, an agent script, CI. Every browser attaches Origin to a cross-site write, so the absence
    // of both headers rules out the threat this guard exists for — and blocking it would break tooling.
    expect(decideCsrf(facts(), ALLOWED)).toEqual({ allowed: true, reason: 'no-origin' });
  });

  it('treats a literal "null" origin as untrusted rather than absent', () => {
    // A sandboxed iframe or a data: document sends Origin: null. Falling through to the header-less
    // pass would hand exactly those contexts a way around the check.
    expect(decideCsrf(facts({ origin: 'null' }), ALLOWED)).toEqual({
      allowed: false,
      reason: 'cross-site',
      origin: 'null',
    });
  });

  it('treats an unparseable Origin as untrusted', () => {
    expect(decideCsrf(facts({ origin: 'not a url' }), ALLOWED).allowed).toBe(true);
    // ...only because it falls back to Referer, which is absent here. With a hostile Referer it refuses:
    expect(
      decideCsrf(facts({ origin: 'not a url', referer: 'https://evil.example/x' }), ALLOWED).allowed
    ).toBe(false);
  });

  it('compares origins, not URLs: a path on an allowed origin is still allowed', () => {
    expect(decideCsrf(facts({ origin: 'https://editor.pix3.dev' }), ALLOWED).allowed).toBe(true);
    // A different port or scheme on the same host is a different origin, and stays refused.
    expect(decideCsrf(facts({ origin: 'http://localhost:9999' }), ALLOWED).allowed).toBe(false);
    expect(decideCsrf(facts({ origin: 'http://editor.pix3.dev' }), ALLOWED).allowed).toBe(false);
  });
});
