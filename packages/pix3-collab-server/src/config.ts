export const config = {
  PORT: parseInt(process.env.PORT || '4001', 10),
  DB_PATH: process.env.DB_PATH || './data/core.sqlite',
  HOCUSPOCUS_DB_PATH: process.env.HOCUSPOCUS_DB_PATH || './data/crdt.sqlite',
  PROJECTS_STORAGE_DIR: process.env.PROJECTS_STORAGE_DIR || './data/projects',
  // Per-user personal Asset Library bundles: LIBRARY_STORAGE_DIR/<itemId>/<bundle-relative>.
  // Ownership/visibility live in the `library_items` table; the directory only holds blobs.
  LIBRARY_STORAGE_DIR: process.env.LIBRARY_STORAGE_DIR || './data/library',
  JWT_SECRET: process.env.JWT_SECRET || 'change-me-in-production',
  PASSWORD_SALT_ROUNDS: parseInt(process.env.PASSWORD_SALT_ROUNDS || '10', 10),
  COLLABORATION_PATH: process.env.COLLABORATION_PATH || '/collaboration',
  PREVIEW_PATH: process.env.PREVIEW_PATH || '/preview',
  // Sliding TTL for anonymous preview sessions (any WS/HTTP activity extends it).
  PREVIEW_SESSION_TTL_MS: parseInt(
    process.env.PREVIEW_SESSION_TTL_MS || String(6 * 60 * 60 * 1000),
    10
  ),
  // Public origin of THIS server (e.g. https://cloud.pix3.dev). Returned to the
  // editor on session creation so join links carry an explicit relay origin and
  // players/agents connect here directly, no matter where the player page or
  // editor is served from. Leave empty for same-origin/proxied local setups.
  PREVIEW_PUBLIC_URL: (process.env.PREVIEW_PUBLIC_URL || '').replace(/\/+$/, ''),

  // ── Room Fabric (pix3-rooms) ───────────────────────────────────────────────
  // This server is the *minter*: it is the only party that holds both the fabric's
  // service token (to create rooms) and the HS256 secret the fabric verifies room
  // tokens with. Clients never see either. Empty ROOMS_ADMIN_URL disables the
  // whole surface with a 503 rather than half-working.
  ROOMS_ADMIN_URL: (process.env.ROOMS_ADMIN_URL || '').replace(/\/+$/, ''),
  ROOMS_SERVICE_TOKEN: process.env.ROOMS_SERVICE_TOKEN || '',
  // Public WebSocket endpoint handed to clients. Defaults to ROOMS_ADMIN_URL with
  // the http(s) scheme swapped for ws(s) and `/ws` appended, which is the shape
  // pix3-rooms serves; set it explicitly when the fabric sits on another host.
  ROOMS_WS_URL: (process.env.ROOMS_WS_URL || '').replace(/\/+$/, ''),
  // The fabric verifies HS256 with this exact secret (Rooms__Auth__JwtSecret) and
  // requires >= 32 bytes. Defaults to the account JWT secret because a single-host
  // deployment shares one; split them by setting this when they diverge.
  ROOMS_JWT_SECRET: process.env.ROOMS_JWT_SECRET || process.env.JWT_SECRET || '',
  ROOMS_TOKEN_ISSUER: process.env.ROOMS_TOKEN_ISSUER || 'pix3-cloud',
  ROOMS_TOKEN_AUDIENCE: process.env.ROOMS_TOKEN_AUDIENCE || 'pix3-rooms',
  // Token lifetime bounds a session: an expired token cannot re-join or resume, so
  // this is also "how long a player may keep playing without asking us again".
  ROOMS_TOKEN_TTL_SECONDS: parseInt(process.env.ROOMS_TOKEN_TTL_SECONDS || String(6 * 60 * 60), 10),
  // Room creation is the expensive verb (a room is a thread on the fabric), so it
  // is bucketed per IP. Joins are not: they are bounded by the room's own caps.
  ROOMS_CREATE_PER_MINUTE: parseInt(process.env.ROOMS_CREATE_PER_MINUTE || '12', 10),
} as const;
