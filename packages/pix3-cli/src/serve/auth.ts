import { readState, stateStamp, tokenMatches, type TokenRecord } from './state-file.ts';

/**
 * Token check shared by the HTTP routes and the `/ws/events` auth frame.
 *
 * The token record is re-read whenever `.pix3/workspace.json` changes, so `pix3 serve
 * --new-token` (rotation) and deleting the file (revocation, plan §11.1) take effect on a running
 * server without a restart. Failed attempts are counted in a sliding window; past the limit every
 * attempt — right token or not — is answered `rate_limited` until the window moves on.
 */

export type AuthOutcome =
  | { readonly ok: true; readonly tokenHash: string }
  | { readonly ok: false; readonly code: 'unauthorized' }
  | { readonly ok: false; readonly code: 'rate_limited'; readonly retryAfter: number };

export class WorkspaceAuth {
  private readonly root: string;
  private readonly workspaceId: string;
  private readonly limit: number;
  private readonly windowMs: number;
  private failures: number[] = [];
  private record: TokenRecord | null = null;
  private stamp: string | null | undefined = undefined;

  constructor(options: {
    readonly root: string;
    readonly workspaceId: string;
    readonly failureLimit: number;
    readonly failureWindowMs: number;
  }) {
    this.root = options.root;
    this.workspaceId = options.workspaceId;
    this.limit = options.failureLimit;
    this.windowMs = options.failureWindowMs;
  }

  /** The token record now in force; `null` = revoked (no file, no token, or another workspace's file). */
  current(): TokenRecord | null {
    const stamp = stateStamp(this.root);
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      const state = readState(this.root);
      // A state file minted for another workspace (copied over ours) does not authorise here.
      this.record = state && state.workspaceId === this.workspaceId ? state.token : null;
    }
    return this.record;
  }

  check(presented: string): AuthOutcome {
    const now = Date.now();
    this.failures = this.failures.filter(at => now - at < this.windowMs);
    if (this.failures.length >= this.limit) {
      const retryAfter = Math.max(1, Math.ceil((this.windowMs - (now - this.failures[0])) / 1000));
      return { ok: false, code: 'rate_limited', retryAfter };
    }
    const record = this.current();
    if (record && tokenMatches(presented, record)) return { ok: true, tokenHash: record.sha256 };
    this.failures.push(now);
    return { ok: false, code: 'unauthorized' };
  }
}
