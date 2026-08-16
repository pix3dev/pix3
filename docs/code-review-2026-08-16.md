# Code review — 2026-08-16

Full-codebase review of the Pix3 editor, `@pix3/runtime` and `@pix3/collab-server`, run against
`main` @ `3a6f223`.

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

## 3. Proposed fix plan

Ordered by the task's rule (security → correctness → architecture → quality). One commit per group,
`type-check` + `lint` + `test` green after each.

| # | Commit | Contents | Risk |
|---|---|---|---|
| 1 | `fix(collab-server): fail fast on a default JWT secret` | H3. Startup guard + spec. | none — config only |
| 2 | `fix(collab-server): contain CRDT scene and script writes to the project directory` | C1. Shared path-containment helper + spec feeding `../`, absolute and drive-absolute paths. | low |
| 3 | `fix(collab-server): scope library item writes and deletes to their owner` | H1, H2. Ownership check before disk work; owner-filtered upsert; spec. | low |
| 4 | `fix(collab-server): throttle auth and preview-session creation` | H4, M2, M1 (dummy-hash compare). Shared sliding-window bucket lifted out of `rooms-router`. | low |
| 5 | `fix(collab-server): validate registration input` | M5, plus the `email` case-sensitivity mismatch. | low |
| 6 | `fix(runtime): stop AssetLoader raising unhandled rejections on failed loads` | M3 + spec. Should also quiet the known Vitest exit-code oddity. | low |
| 7 | `refactor(properties): share the viewport-transform sync and stop swallowing its errors` | M4. | low |
| 8 | `chore(lint): enable type-aware promise rules` | M7 + the 22 sites. Do this **after** 6–7 so the fixes are not lost in the noise. | medium — touches 20 files |
| 9 | `fix(collab-server): align share-token create/revoke roles` | M6. **Behavioural change** — confirm before I do it. | needs a decision |
| 10 | `chore: quality sweep` | L1, L2, L3, L6, L7. | low |

**Deliberately not doing** unless you ask: L4 (untangling cycles is a wide refactor for no concrete
defect), L8 (permitted by the current rule), and the knip "unused export" list (false positives from
`@customElement`).

**Needs your decision before I touch it:**

- **#9** changes who can mint a share link. Owner-only for both verbs is my recommendation, but it
  can break an existing workflow.
- Whether **#1** should hard-fail or only warn loudly. Hard-fail is correct, but it will take down a
  running deployment that is currently on the default secret — so it wants a coordinated env-var
  check first.
- Nothing in this list touches the `@pix3/runtime` public API or the scene format. Fix 6 is internal
  to `AssetLoader`; fix 2 changes only where the *server* puts bytes, not the YAML or the
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

_(filled in during stage 2)_
