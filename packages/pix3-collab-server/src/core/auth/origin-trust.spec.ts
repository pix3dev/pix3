// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isSameSite, mayActAsUser, normalizeOrigin, parseOrigin } from './origin-trust.js';

/**
 * The trust rules behind three separate defences — CORS credentials, the CSRF guard, and room-token
 * identity. They share one list precisely so "may read as the user" and "may write as the user" cannot
 * drift apart, which makes this table the single place their agreement is pinned.
 */
describe('normalizeOrigin', () => {
  it('reduces a URL to its origin', () => {
    expect(normalizeOrigin('https://editor.pix3.dev/scene/42?x=1')).toBe('https://editor.pix3.dev');
    expect(normalizeOrigin('http://localhost:8123')).toBe('http://localhost:8123');
  });

  it('rejects anything that is not a usable origin', () => {
    // A literal "null" is what a sandboxed iframe sends; it must never normalize to something usable.
    expect(normalizeOrigin('null')).toBeNull();
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
  });

  it('keeps the port, because a different port is a different origin', () => {
    expect(normalizeOrigin('http://localhost:8123')).not.toBe(
      normalizeOrigin('http://localhost:9999')
    );
    expect(parseOrigin('http://localhost:8123')?.port).toBe('8123');
  });
});

describe('isSameSite', () => {
  const self = 'https://cloud.pix3.dev';

  it('accepts the same host and its siblings under the same parent domain', () => {
    // The deployment this exists for: editor.pix3.dev talking to cloud.pix3.dev.
    expect(isSameSite('https://cloud.pix3.dev', self)).toBe(true);
    expect(isSameSite('https://editor.pix3.dev', self)).toBe(true);
    expect(isSameSite('https://rooms.pix3.dev', self)).toBe(true);
    expect(isSameSite('https://pix3.dev', self)).toBe(true);
  });

  it('refuses a different site, a different scheme, and a lookalike host', () => {
    expect(isSameSite('https://evil.example', self)).toBe(false);
    // Downgraded scheme is a different origin and a different site for our purposes.
    expect(isSameSite('http://editor.pix3.dev', self)).toBe(false);
    // The classic suffix trap: "notpix3.dev" ends with "pix3.dev" as a STRING but is another domain.
    expect(isSameSite('https://notpix3.dev', self)).toBe(false);
    expect(isSameSite('https://pix3.dev.evil.example', self)).toBe(false);
  });

  it('is inert when the server has no public origin configured', () => {
    // Local development: nothing is same-site, and the explicit list carries the dev port instead.
    expect(isSameSite('https://editor.pix3.dev', null)).toBe(false);
    expect(isSameSite('http://localhost:8123', '')).toBe(false);
  });
});

describe('mayActAsUser', () => {
  it('honours a cookie that arrived without any Origin header', () => {
    // curl, an agent script, CI: the cookie is the caller's own, and the CSRF guard reasons the same
    // way about header-less writes. Disagreeing here would trap our own tooling.
    expect(mayActAsUser(undefined)).toBe(true);
  });

  it('refuses a browser context that will not name itself', () => {
    // Origin: null — sandboxed iframe or a data: document.
    expect(mayActAsUser('null')).toBe(false);
  });

  it('refuses an origin outside the trust list', () => {
    expect(mayActAsUser('https://evil.example')).toBe(false);
  });

  it('accepts the documented dev-server origin', () => {
    // Trusted by default so an editor pointed straight at a remote backend keeps its account identity.
    expect(mayActAsUser('http://localhost:8123')).toBe(true);
  });
});
