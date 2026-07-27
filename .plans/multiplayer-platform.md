# Pix3 Multiplayer Platform — implementation plan

**Goal:** turn pix3 + WsCore into a "Roblox for the open web": build a scene in the browser → press Play Online → friend joins by link/QR from a phone → publish to a public gallery with hosted multiplayer rooms.

Status: Phase 0 complete, Phase 1 in progress · Date: 2026-07-26 (status refreshed 2026-07-27)
Basis: code recon of WsCore@main (server + client), pix3@7d580ad (collab-server auth, runtime, export/preview/library), plus a July-2026 market sweep. Load-bearing claims spot-verified against source. WsCore paths below are relative to the WsCore repo root; pix3 paths relative to this repo.

**Decisions taken since the first draft** (they override the original text where it disagrees):

1. **New repository, not a WsCore refactor** — `c:\Projects\pix3-stuff\pix3-rooms` (sibling of `pix3`), .NET 10. WsCore stays untouched as a parts donor (socket layer patterns, `[TypeId][payload]` framing, MemoryPack reader/writer, deploy scripts) and as a living experiment. Reasons: Phase 0 discards more of WsCore than it keeps (its whole `Game/` tree, JSON fallback, demo client); the product identity is a pix3 component (`rooms.pix3.dev`); and WsCore has **no LICENSE file**, so the new repo gets a deliberate license choice instead of inheriting ambiguity.
2. **Stack stays .NET** for the fabric and the hot replication path. The all-TypeScript option was seriously considered (one language everywhere, no C#→TS codegen, Node needed for Level 3 anyway) but the 600-player requirement below makes the hot loop the soul of the product, and C# gives zero-allocation idioms, predictable tail latency and in-process multicore for free. Node enters only at Phase 4, as the Level-3 sandbox sidecar, off the hot path.
3. **600 concurrent players in ONE room, 2D top-down shooter, no lag** is the flagship requirement (see Appendix D for the budget math). Consequences, folded into the phases below: AOI + delta + encode-once move from Phase 5 into the Phase 0/1 core; hot entities live in SoA arrays, never in a node graph; own-player prediction and shot lag-compensation move into Phases 1–2; Level-3 user scripts handle rules and events, never the fan-out loop.
4. **Transport ladder: WSS now, WebTransport next.** WSS is TCP, so packet loss causes head-of-line spikes a shooter feels. WebTransport (QUIC datagrams) now covers ~88% of browsers — Chrome 97+, Firefox 114+, **Safari 26.4+ including iOS** — so the transport is an interface from day one, WSS ships first, WebTransport is a Phase-3/5 upgrade behind the same seam.
5. **`isolated-vm` is in maintenance mode, Node-only, with soft memory caps** (its own README recommends Chromium-style *process* isolation). So the Level-3 boundary is primarily OS process isolation + cgroups; an isolate is an optional inner layer, not the security story.
6. **User-generated content gets its own registrable domain — a Phase-2 blocker** (from external review). Published games are attacker-controlled HTML/JS; serving them from a *subdomain* of `pix3.dev` would let any game set cookies with `Domain=.pix3.dev` (cookie tossing) and phish inside the trusted brand. Precedent is unanimous: itch.io serves user content from `itch.zone`/`hwcdn.net` with a per-project subdomain, Google from `usercontent.google.com`, GitHub from `githubusercontent.com`. So: a separate eTLD+1 for the game bundles, one subdomain per game (so games can't reach each other's `localStorage`/IndexedDB), plus CSP and a `sandbox`ed iframe as defence in depth. Note the gallery and game pages do **not** move — they are our own trusted chrome; only the bundle's iframe is foreign, exactly as itch.io serves its project pages from `itch.io` and the playable from `itch.zone`.

Concrete origin map: `pix3.dev` landing (apex), `editor.pix3.dev` editor (already live — GitHub Pages under a custom domain via `public/CNAME`, so the browser-visible origin is same-*site* with the API and `SameSite=None` is vestigial), `cloud.pix3.dev` API/identity/games registry, `rooms.pix3.dev` fabric, `play.pix3.dev` gallery + game pages, and `<gameId>.<sandbox-domain>` for bundles under a wildcard certificate, carrying no credentials ever and `CSP: frame-ancestors play.pix3.dev`. The sandbox domain should be a **dedicated throwaway registration** (~$10/yr): content domains get blocklisted by Safe Browsing the first time someone publishes something abusive, which is why every platform makes them brand-free and disposable (`itch.zone`, `githubusercontent.com`, `usercontent.google.com`). Available today: `gritsenko.biz` works as the **development-time** sandbox origin (already a separate eTLD+1, and URL migration is painless before links are public); `pix2d.com` must **not** be used — it carries an existing product's audience that a single malicious upload would burn, and it is worth more as a cross-promotion channel. Submit the sandbox domain to the **Public Suffix List** as well, so browsers also block game→game cookie tossing (the mechanism behind `github.io`); PSL review takes weeks, so file it early. **And a today-problem the review surfaced indirectly:** `pix3-collab-server` currently runs `cors({origin: true, credentials: true})` while the production cookie is `sameSite:'none'` — any third-party site can already make credentialed requests to `cloud.pix3.dev` and read the responses as the logged-in user. Fix it *before* Phase 2, independently of the domain split, in this order so nothing breaks: (1) pin `cors({origin: …})` to an allowlist (`editor.pix3.dev`, later `play.pix3.dev`, plus `localhost:8123` for dev) — one line, and it removes the bulk of the risk since a disallowed origin can neither read responses nor pass preflight for JSON writes; (2) add `Authorization: Bearer` support to the REST middleware, which today reads `req.cookies.token` only — needed anyway for a local editor against the production API and for service-to-service calls from the fabric; (3) only then set the cookie to `SameSite=Lax`, because the local-editor-against-production workflow is genuinely cross-site and would otherwise lose its cookie. Also verify GitHub Pages redirects the default `*.github.io` URL to the custom domain, so no second editor origin lingers.
7. **Host model at Level 1: migration, not hope** (from external review). `net.isHost` was defined without saying what happens when the host leaves — fatal for "Play with friends" on a published game, where the room creator is a guest on a phone who backgrounds the browser. Fix in two parts: (a) entities carry an ownership policy (`owned` vs `shared/transferable`) *now* — two flag bits, no wire break later — because today's `RemoveOwner` would simply despawn the host's pickups on exit; (b) the fabric promotes the longest-present member, emits `HostChangedEvent`, and reassigns shared entities instead of destroying them. Public gallery rooms should still graduate to server-owned state (Level 2) — that is a Phase-3 goal, not a Phase-2 blocker.
8. **Level-3 workers load the runtime from the game's own bundle** (from external review). The export already compiles `@pix3/runtime` from source *into* the bundle, so a worker booting the published bundle has client and server semantics identical by construction, and the runtime sits inside the sandbox — where untrusted user code already runs, so the isolation boundary is unaffected. What needs versioning is not the runtime but the narrow worker-host ↔ bundle bridge.
9. **The 600-player room is an explicit demo milestone, not an invisible estimate driver** (from external review, which correctly caught the plan arguing with itself). Its *architectural* consequences stay in the core because they are only cheap up front (SoA state, room-scoped fan-out, encode-once, AOI). Its *gameplay* consequences do not belong in Phase 1: at Level 1 a client owns and locally simulates its own avatar, so there is zero self-latency by construction and no server hit detection to rewind — prediction, reconciliation and lag compensation are Level-2 mechanics and move to Phase 3.

---

## 1. Market snapshot (July 2026) — why now, and what it dictates

Condensed from the research sweep (sources in Appendix C):

- **The niche is genuinely empty.** Web portals (Poki 100M MAU 50/50 split, CrazyGames, itch.io 10% default) have audience + gallery but *refuse to host game servers* — CrazyGames FAQ says verbatim "we only host the game files. For multiplayer servers, you'll need your own solution". Room hosts (Colyseus $15+/mo per instance, Photon $125/mo @ 500 CCU, Nakama/Heroic) host servers but assume a trusted studio process — no multi-tenant sandbox for user code, no gallery, no revshare. AI makers (Astrocade $56M/20M users, Rosebud 2.3M games, Upit) have prompt + gallery but graft multiplayer on via templates/BaaS. **Nobody has: real editor + first-class rooms + user-authored server code in a sandbox + link-share + gallery, on the open web.**
- **Per-room game compute is a feature, not a company.** Hathora was acquired by Fireworks AI and shut down (May 2026); Rivet pivoted to AI-agent infra. Lesson: build rooms as a feature of the pix3 platform, monetize the platform — don't build "a game server hosting business".
- **The cost floor makes a free tier viable.** Cloudflare Workers-for-Platforms economics (~$0.02/mo marginal per tenant script, 128 MB isolates, CPU-ms billing) is the benchmark shape for sandboxed per-game server logic — *not* Photon's $0.50/CCU. A single VDS covers the dev tier for a long time.
- **Closest product precedent: Rune** — one `logic.js` runs on every client *and* on their servers (deterministic, language-subset sandbox, <25 MB, free hosting, 10M+ installs). Closest infra precedent: **Screeps** — a decade of untrusted user JS server-side in `isolated-vm` V8 isolates (~256 MB heap cap, hard CPU-per-tick kill). Roblox Luau sandboxing is by subtraction + interrupt callback (no memory guarantee — the host enforces).
- **Roblox is the reference and the clock.** Q1 2026: 132M DAU (down from 152M peak on age-check friction), FY2025 DevEx $1.5B (+63%), DevEx rate raised to 37.8% for verified 18+. Their prompt-to-playable "**Build**" alpha starts rolling out **July 28, 2026**. Differentiate on: open web (no install, a game is a URL), a real editor with code ownership/export, and revshare economics Roblox can't offer — not on feature parity.

**Product implications baked into this plan:** guest-first play (no account to join), template-first onboarding, mobile browser as first-class target, moderation planned before wide launch (teen audience), pricing anchored to room-minutes not CCU.

---

## 2. Inventory — what exists vs what's missing

| Area | Have | Headline gaps |
|---|---|---|
| **WsCore server** (.NET 10) | WS handling with per-conn bounded send queues; 30 Hz global tick; reflection-based request routing; MemoryPack `[TypeId:1][payload]` protocol; RoomManager (membership); input sanitizer, cooldowns; Docker+nginx+certbot deploy, CI; owner's `.plans` (audit done; vision = dynamic rooms + generic object protocol) | **One global `GameModel` for all rooms** — rooms are membership-only, simulation is process-global; broadcast is global (room-scoped variants are dead code); **no AOI** (README claims it falsely); **no auth at all**; no REST room API; no TTL/eviction (all 3 rooms hardcoded persistent); no per-room budgets; no metrics; no protocol versioning; shooter logic hardcoded (bots spawn on construction, map handlers mutate block (0,0) ignoring coords, `RoomCompatibility` flags bug 0/1/2/3) |
| **WsCore client** (TS) | `WsConnection` transport (reconnect + jittered backoff), MemoryPack Reader/Writer (near-verbatim reusable), Emitter, golden-vector protocol tests | No request/response or acks; no heartbeat/RTT/clock sync; no session resume; no version handshake; TypeId enums hand-mirrored (docs already drifted); demo has zero prediction and frame-rate-dependent lerp |
| **pix3 auth/backend** (collab-server) | Accounts + HS256 JWT (single sign/verify choke point `auth-middleware.ts:27-33`); project storage (sqlite + Yjs + files); share tokens; preview sessions with per-role tokens; **library/store router = ready-made template for a games registry**; prod deploy on cloud.pix3.dev | JWT has no `aud`/`iss`, `verifyToken` has no algorithms allowlist; cookie-only REST (no Bearer); no token-mint endpoint; no games/rooms tables; no revocation; `cors({origin:true})`; no rate limit on register/login |
| **@pix3/runtime** | Stable authored node IDs across clients (YAML; play-mode clone preserves them); single signal dispatch point (`NodeBase.emit`); JSON-serializable property schema (can double as replication schema); `applyLivePropertyUpdate` = existing "apply one replicated property" primitive; ECS fixed-step + interpolation alpha already plumbed; `Collision2DService` pure-math/headless-safe; core is DOM-free (NodeBase/components/signals/GameTime) | **Zero networking code**; no server/client authority dimension; no fixed-step for scripts; signals not serialized; **spawned prefab children collide on ID** (`SceneLoader.ts:426` fresh Map — root `instanceId` injection point exists); no snapshot-buffer interpolator; ~6 DOM touch points block headless (renderer, rAF, InputService, SceneService overlays, Audio, Label2D canvas); **autoloads never run in SceneRunner/exports** — "network session as autoload" doesn't work; `pause()` stops rAF entirely (backgrounded player goes silent) |
| **Editor play/publish** | Remote-preview relay (roles, tokens, JSON+binary frames, cached late-joiner state, acks), QR/link card UI, telemetry back-channel; deterministic export (single HTML / zip, minified, reachability report); template system that pre-wires scenes+scripts; library/store upload+validation+grid UI patterns | Export ends at `showSaveFilePicker` — no upload path; no game metadata model (title/thumbnail/OG); relay is star-topology with one privileged host, no player↔player fanout; preview player streams files from a *live editor* — can't run standalone; templates can't ship `pix3project.yaml` (manifest synthesized from `template.yaml`) |

Full pointers: Appendix A (WsCore fixes) and B (runtime gap map).

---

## 3. Architecture decisions

**D1. `pix3-rooms` = the Room Fabric (gateway), not the game.**
A new .NET 10 repo (`pix3-stuff/pix3-rooms`). Responsibilities: WebSocket termination, MemoryPack framing, handshake + JWT validation, room registry/lifecycle + REST admin API, quotas/rate limits/metrics, membership + room-scoped fan-out **with AOI**, and the generic entity state table for Levels 1–2. It never learns pix3 scene semantics (nodes, components) — an entity is `(netId, owner, kind, transform, flags, cold props)`. Rationale: this is what .NET is genuinely good at (socket fan-out, serialization, zero-alloc hot loops), and it gives a stable seam in front of whatever runs game logic. WsCore contributes patterns, not code ownership.

**D2. Server-logic ladder — Level 3 is "same engine on the server", not Jint.**
- **L1 — generic state sync (C#, client-authoritative):** room state = `netId → property blob`; server validates envelopes/quotas only, relays deltas. "Multiplayer за вечер" for prototypes and casual co-play.
- **L2 — data-driven rules (C# modules, config-enabled):** server-owned room variables, movement validation (speed/bounds/teleport rejection), match phases/timers, score, pickups/respawn. No user code on the server.
- **L3 — user server scripts = headless @pix3/runtime in sandboxed Node workers.** Recon changed the original Jint idea: the runtime is *narrowly* blocked from headless (≈6 stub points, §7 of runtime recon), and running the actual engine server-side gives Roblox's Script/LocalScript semantics literally — same language, same scene tree, same components, shared constants between client and server. Jint would instead force re-implementing scene semantics in C# or shipping a crippled "limited API" scripting surface that becomes legacy the day L3b lands. Precedents: Screeps (isolated-vm, 10 years in production), Rune (same logic client+server). **Jint remains the documented fallback** if Node-worker ops prove too heavy.
- Topology for L3: WsCore gateway ⇄ room worker (Node child process, `isolated-vm`: heap cap 128–256 MB, CPU budget per tick with interrupt, wall-clock kill) over a local length-prefixed pipe/socket. Workers receive validated decoded input events, emit state deltas + events. Worker crash → room reset, sockets survive at the gateway.

**D3. Protocol: keep MemoryPack envelope, add a handshake, automate codegen.**
- New mandatory `Hello{protocolVersion, token, roomId, buildId}` → `Welcome{clientId, roomState…}` before any other message; version mismatch → clean typed error → editor/player shows "update required" (no silent decoder garbage).
- Single documented TypeId allocation map (today requests/events overlap ids across two registries — keep byte, allocate ranges: 0–63 core/handshake, 64–127 state sync, 128–191 remote events/RPC, 192–255 app).
- Generic message set is game-agnostic (Join/Leave, StateSnapshot, StateDelta, SpawnEntity/DespawnEntity, RemoteEvent, InputCommand, Ping/Pong+clock), so codegen churn is low. User property payloads: **v0 = JSON bytes inside the binary envelope** (debuggable, ships fast), v1 = schema-packed binary generated from `PropertyDefinition` metadata.
- ~~Codegen: re-enable the MemoryPack TS generator in CI, publish output as **`@pix3/net-protocol`**.~~ **Superseded (2026-07-27).** MemoryPack's TypeScript generator has an open nullable-float correctness bug, so the codecs are hand-written instead, and with codegen gone the case for a separate npm package went with it: every TypeScript speaker of this protocol is a runtime instance (LoadGen is C#, collab-server talks REST, Level-3 workers load the runtime from the game's own bundle), while a second published package would duplicate the exporter glob, three path-alias files, the import map, the yalc hop and a CI publish lane for no consumer. The codec lives at `packages/pix3-runtime/src/net/protocol/`, imports nothing from `three` or the node tree so it stays extractable, and is **not** re-exported from the package index — the wire format is internal, so it can change without a breaking-change semver event. Version skew is handled where it belongs, in the `Hello`/`Welcome` handshake. The contract check is `pix3-rooms/docs/protocol-vectors.json`: byte-exact vectors hand-derived from the spec, verified against the C# codec by `GoldenVectorFileTests.cs` and against the TypeScript codec by `protocol.spec.ts` reading a byte-identical copy.

**D4. Auth: pix3-cloud is the identity provider; guest-first.**
- collab-server gains `POST /api/games/:projectId/rooms` → calls WsCore admin REST (service token) to create the room → returns `{wsUrl, roomId, roomToken}`. `roomToken` = JWT `{aud:'pix3-rooms', iss:'pix3-cloud', sub:userId|'guest:<uuid>', roomId, role, exp:~15m}` — signed by the same choke point (`auth-middleware.ts:27`), validated by WsCore at Hello.
- Prerequisite hardening (tiny, do first): `algorithms:['HS256']` allowlist in `verifyToken`, `aud`/`iss` on all tokens. Later: ES256 + JWKS so WsCore holds only a public key and can't mint editor tokens (shared-secret blast radius flagged in recon).
- **Guests never register**: the play page mints an anonymous guest room token. Roblox lesson — join friction kills the loop.

**D5. Network session ≠ scene.**
`NetworkService` is owned at the SceneRunner-host level (constructed at the three bootstraps: `packages/pix3-runtime/src/main.ts`, `GamePlaySessionService`, `player-main.ts`), exposed to scripts via the existing lazy-getter pattern (`SceneService.get network`, mirroring `get collision2d`). It survives `changeScene`. Do **not** build it on autoloads (verified: autoloads exist only as a manifest type in the runtime — nothing executes them in SceneRunner or exports). The network pump (send/receive/heartbeat) runs on its own interval, decoupled from rAF — `pause()` cancels rAF entirely, and a backgrounded phone must not drop from the room; resume = snapshot catch-up.

**D6. Network identity: a node has no intrinsic netId — it binds to a server-minted entity.** (Rewritten 2026-07-27; the original text is not expressible on the shipped wire.)

The first draft said authored nodes carry `netId = authored nodeId` and runtime spawns carry `netId = n:<ownerClientId>:<seq>`. Protocol v2 permits neither: `netId` is an opaque `uint` (`slot | generation << 16`) **minted by the fabric**, an entity comes into being only through `SpawnEntityRequest` → `SpawnEntityResponse{NetId}`, and `FullRecord` is a hand-packed fixed 20 bytes with nowhere to put a string. Any layout change is a version bump, so no string will ever ride the hot plane.

So: **everything networked is spawned.** A node becomes networked by binding to an entity.

- **My own avatar** — `core:NetworkedNode` sends `SpawnEntityRequest{Kind}`; the response's `NetId` is what it binds and then publishes.
- **Another player's avatar** — a `FullRecord` enter arrives, its `Kind` indexes the manifest table to a prefab path, and the client instantiates and binds it.
- **An authored shared prop** — deferred past Phase 1. Authored scenery stays purely local, identical on every client because it comes from the same scene file; shared L1 state that needs a door or a score uses room vars keyed by authored node id, plus signals. Phase 3 already makes pickups and score server-owned *spawned* entities, so this converges rather than accumulating debt.

`Kind` is a `u16` index into `netKindTable`, a new const emitted by `buildSceneManifestTs`, in two segments: spawnable prefab paths first, and later an authored-binding segment naming scene node ids for the Phase-3 mechanism. The exporter owns the table and it is versioned with `buildId`; the room's kind allowlist is its index set (an empty allowlist stays dev-allow-any).

Determinism comes free from this shape: each client spawns only what it owns and the server mints the ids, so duplicates are impossible by construction — which the host-claims alternative could not guarantee, since AOI hides entities from the very host that would have to check whether a prop already exists.

Two parts of the original text survive and were re-verified. Spawned **children** are addressed as `(rootNetId, childPath)`, never global `findById`, because prefab child ids collide across spawns (fresh Map at `SceneLoader.ts:426`); and passing `instanceId = "net:<netId>"` through `SceneLoader.instantiatePrefab` (`SceneLoader.ts:418-430`) makes every client derive identical child ids for the same entity.

One thing to watch: cold props are fanned out only at change time, never replayed into a snapshot, so a late joiner never sees them — identity must live in `Kind`, never in `Props`. Replaying stored props when an entity enters a client's known set is an additive fix (new frames of an existing type) if it is ever needed.

**D7. Publish/gallery clones the library-store pattern 1:1.**
`games` table + `GAMES_STORAGE_DIR` + `games-router` copied from `store-router` shape (public `attachOptionalAuth` reads, owner-authed multipart bundle upload, `resolveSafePath` file serving, draft/unlisted/published pipeline, featured, downloads counter, audit log) — but owner-writable instead of admin-only. Play URLs: `play.pix3.dev/<slug>`; game page adds OG meta + thumbnail (both currently absent from the exported HTML shell).

**D8. Interest management is core, from the first commit.** (Reversed from the original draft, which deferred it to Phase 5.)
At 600 players, broadcast-all is ~4.3 Gbit/s per room — not an optimization gap, an impossibility. A uniform spatial hash gives each client the ~30–50 entities near it, and **encode-once/memcpy-many** keeps CPU flat: a dirty entity is serialized once per tick, per-client frames are assembled by copying byte ranges. Entity state is structure-of-arrays with zero allocation on the tick path. Rooms ship with a conservative player cap (~200) and raise it as p99 tick time and bandwidth telemetry earn it — the architecture targets 600, the launch config doesn't have to.

### Target architecture

```mermaid
flowchart LR
  subgraph Creator
    ED[pix3 editor<br/>GitHub Pages]
  end
  subgraph Player
    PP[play page / player.html<br/>published build]
  end
  subgraph cloud.pix3.dev
    CS[collab-server<br/>identity, projects, games registry,<br/>room-token mint, gallery API]
    ST[(sqlite + GAMES_STORAGE_DIR<br/>static builds via nginx)]
  end
  subgraph rooms.pix3.dev
    GW[WsCore Room Fabric<br/>WS + MemoryPack, JWT verify,<br/>rooms, quotas, L1/L2 state, metrics]
    W1[[room worker (L3)<br/>Node isolated-vm,<br/>headless @pix3/runtime]]
  end
  ED -- JWT cookie --> CS
  ED -- "Play Online: create room" --> CS
  CS -- service token: create/close room --> GW
  CS --> ST
  ED -- ws + roomToken --> GW
  PP -- ws + guest roomToken --> GW
  PP -- fetch build --> ST
  GW <-- local pipe: inputs/deltas --> W1
```

---

## 4. Runtime client API sketch (what game scripts see)

```ts
// inside a Script component
const net = this.scene!.network;        // lazy getter, offline-safe no-op impl when not connected
net.isOnline; net.clientId; net.isHost; // L1: host = room creator
net.rtt; net.clockOffset;

// replicated state (L1): components do the work, scripts mostly don't touch this
// core:NetworkedNode  — netId, owner, which schema props replicate (additive `replicated` flag on PropertyDefinition)
// core:ReplicatedTransform — send 10–20 Hz on-change; receive via 100 ms snapshot buffer + timed interpolation
//                            (must cooperate with anchored-2D reflow and camera damping — flagged in recon)

await net.spawn('res://prefabs/Bomb.pix3scene', { owner: 'me', parent }); // netId minted per D6
net.despawn(netId);

net.on('round-started', (payload, from) => { ... });   // RemoteEvent: fabric-routed
net.emit('place-bomb', { x, y }, { to: 'server' });    // L3; L1 routes to peers/host

net.vars.get('matchPhase');            // L2+: server-owned room variables, server-write-only
```

Editor surface: `networkMode: 'server' | 'client' | 'shared'` static on `Script` subclasses + a field on `ComponentTypeInfo` so the Add-Component picker and inspector show authority badges; `SceneLoader` gates component activation by mode at the existing `component.enabled` seam.

---

## 5. Phased roadmap

Estimates are focused solo-with-agents weeks; each phase ends in a demo that stands alone.

### Phase 0 — Room Fabric foundations (`pix3-rooms` + auth) · ~2–3 wk
The unglamorous prerequisite for everything. Greenfield in the new repo, with WsCore open beside it as reference:
1. **Solution + contract first**: `Pix3.Rooms.Protocol` (MemoryPack control messages, hand-packed hot codecs, TypeId ranges, version const, reject codes) and `docs/protocol.md` + `docs/architecture.md` as the binding spec. Socket layer ported *in spirit* from `WsServer/WsServer/WebSocketHandler.cs` (frame reassembly, bounded per-connection channel + send loop, error cutoff); explicitly not ported: the global `GameModel`, global broadcast, the JSON text-frame fallback, `[Flags]` 0/1/2/3, `CreateRoom` ignoring `TryAdd`.
2. **Per-room state + scoping**: each room owns its entity table, its inbound queue and its own tick loop with a stopwatch budget (not WsCore's single global loop — one heavy room must not stall another); all chat and state fan-out is room-scoped by construction, and a permanent two-room cross-talk test guards it.
3. **Room lifecycle**: REST admin API (`POST/DELETE/GET /admin/rooms`, service-token auth) with `{roomId, projectId, buildId, maxPlayers, ttl, mode, rulesConfig}`; TTL sweeper (empty → destroy after N min); rooms non-persistent by default.
4. **Handshake + auth**: mandatory `Hello` (D3) before anything; HS256 JWT validation with `aud:'pix3-rooms'`.
5. **Quotas v0**: connections/IP, msg/s/conn (token bucket), payload cap (lower 64 KB → 16 KB), join throttle, ping/pong idle timeout, rooms/user, players/room. Typed disconnect codes.
6. **Observability**: `/metrics` (Prometheus) — rooms, players, msg rates, tick duration percentiles, send-queue drops, per-room budget overruns.

collab-server work: `verifyToken` algorithms allowlist + `aud`/`iss`; room-token mint endpoint (D4); rate-limit register/login; pin CORS origins.

**Acceptance:** two projects' rooms fully isolated (state, chat, broadcast); soak test (N rooms × M bot connections) with flat memory; handshake without valid token rejected; quota breach → typed disconnect. Protocol version bump forces a clean client error.

### Phase 1 — Level-1 sync + "Play Online" · ~3–4 wk — **the killer demo**
1. ~~**`@pix3/net-protocol`**~~ — **done 2026-07-27** as `packages/pix3-runtime/src/net/protocol/` (see the revised D3): hand-written `MemoryPackReader`/`MemoryPackWriter`, the hot-plane codec, `WorldQuantizer`, TypeId and enum tables, the version constants, and 129 vitest cases driven off the shared golden-vector file.
2. **Runtime network module** (`packages/pix3-runtime/src/net/`): `WsTransport` from `WsConnection` (add: attempt cap, heartbeat, RTT + clock offset; keep: no-queue-while-closed policy, backoff); `NetworkService` (join/leave, entity registry, interval pump per D5); `SceneService.get network` + wiring at the three bootstraps.
3. **Components** — **done 2026-07-28** for the two transform-plane pieces: `core:NetworkedNode` and `core:ReplicatedTransform` (snapshot buffer + timed interpolation at ~2 tick intervals + measured jitter; `Teleport` snaps), with `core/NetworkNodeBinder` as the entity↔node seam (`scene.netNodes`) and the owner rendering from its own dequantized values. Signals already reach scripts through `net.on/emit`; the *forwarding component* that re-emits a signal as a node signal is the remaining piece of this step.
3b. **Feel, at Level-1 cost.** Remote entities render on an adaptive interpolation delay (~2 tick intervals plus measured jitter, Valve's `cl_interp_ratio 2` rule), and the `Teleport` wire flag snaps instead of lerping on discontinuities. That is *all* Phase 1 needs: the local avatar is client-owned and simulated locally, so it has no input latency to predict away. Prediction/reconciliation and server-side lag compensation arrive with Phase 3, when the server starts owning movement — see decision 9.
3c. **Host migration** (decision 7): shared-entity ownership policy in the entity model, `HostChangedEvent`, promotion of the longest-present member with reassignment (not destruction) of the departing host's shared entities. ~1–2 days, and without it every second public session dies when its creator backgrounds their phone.
4. **Spawn/despawn** per D6 — **done 2026-07-28**, together with step 3 as planned: `netKindTable` (spawnable-prefab segment, code-point sorted, `authored` reserved) emitted by `buildSceneManifestTs` and installed at the runtime bootstrap, `NetworkService.spawn/despawn` with quantized spawn fields, correlated `RequestId`s, the 240/min and 64-per-owner quotas held locally, distinct failures for `QuotaExceeded` / `EntityLimitReached` / `KindNotAllowed`, and no pending promise left unsettled when the socket drops; a remote leave → `queueFree()`.
5. **Editor UX**: "Play Online" button + session card in the Game tab (clone the remote-preview card: QR, copy link, player list, ping). **v0 joiner path reuses the preview relay for asset streaming** (join link = `player.html` preview session + room token; the preview relay streams `res://` files from the editor as today, the Room Fabric carries game state). Two sockets, zero new hosting — publish removes this dependency in Phase 2.
6. **Template**: `multiplayer-arena-2d` starter (8-player tag/arena: pre-wired player prefab with NetworkedNode+ReplicatedTransform, spawn points, name labels, chat). Per the Roblox lesson: one polished playable template > generic netcode demo.

**Acceptance/demo:** open template → Play Online → QR → phone joins as guest → players see each other move with clean interpolation; phone backgrounded 10 s → returns, catches up; editor closes → room dies by TTL. This is the pitch demo.

### Phase 2 — Publish + gallery ("pix3 Play", the itch-слой) · ~3–4 wk
0. **Blocker, do first — origin isolation** (decision 6): stand up the separate content domain with per-game subdomains, pin the collab-server CORS allowlist, narrow the auth cookie, add CSP + iframe sandboxing. The URL scheme must be right *before* the gallery launches; migrating play URLs afterwards is painful and breaks every shared link.
0b. **Drop-in matchmaking — `join-or-create`** (from external review): the public Play button must land a player in a *live* room, which is what "io" means. A public endpoint (not the service-token admin API) asks the fabric for a non-full public room of that game or creates one, with a fill policy (fill to N, then a new room, keep one warm); collab-server mints the guest token. Small on the fabric side — it already tracks rooms and occupancy — and it is the difference between a gallery and a game list.
1. **Games registry**: `games` table + `games-router` per D7; publish validation gate (title, description, thumbnail, orientation, tags, visibility, `remixable` flag) mirroring `store-validation.ts`.
2. **Publish flow**: `ExportPlayableZip` path gains "Publish to pix3 Play" — multipart upload with progress (clone `StoreUploadService`), versioned builds (`buildId`), rollback; thumbnail capture via the existing scene-thumbnail/viewport-screenshot paths.
3. **Play page**: `play.pix3.dev/<slug>` — nginx-served static build + game page (title/author/thumbnail/OG meta — all currently missing from the export shell) + Play button + **"Play with friends"** = mint guest token + create room against the *published build* (no editor host; assets come from the build — the Phase-1 preview-relay crutch retires).
4. **Gallery**: public static SPA (new/featured/most-played, fetch JSON from `games-router`); "My games" panel in the editor reusing the library grid.
5. **Remix v0**: "Open in editor" on remixable games → server-side clone of the cloud project → editor opens the copy. (This is the Roblox remix-culture loop; needs game→project link.)
6. **Moderation minimum**: report button, draft/unlisted/published defaulting to unlisted, admin takedown + audit (pattern exists), contact/DMCA page.

**Acceptance:** publish → link opens in incognito and on a phone; multiplayer works on a published game with zero editor involvement; play counters recorded; a reported game can be taken down.

### Phase 3 — Level-2 server rules (config modules) · ~2–3 wk, parallelizable with Phase 2
1. Server-owned **room variables** with write-ACL (`net.vars`), replicated to all.
2. **Movement validation** module: max speed/accel, world bounds, teleport rejection — config authored in editor project settings, exported as `netconfig` in the build manifest, passed to the room at create.
3. **Match flow** module: lobby → round → results phases, timers; **score/leaderboard**; **pickups/respawn** (server-owned entities; server grants pickups).
4. Optional: simple server-side 2D collision — port `Collision2DService`'s overlap math (pure functions: point/circle/rect/raycast) to C# against exported hitbox data; document the divergence risk, keep scope minimal.

5. **Prediction, reconciliation, lag compensation** (deferred here from Phase 1 by decision 9 — they only become meaningful once the server owns movement): local input applies immediately and a reconciliation buffer replays unacknowledged inputs against server corrections; a short per-room rewind buffer of entity positions resolves hits at the shooter's view of the world.
6. **Public rooms graduate to server-owned state**: a published game's public rooms run in Authoritative mode so no player is load-bearing (host migration from Phase 1 remains the fallback and the friends-only path).

**Acceptance:** a speed-hacked client is visibly corrected; the arena template upgraded to server-scored; a room with rules config denies illegal state writes; a public room survives every original member leaving.

### Phase 4 — Level-3: user server scripts, same engine · ~6–8 wk — **the moat**
1. **Headless runtime**: `SceneRunner` options `{render:false, clock, scheduler}` (or a `HeadlessSceneRunner`) + null `RuntimeRenderer`/`AudioService`, synthetic `InputService`, DOM-stubbed `SceneService` overlays, Label2D skips canvas rasterization; Node asset backend for `ResourceManager` reading from `GAMES_STORAGE_DIR`. (The core — NodeBase, components, signals, GameTime, ECS, Collision2D — is already DOM-free.)
2. **Room worker host** (Node): one `isolated-vm` isolate per room — heap cap, CPU budget per tick with interrupt callback, wall-clock kill (Screeps model); boots the published build's scenes + `networkMode:'server'` scripts; **no fs/net API inside the isolate** except the fabric channel.
3. **Authority model in the editor**: `networkMode` on Script (D2/D6), inspector badges, `SceneLoader` activation gate; RemoteEvents routed client⇄server through the fabric; server spawn authority; fixed-step server tick for scripts (new — today only ECS has fixed-step).
4. **Gateway⇄worker protocol** + crash isolation/restart; per-room server logs streamed to the creator's Logs panel (client-side error surfacing already exists — add the server channel); Screeps-style CPU/memory meter in the editor.
5. **Local dev loop**: the headless runner is DOM-free, so it can run in a **Web Worker inside the editor** for instant server-script iteration (true dedicated behavior in the cloud). This keeps "press Play, both sides run locally" iteration speed.

**Acceptance:** the arena template's rules move from L2 config into a user server Script; a modified cheat client can't teleport or grant score; an infinite-loop server script is killed at budget without affecting other rooms; server `console.log` appears in the editor Logs panel.

### Phase 5 — Scale & platform · ongoing
Wire compression beyond v1 (position quantization, bit-packed masks, schema-packed cold props), WebTransport as the primary transport, multi-node fabric (room registry → node assignment, regions); billing/tiers; creator analytics (plays, retention, CCU graphs); voice rooms (the WsCore voice plan + coturn) as the social layer; 2 more genre templates (race, tycoon-lite); agent/simplified-mode integration (agents that scaffold multiplayer from prompts — the in-editor agent already has 34 tools; add network-aware ones).

---

## 6. Monetization sketch

Anchors: Photon = $125/mo @ 500 CCU (hard-capped tiers); Colyseus = $15+/mo per instance; Multisynq free tier = 10k session-minutes/mo; W4P marginal cost ≈ $0.02/tenant script.

- **Free / dev**: Play Online rooms with TTL, ≤8 players, small concurrent-room quota, L3 CPU budget small. Costs rounding-error on one VDS.
- **Free / published**: on-demand rooms, sleep-on-empty, monthly **player-minutes** pool per creator. (Refined after external review pointed out that room-minutes mis-price an 8-player room against a 200-player one. Appendix D gives the better metric for free: because AOI plus the per-client byte cap fixes each client at ~45 kbit/s regardless of room population, egress is essentially linear in player-minutes — so one metric tracks the real cost driver without a separate traffic meter.)
- **Creator Pro (~$10–15/mo)**: warm rooms, bigger budgets/room caps, analytics, more published games, priority builds.
- **Studio/Team**: custom quotas, regions, SLA; later self-host licensing (the WsCore docker story finally lands here — for advanced users by choice, never as the entry barrier).
- Revshare on game monetization (ads SDK integration / donations) is a Phase-5+ platform play; the near-term "path to first dollar" for creators = one-click web-portal ad SDK + donate link on the game page.

## 7. MY.GAMES pitch alignment

- **Phase 1 exit = the wow demo** ("собрал сцену → QR → бегаем вдвоём с телефонов") — demonstrable solo, before any platform investment.
- **Phase 2 exit = the platform story** (gallery, publish, remix) — this is the UGC-опцион slide.
- The **playable-ads angle is untouched** by this plan and remains the ROI opener; multiplayer is the strategic second act.
- Settle the **IP/employment question before the pitch** (both repos personal; short legal consult > мутная зона later).

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Roblox "Build" (July 28) sucks the air out of "AI builds games" | Position on open web + real editor + ownership + export; ship the link/QR co-play demo, which Build can't match on the open web |
| Two-runtime ops (.NET + Node) | Node enters only at Phase 4; Phases 0–3 are .NET-only; documented Jint fallback if worker ops prove too heavy |
| Sandbox escape / abuse | isolated-vm, no ambient APIs in the isolate, CPU interrupt + heap cap + wall-clock kill, per-room quotas at the gateway regardless of worker behavior |
| MemoryPack positional brittleness | Version handshake (D3), additive-only schema policy, golden-vector tests, generated (not hand-mirrored) TypeId enums |
| Moderation & minors (teen audience) | Unlisted-by-default, report/takedown in Phase 2, chat filters before wide launch, raise proactively in the pitch |
| Single-VDS SPOF | Acceptable for dev tier; SLA only when a paid tier exists; fabric is stateless-ish (rooms ephemeral), so restart pain is bounded |
| Shared JWT secret widens blast radius | Move to ES256 + JWKS after Phase 1 so the fabric can't mint identity tokens |

## 9. Open questions

1. Gallery frontend: static SPA in this repo vs separate small site repo.
2. Guest identity persistence (localStorage guest UUID) for play stats/reconnect.
3. Server tick rate for L3 rooms: fixed 20 Hz vs per-room config.
4. Published-build storage: local disk + nginx now; object storage/CDN threshold.
5. WebTransport/WebRTC datagrams: not needed at io-scale over WSS; revisit at Phase 5.
6. Whether L2 ships server-side 2D collision at all, or jumps from movement-validation straight to L3.
7. **Player persistence — a DataStore analogue** (raised by external review). Absent as a class today, and unnecessary for an arena, but mandatory for the progression genres that actually make UGC platforms sticky (tycoon, simulator). The shape to reserve now so L2/L3 APIs have somewhere to put it: `net.storage` alongside `net.vars` — per-game, per-player key/value with server-side write authority, backed by the collab-server sqlite. Open: quota model, schema/migration story, and whether creators get read access for leaderboards.
8. Watch Roblox's prompt-to-playable "Build" alpha in its first week (rolling out 28 July 2026) and revise §1 positioning if it changes the competitive picture.

---

## Appendix A — WsCore Phase-0 fix list (from recon, with pointers)

- `RoomCompatibility` flags 0/1/2/3 → `VideoChat == Spatial|VoiceChat` bug (`Shared/Rooms/RoomCompatibility.cs:8-15`).
- `RoomManager.CreateRoom` ignores `TryAdd` result (`Shared/Rooms/RoomManager.cs:16-21`).
- `BroadcastToRoom`/`BroadcastToRoomOrAll` dead code; chat broadcasts globally (`Shared/GameMessenger.cs:71-120`, `Chat/Handlers/ChatMessageRequestHandler.cs:23`).
- No AOI despite README/docs claims (`README.md:66`, `docs/ROOM_ARCHITECTURE.md:76-82`) — fix docs in Phase 0, build AOI in Phase 5.
- JSON text-frame fallback reads properties, DTOs are fields → zeroed requests (`WebSocketHandler.cs:182-266`) — remove.
- Bots spawn unconditionally at construction (`Game/Core/GameModel.cs:60-67`); map handlers ignore coords, mutate (0,0), no authorization (`Map/Handlers/*.cs:15-16`); `Player.Hit` has no callers (HP never drops); dead events `SetPlayerHp`/`PlayersTop`.
- Unbounded command queue (`GameServerBase.cs:27`); no idle timeout/ping; no per-IP caps; `/info` `WorkingSet64` never `Refresh()`ed.
- Reconnect gets a new player id — no session resume (`CLAUDE.md:93`); relevant when adding Hello/session tokens.

## Appendix B — Runtime gap → task mapping

| Recon gap | Addressed in |
|---|---|
| No transport/NetworkService; no runtime DI | Phase 1.2 (SceneService lazy getter + 3 bootstraps) |
| No authority dimension on scripts; no fixed-step script tick | Phase 4.3 |
| Spawned prefab child-ID collisions | D6, Phase 1.4 |
| No snapshot-buffer interpolation; 2D anchor-reflow fights transforms | Phase 1.3 (`core:ReplicatedTransform`) |
| No replicated-property markers; `applyLivePropertyUpdate` exists | Phase 1.3 (additive schema flag; generalize the live-update sink) |
| Signals not serialized; single emit dispatch point | Phase 1.3 (RemoteEvent as forwarding component — no serialization change needed) |
| No spawn/despawn protocol; no prefab wire table | Phase 1.4 |
| No prediction/rollback hooks | Deliberately out of scope through Phase 4 (io-genre latency tolerance); revisit Phase 5 |
| Headless blocked at ~6 DOM points | Phase 4.1 |
| Autoloads don't run in SceneRunner | D5 (avoided); separate fix worth its own small task |
| `pause()` stops everything on background | D5 (interval-driven network pump + catch-up) |

## Appendix C — Market sources

Colyseus pricing · Photon Fusion pricing · Hathora→Fireworks shutdown (GamesBeat) · Rivet Compute pivot · Playroom billing · Multisynq · Heroic Labs pricing · Nakama authoritative docs · luau.org/sandbox · Screeps CPU-limit + isolated-vm changelog · Cloudflare Workers/W4P/DO limits+pricing · Rune server-side logic docs + FAQ · Roblox Q1-2026 shareholder letter · Roblox Cube/CubePart/Build coverage · Astrocade raise (PocketGamer) · itch.io open revenue sharing · Poki State of Web Gaming 2026 · CrazyGames FAQ · Discord Activities monetization · vibecode.game launch coverage. (Full URLs in the recon transcript, session `ea50a9f5`, workflow `wf_def74c1a-438`.)

## Appendix D — The 600-player room: budget math

Profile: 2D top-down shooter, one room, 600 players, server tick 20 Hz, client sees ~40 entities (view radius ≪ world).

| Quantity | Naive broadcast-all | AOI + delta + encode-once |
|---|---|---|
| Entities per client per tick | 600 | ~40 |
| Bytes per entity | ~31 (full record) | ~13 (avg delta record) |
| Downstream per client | ~7.4 Mbit/s | **~0.2 Mbit/s** (≈24 KB/s) |
| Room egress | **~4.3 Gbit/s** | **~115 Mbit/s** |
| Serializations per second | 600 × 600 × 20 = 7.2 M | 600 × 20 = **12 k** (+ ~500 k memcpy appends) |
| Verdict | impossible | ~0.2–0.3 core/room in C# |

Consequences that follow from the table:

- **Bandwidth, not CPU, is the first ceiling.** A 1 Gbit/s host saturates at ~6–8 full rooms while using well under half its cores. Egress cost — not compute — sets the pricing model, which is why the tiers in §6 meter room-minutes rather than CCU.
- **Projectiles dominate entity count** before players do (600 shooters → thousands of bullets). Pool them in the SoA table, keep them out of any node graph, and prefer a one-shot "shot fired" event over streaming positions for long-range fire.
- **Snapshot on join is ~1.2 KB** at 40 visible entities — cheap; but a spectator or wide-view mode would see all 600 (~19 KB) and must stream across frames, which is why `WriteSnapshot` is cursor-resumable.
- **Comparison for calibration**: Battlefield ships 128 players, PUBG 100, Warzone 150; MAG's 256 was a record. 600 in one shared space is only reasonable *because* top-down view radius is small — the number is earned by AOI, not by hardware.
- **Launch posture**: architecture targets 600, initial room cap ~200, raised as p99 tick duration and measured per-client bandwidth (from `tools/Pix3.Rooms.LoadGen`) justify it.
