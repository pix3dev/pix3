# Code review — 2026-08-16

Full-codebase review of the Pix3 editor, `@pix3/runtime` and `@pix3/collab-server`, run against
`main` @ `3a6f223`.

**Status: closed.** All findings fixed on `fix/code-review-2026-08-16` except three deferred by
agreement (see §3). Start at §4 for what changed and §5 for what to check before deploying.

> **Doc-policy note.** `AGENTS.md` rule 8 forbids new feature `.md` files; this report was requested
> explicitly. It is a one-off audit record, not a feature doc — if it should live in `.plans/`
> instead, `git mv` it there once the fixes land.

## 1. Baseline (before any change)

| Check | Result |
|---|---|
| `npm run type-check` | **0 errors** |
| `npm run lint` | **0 errors**, 4 warnings (`no-explicit-any` in `Sprite2D.ts:109-110`, `AnimatedSprite3D.ts:100,102`) |
| `npm run test` | **300 files / 3358 tests passed** (43 s) |
| `npx knip` | 1 unused file (`src/sw.ts`, a false positive — see L6), 107 "unused exports" (overwhelmingly Lit `@customElement` classes) |

Scale: `src/` 764 files / 229 kLOC, `pix3-runtime` 249 files / 71 kLOC, `pix3-collab-server`
42 files / 8.6 kLOC.

**The editor and runtime are in good shape.** The scans that usually find trouble came back nearly
empty: one `@ts-expect-error` in the whole repo (justified), 12 `as any`, no un-cleaned Valtio
subscriptions in components, no orphaned `window` listeners, no `setInterval` without
`clearInterval`, no `debugger`, 3 TODOs, and Three.js disposal is centralised correctly in
`NodeBase.disposeResources()`. Node-creation commands are properly factored onto
`CreateNodeBaseCommand` / `CreateNodeOperationBase` with no duplication, and every direct
`appState` write outside `src/services` is session/UI state, which `AGENTS.md` explicitly permits.

**The findings concentrate in `packages/pix3-collab-server`.** That is where the review's weight sits.

---

## 2. Findings

### CRITICAL

#### C1 — Arbitrary file write outside the project directory via the CRDT persistence path

`packages/pix3-collab-server/src/sync/hocuspocus.ts:107-131`

`onStoreDocument` writes two client-controlled path sets straight to disk without containment:

```ts
const relativePath = normalizeStoredScenePath(filePathValue);   // strips res:// and leading '/'
const fullPath = path.resolve(projectDir, relativePath);        // '..' survives
fs.writeFileSync(fullPath, snapshotValue, 'utf-8');
// …and for scripts:
const fullPath = path.join(scriptsDir, scriptPath);             // scriptPath is a Y.Map key
fs.writeFileSync(fullPath, value.toString(), 'utf-8');
```

`normalizeStoredScenePath` (line 214) removes the `res://` scheme and leading slashes but never
`..` segments, and `path.join` offers no containment at all. Any collaborator with `editor` role on
any project can set a scene's `filePath` to `res://../../../../home/pix3/.ssh/authorized_keys` — or,
for scripts, any key whatsoever — and write attacker-chosen content anywhere the server process can
reach. The scene path is additionally forced to end in `.pix3scene`; **the script path is not
constrained at all**, so that lane is a fully general arbitrary write. On Windows a drive-absolute
`C:/…` also escapes, because only leading `/` is stripped.

Contrast with `storage-router.ts:22-29` and `library-storage.ts:21-27`, which both do this
correctly (`path.resolve` + `startsWith(dir + path.sep)`). This path simply never got the same
treatment.

**Fix:** route both writes through a shared containment helper (the one in `library-storage.ts`
generalises cleanly), reject anything that escapes with a logged skip rather than a write, and add a
spec that feeds `../` and an absolute path through `onStoreDocument`.

---

### HIGH

#### H1 — Cross-tenant overwrite of library bundles (`POST /api/library/items/:id`)

`packages/pix3-collab-server/src/core/library/library-router.ts:60-113`

The route never checks that `:id` belongs to the caller. It wipes and rewrites the item directory
(line 95) *before* touching the database, then calls `upsertLibraryItem`, whose
`ON CONFLICT(id) DO UPDATE` (`library-service.ts:76-80`) deliberately does **not** filter on
`owner_id` and does **not** reassign it. So any authenticated user who knows an item UUID can:

- destroy and replace another user's bundle files, and
- overwrite that user's manifest and `updated_at` while the row keeps its original owner — meaning
  the victim's next sync pulls the attacker's content as their own; and
- flip `visibility` to `'private'` on a **public Asset Store item**, taking it out of the catalog.

Compare `getOwnerLibraryItem` (used correctly by the GET route on line 31) — the ownership check
exists, it is just not applied here.

**Fix:** look up the row first; 403/404 unless it is absent or owned by the caller. Add
`AND owner_id = ?` to the upsert's conflict path as defence in depth, and cover both with a spec.

#### H2 — Unauthorised deletion of any library item's files (`DELETE /api/library/items/:id`)

`packages/pix3-collab-server/src/core/library/library-router.ts:116-125`

```ts
softDeleteLibraryItem(req.user!.id, itemId, deletedAt);   // owner-scoped — returns false, ignored
fs.rmSync(getItemDir(itemId), { recursive: true, force: true });   // NOT scoped
```

The tombstone update is correctly owner-scoped and returns `changes > 0`, but its result is
discarded and the `rmSync` runs unconditionally. Any authenticated user can delete any library
item's bundle files — including curated Asset Store bundles — leaving a DB row pointing at nothing.

**Fix:** gate the whole handler on `softDeleteLibraryItem(...)` returning `true`; 404 otherwise.

#### H3 — `JWT_SECRET` falls back to `change-me-in-production` with no production guard

`packages/pix3-collab-server/src/config.ts:9`, consumed at `core/auth/auth-middleware.ts:29-35`

Nothing fails the boot when the secret is left at its default. A deployment that misses one env var
starts and serves normally while every session cookie is forgeable by anyone who has read this
repository — including `is_admin` accounts, since `requireAdmin` trusts the row the forged
`userId` resolves to. The same default also silently becomes `ROOMS_JWT_SECRET` (`config.ts:45`),
which the Room Fabric verifies against.

**Fix:** refuse to start when `NODE_ENV === 'production'` and the secret is the default or shorter
than 32 bytes. This is the one change here that should ship on its own, ahead of everything else.

#### H4 — No rate limiting on `/api/auth/login` and `/api/auth/register`

`packages/pix3-collab-server/src/core/auth/auth-router.ts:17,63`

The only rate limiter in the server is `rooms-router.ts:45` (room creation, per IP). Login is
unthrottled, so password guessing is bounded only by bcrypt cost (`PASSWORD_SALT_ROUNDS` default
10), and registration is unthrottled, so the users table can be filled by a script.

**Fix:** reuse the sliding-window bucket already written for rooms — lift it into a small shared
helper and mount it on both endpoints (login keyed on IP + email, register on IP).

---

### MEDIUM

#### M1 — Login leaks account existence through response timing

`packages/pix3-collab-server/src/core/auth/auth-router.ts:79-88`

An unknown email returns 401 immediately; a known one first runs `bcrypt.compare`. The difference is
tens of milliseconds and trivially measurable, turning the login endpoint into an email-enumeration
oracle. Combined with H4 (no throttling) the whole user list is enumerable.

**Fix:** compare against a fixed dummy hash when the user is absent, so both branches pay the same
bcrypt cost.

#### M2 — Unauthenticated, unbounded preview-session creation

`packages/pix3-collab-server/src/core/preview/preview-router.ts:37-53`

`POST /api/preview/sessions` requires no auth, is outside the CSRF guard by design, and has no rate
limit or cap. Each call allocates a session held for `PREVIEW_SESSION_TTL_MS` (6 h by default,
sliding) in an in-process `Map` (`preview-service.ts:63`). A loop exhausts server memory.

**Fix:** per-IP creation bucket (same helper as H4) plus a hard ceiling on live sessions.

#### M3 — Detached `.finally()` in `AssetLoader` raises a phantom uncaught error on every failed load

`packages/pix3-runtime/src/core/AssetLoader.ts:239, 271, 322, 377`

```ts
this.audioLoadInFlight.set(resourcePath, loadPromise);
loadPromise.finally(() => { this.audioLoadInFlight.delete(resourcePath); });
return loadPromise;
```

`.finally()` returns a *new* promise that nobody handles. When `loadPromise` rejects, the caller's
own `catch` handles the original, but the derived promise rejects unobserved → `unhandledrejection`.
That is not cosmetic here: `src/core/agent-introspection.ts:324` and `src/player/player-main.ts:197`
both listen for `unhandledrejection` and surface it as a runtime error in the Logs panel and the
Game-tab banner. So one missing texture produces a duplicate, misattributed error report. It is also
the cause of the known "Vitest exits non-zero although all tests pass" behaviour when a spec parses
a `res://` texture without seeding `textureCache`.

**Fix:** do the map cleanup inside the async IIFE's own `finally` block, so no detached chain
exists. Add a spec asserting no unhandled rejection on a failing load.

#### M4 — Nine copies of a `catch {}` that swallows every viewport-update failure

`src/features/properties/TransformCompleteOperation.ts:70-76, 90-96, 105-111`,
`Transform2DCompleteOperation.ts:70-76, 90-96, 105-111`,
`TargetTransformOperation.ts:68-74, 88-94, 103-109`

```ts
try {
  const vr = container.getService<ViewportRendererService>(…);
  vr.updateNodeTransform(node);
  // eslint-disable-next-line no-empty
} catch {}
```

The intent is to tolerate a missing viewport service in headless/test contexts, but the `try` also
wraps `updateNodeTransform`, so a genuine failure inside the renderer is discarded silently — in the
undo and redo closures too, where a swallowed error leaves the viewport showing the wrong transform
with no diagnostic. The block is duplicated verbatim nine times across three operations that are
otherwise near-identical.

**Fix:** one shared helper (`syncViewportTransform(container, node)`) that catches only the
"service not registered" case and lets anything else propagate or log.

#### M5 — `/api/auth/register` validates almost nothing

`packages/pix3-collab-server/src/core/auth/auth-router.ts:19-29`

Only presence and `password.length >= 6` are checked. `email` is never validated as an email and
never length-bounded; `username` likewise. Non-string bodies reach `db.prepare(...).get(email, …)`
directly (better-sqlite3 will throw on an object, producing a 500 rather than a 400).

**Fix:** type-check and length-bound all three fields, validate the email shape, normalise case
(the login lookup is `WHERE email = ?` — case-sensitive — while `projects-service.ts:81` uses
`LOWER(email)`, so the two disagree today).

#### M6 — Share-token lifecycle is asymmetric and silently destructive

`packages/pix3-collab-server/src/core/projects/projects-router.ts:197-216`,
`projects-service.ts:151-156`

`POST /:id/share` is open to `owner` **and** `editor`, but `DELETE /:id/share` is owner-only — an
editor can mint a public read link the owner cannot see they created. And `generateShareToken`
unconditionally overwrites the existing token, so a second call silently invalidates every link
already handed out, with no confirmation in the response.

**Fix:** align the two roles (owner-only for both is the safer default), and either return the
existing token or make rotation explicit.

#### M7 — Typed linting is configured but no type-aware rule is switched on

`eslint.config.js:66-72, 108-116`

Both blocks set `parserOptions.project`, which pays the full type-check cost on every lint run, yet
the rule set is only `tseslint.configs.recommended` — none of `no-floating-promises`,
`no-misused-promises`, or `await-thenable` is enabled. Turning `no-floating-promises` on for this
audit surfaced **22 sites** (see appendix), including the M3 bug. The cost is already being paid;
the benefit is not being collected.

**Fix:** enable `no-floating-promises` and `no-misused-promises` (`checksVoidReturn: false` keeps
Lit event handlers quiet), fix or `void`-mark the 22 sites.

---

### LOW

| # | Finding | Location |
|---|---|---|
| L1 | The "raw body" upload branch is unreachable: only `express.json()` is mounted, so `req.body` is never a `Buffer` or a `string`. `ApiClient.uploadFile` only ever sends multipart. Dead code that reads like a supported path. | `storage-router.ts:114-125` |
| L2 | `filePath` is interpolated into request URLs unencoded while `projectId` is encoded — a path containing `?` or `#` truncates, and `..` is normalised away by the URL parser before it reaches the server. | `src/services/cloud/ApiClient.ts:280, 307, 325, 364` |
| L3 | `console.log` on every texture/audio load in the runtime hot path (5 in `AssetLoader`), plus per-attach/detach logging in three shipped `core:*` behaviours — noise in exported games. | `AssetLoader.ts`, `SineBehavior.ts`, `SimpleMoveBehavior.ts`, `RotateBehavior.ts` |
| L4 | 41 import cycles (`madge --circular`). Most are the deliberate `NodeBase ↔ SceneService` core; a handful in the editor (`ViewportRenderService ↔ features/properties/*`, `CloudProjectService ↔ LocalSyncService`, `inspector-panel ↔ inspector-*-renderers`) are incidental. | repo-wide |
| L5 | No spec covers the server auth flow (`auth-router`, `auth-middleware`) or the hocuspocus load/store path — the two places C1, H3 and M1 live. `csrf-guard` and `origin-trust` are well covered by contrast. | `packages/pix3-collab-server` |
| L6 | `src/sw.ts` reports as an unused file because it is not declared as a knip entry (it is referenced by the Vite PWA config, not by an import). | `knip.json` |
| L7 | 4 `no-explicit-any` warnings — the only ones in the repo. | `Sprite2D.ts:109-110`, `AnimatedSprite3D.ts:100,102` |
| L8 | `collab-status-bar.ts` writes `appState.collaboration.remoteUsers` directly from a UI component; presence state is `CollaborationService`'s to own. Permitted by the gateway-scope rule, but it is the one place UI writes a service's own state. | `src/ui/collab/collab-status-bar.ts:91, 167` |

---

## 3. Fix plan (as agreed, 2026-08-16)

Ordered by the task's rule (security → correctness → architecture → quality). One commit per group,
`type-check` + `lint` + `test` green after each. All ten shipped; see §4.

Two decisions taken before starting:

- **#1 hard-fails** in production rather than warning. The operational risk is stated with it: a
  deployment currently running on the default secret will not start after this, so the env preflight
  in §5 has to run before the rollout.
- **#9 is owner-only for both create and revoke**, with the silent invalidation of an
  already-distributed link removed at the same time.

**Deliberately not done**: L4 (untangling 41 import cycles is a wide refactor for no concrete
defect), L8 (permitted by the current gateway-scope rule), and the knip "unused export" list (false
positives from `@customElement`).

Nothing here touched the `@pix3/runtime` public API or the scene format: fix 6 is internal to
`AssetLoader`, and fix 2 changed only where the *server* puts bytes, not the YAML or the
`Y.Map('scene')` shape.

---

## Appendix — floating promises found (22)

```
packages/pix3-runtime/src/core/AssetLoader.ts:239, 271, 322, 377   ← M3
src/services/core/RouterService.ts:24, 40
src/services/viewport/Viewport2DProxyRegistry.ts:1823
src/services/viewport/ViewportRenderService.ts:797, 1039
src/sw.ts:109
src/ui/assets/asset-tree.ts:880, 1874, 1932, 1936
src/ui/flow/pix3-flow-shell.ts:541
src/ui/object-inspector/inspector-property-renderers.ts:1264
src/ui/scene-tree/scene-tree-node.ts:211
src/ui/viewport/editor-tab.ts:783, 1218
src/ui/welcome/pix3-welcome.ts:166
src/features/scene/CreateSprite2DOperation.spec.ts:205, 209
```

---

## 4. What was fixed

Branch `fix/code-review-2026-08-16`, nine commits. Every finding from CRITICAL down to LOW is
closed except the three listed as deferred in §3.

| Commit | Findings | What changed |
|---|---|---|
| `8e92bed` | H3 | `core/config-preflight.ts`: in `NODE_ENV=production` the process exits 1 when `JWT_SECRET` is unset, still the default, or under 32 bytes. `ROOMS_JWT_SECRET` checked when overridden. Development fallback untouched. |
| `3c99b37` | C1 | `core/storage/contained-path.ts` — one containment rule, now used by all three callers. CRDT persistence extracted to `sync/document-files.ts` (which is what made it testable). Escaping paths are skipped and logged, never rewritten. Also fixed `npm run type-check`, which never covered this package. |
| `628fabc` | H1, H2 | Ownership gate before any filesystem work on `POST /api/library/items/:id`; `DELETE` now honours the owner-scoped tombstone's verdict. `upsertLibraryItem` carries `WHERE owner_id = excluded.owner_id` and returns whether it applied. |
| `d374d0a` | H4, M1, M2, M5, L5 | `core/rate-limit.ts` generalised from the rooms bucket, applied to login (per IP *and* per email), register, and preview-session creation; 429s carry `Retry-After`. Login's unknown-account branch burns an equivalent bcrypt comparison. Registration input validated; emails stored and looked up lowercased. First spec for this surface. |
| `43d350f` | M3 | `AssetLoader` in-flight cleanup goes through `then(clear, clear)` instead of a detached `.finally`, so a failed load rejects once — into the caller — instead of also firing `unhandledrejection`. |
| `9e21aa1` | M4 | `ServiceContainer.hasService` + `syncViewportTransform`, replacing nine copies of a `catch {}` that discarded real renderer failures including inside undo/redo. |
| `f4817c8` | M7 | `no-floating-promises` / `no-misused-promises` / `await-thenable` enabled; all 18 sites marked `void`, and one spec that asserted without awaiting an async undo/redo fixed. |
| `0d21b68` | M6 | Share link is owner-only to create *and* revoke, and idempotent — the existing token comes back unless `rotate: true` is passed. First spec for this router. |
| `d77810c` | L1, L2, L3, L6, L7 | Last four `any`s removed; dead raw-body upload branch deleted; `/files/*` URLs encoded per segment; 15 per-asset / per-node `console.log`s removed from the runtime; `src/sw.ts` declared as a knip entry. |

### Verification

Every fix was checked against the bug it claims to fix by **reinstating the old code and confirming
the new tests fail** — a test that passes both ways is not evidence:

| Fix | Tests failing against the pre-fix code |
|---|---|
| C1 | 6 of 12 (the 6 legitimate round-trip cases keep passing) |
| H1, H2 | 4 |
| H4, M1, M5 | 14 of 23 |
| M3 | 3 of 4 |
| M6 | 4 of 11 |

Two things that check turned up, which a passing suite had hidden:

- The first HTTP-level timing assertion for M1 **passed against the vulnerable code** — at a test
  salt-round, request overhead swamps the bcrypt difference. It was replaced by a unit assertion in
  `password.spec.ts` at the production cost, which does fail an early-returning implementation.
- Four operation specs stubbed `ServiceContainer` by hand and relied on `getService` *throwing*.
  They compiled and passed only because the `catch {}` in M4 turned that into success.

Final state: `type-check` 0 errors (now including `pix3-collab-server`, which it did not before),
`lint` 0 errors **0 warnings** (was 4), `test` 309 files / 3451 tests passing (was 300 / 3358 — 51
new tests), `build` clean, `knip` reports no unused files.

---

## 5. Before deploying

**The JWT preflight will stop a server that is currently on the default secret.** Check the
environment on the host *before* restarting the service:

```bash
# Must be >= 32 bytes and not 'change-me-in-production'.
awk -F= '/^JWT_SECRET=/{printf "JWT_SECRET: %d bytes -> %s\n", length($2), $2}' shared/.env
# Only checked when set explicitly; unset, it is JWT_SECRET.
awk -F= '/^ROOMS_JWT_SECRET=/{printf "ROOMS_JWT_SECRET: %d bytes\n", length($2)}' shared/.env
```

If either is wrong, the server prints the exact variable and requirement and exits 1 — it does not
start half-working. Same note is now in `packages/pix3-collab-server/README.md`.

Two other behavioural changes worth announcing rather than discovering:

- **An editor can no longer create a share link.** The editor UI already gated this on
  `role === 'owner'`, so no shipped client loses a working control — but an API consumer doing it
  directly now gets 403.
- **Posting to `/share` twice no longer rotates the token.** Anything that relied on that for
  rotation must pass `{ rotate: true }`.

---

## 6. Recommendations

**Enabled here — keep them on.** `no-floating-promises` earned its keep immediately (it found M3),
and it is cheap now that typed linting is already paid for.

**Worth turning on next**, in rough order of value against noise:

| Rule | Why here specifically |
|---|---|
| `@typescript-eslint/no-unnecessary-condition` | Would have flagged the unreachable raw-body branches in L1. |
| `@typescript-eslint/require-await` | Several `async` operation closures never await; harmless but it masks the ones that should. |
| `no-empty` (currently disabled per-site with comments) | Nine of those disables were M4. With that gone, the rule is close to clean — worth turning on so the next one has to be argued for. |
| `@typescript-eslint/no-unsafe-argument` and friends | Only after the `unknown`-heavy property-schema `getValue`/`setValue` closures get a typed helper; today it would be hundreds of findings on a deliberate pattern. |

**Structural, not lint:**

1. **`npm run type-check` now covers `pix3-collab-server`** — it did not before, so server type
   errors were invisible to CI and to `npm run build`. Worth confirming CI runs the same script.
2. **The rate limiter is in-process.** Budgets are per-instance, which is honest for one node and
   wrong the day there are two. If the deployment ever scales out, this needs a shared store — the
   interface (`consume` / `retryAfterMs`) is already the right shape for it.
3. **Container stubs in specs are hand-rolled 28 times** and each one is a partial fake. A single
   `makeTestContainer()` helper would have made the M4 breakage a one-line fix instead of four, and
   would stop the next optional-dependency lookup from silently taking the "not registered" path.
4. **Consider a `catch`-shape rule of thumb**: a bare `catch {}` is only correct when the *only*
   thing in the `try` is the operation allowed to fail. Every instance found here wrapped more than
   that. The fix is usually to ask the question directly (`hasService`) rather than to catch.
5. **`packages/pix3-collab-server/data/*.sqlite` is tracked in git.** Running the server locally
   dirties the working tree with WAL and shm files. Not a defect, but it makes `git status` unusable
   as a "did I leave something behind?" check — worth `.gitignore`-ing and removing from the index.
