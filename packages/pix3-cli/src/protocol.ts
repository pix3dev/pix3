/**
 * Wire constants of the editor ↔ `pix3 mcp` link channel (`.plans/external-agent-authoring.md` §1.2).
 *
 * `LINK_PROTOCOL` is the channel's own integer version, deliberately NOT the lockstep product
 * version: `@pix3/cli@X.Y.Z` says which editor it shipped beside, not what it can talk to. The
 * editor declares the range it supports and compares against this number; bump it on any
 * incompatible change to the routes or JSON shapes in `link-server.ts`.
 */
export const LINK_PROTOCOL = 1;

/** Loopback only. The server never binds anything else — see `link-server.ts`. */
export const LINK_HOST = '127.0.0.1';

/** Fixed discovery range the editor scans with `GET /hello`; the server takes the first free port. */
const LINK_PORT_FIRST = 8490;
const LINK_PORT_LAST = 8499;

export const DEFAULT_LINK_PORTS: readonly number[] = Array.from(
  { length: LINK_PORT_LAST - LINK_PORT_FIRST + 1 },
  (_, index) => LINK_PORT_FIRST + index
);

/**
 * Browser origins the server answers. A web page cannot forge `Origin`, so this is what keeps
 * arbitrary sites off the channel; requests with no `Origin` at all come from local processes,
 * which the plan's threat model trusts to the same degree it trusts them with the project files.
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  'https://editor.pix3.dev',
  'http://localhost:8123',
  'http://127.0.0.1:8123',
];

/** Project-relative directory the challenge files are written into. */
export const LINK_DIR = '.pix3/link';

/** How long a challenge file (and its nonce) lives before it is deleted unconfirmed. */
export const CLAIM_TTL_MS = 10_000;

/** A lease with no poll in flight and no poll for this long is dead. */
export const LEASE_TTL_MS = 10_000;

/** `GET /calls` answers empty after this long with nothing to deliver (kept under typical 30 s proxies). */
export const POLL_TIMEOUT_MS = 25_000;

/** How long an MCP tool call waits for the leased editor window to answer. */
export const CALL_TIMEOUT_MS = 60_000;

// --- Workspace server (`pix3 serve`, `.plans/external-agent-authoring-remote-ssh.md`) ----------

/**
 * Integer version of the workspace protocol (`serve/`: `/ws/*` routes and `/ws/events` frames),
 * separate from {@link LINK_PROTOCOL} and from the lockstep product version. Bump on any
 * incompatible change to a route, header or frame documented in `packages/pix3-cli/README.md`.
 */
export const WORKSPACE_PROTOCOL = 1;

/** `pix3 serve` without `--port` takes the first free port of 8490–8499. */
export const DEFAULT_WORKSPACE_PORTS: readonly number[] = DEFAULT_LINK_PORTS;

/** Server state of one workspace root (identity, token hash, live pid/port). Mode 0600. */
export const WORKSPACE_STATE_FILE = '.pix3/workspace.json';

/** A socket that has not sent a valid `{type:'auth'}` frame by then is closed. */
export const WS_AUTH_TIMEOUT_MS = 5_000;

/** `{type:'ping'}` cadence on `/ws/events`. */
export const WS_PING_INTERVAL_MS = 10_000;

/** How long a lease survives its holder's socket closing (so a reconnect can resume it). */
export const WS_LEASE_GRACE_MS = 10_000;

/** Quiet time before a burst of file-system events is turned into one `change` frame. */
export const WATCH_DEBOUNCE_MS = 100;
