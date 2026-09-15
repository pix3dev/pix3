# Agent pipeline hardening — acting on the Carrom findings

Follow-up to [carrom-agent-pipeline-review.md](carrom-agent-pipeline-review.md). That document is
the measurement; this one is the work. Both pipelines are in scope and they fail in different
places:

- **External agent** (Claude Code editing a project folder): reads `src/templates/agent/AGENTS.md`
  + `.claude/skills/pix3-game-dev/references/{nodes-and-systems,node-types-reference}.md` — the last
  two are copies of `docs/` made at project-creation time by `ProjectTemplateService`. So a gap in
  `docs/` ships into every project ever created from that point on.
- **In-editor agent**: reads `src/services/agent/agent-skills/*.md` via `read_skill`, plus the
  live-derived tools (`list_component_types`, `engine_search`) and the off-package notes in
  `src/core/engine-source.ts`.

The organising idea, taken from review §2: **every sentence of agent-facing prose that makes a claim
about the shape of the tree is a cache, and nothing invalidates it when the tree changes.** So each
phase below pairs a prose fix with a spec that re-derives the claim from the source of truth.

---

## Phase A — drift guards (do these first; they define the process)

| Guard | Source of truth | Claim it re-derives |
| --- | --- | --- |
| A1 | bundled `@pix3/runtime` sources | No `OFF_PACKAGE_TOPICS` note may claim a symbol is absent while the tree has it (nor advertise one it lost) |
| A2 | `KNOWN_SCENE_NODE_TYPES` | Every scene node type has a `### <Name>` section in `docs/node-types-reference.md` |
| A3 | `registerBuiltInScripts` | Every `core:*` behaviour is named in `docs/nodes-and-systems.md` |

A2 fails today on 12 of 35 types; A1 and A3 pass and exist to keep passing.

## Phase B — fill what A2 exposes

`Group`, `ColorRect2D`, `TiledSprite2D`, `AnimatedSprite2D`, `Layout2D`, `Group2D`,
`ScrollContainer2D`, `Sprite3D`, `AnimatedSprite3D`, `AmbientLightNode`, `HemisphereLightNode`,
`PostProcess`. `ColorRect2D` is the one that bites hardest: it is the engine's only solid-colour 2D
primitive and the placeholder both skills tell agents to reach for.

## Phase C — headless scene runner (review §4, highest leverage)

A `@pix3/runtime` testing entry that boots a scene, registers user scripts, advances N fixed steps
and hands back state — no browser, no dev server, no MCP round trip. It converts the bug class that
survived every static gate (an inverted sign that made the game 100 % unplayable and 0 % detectable)
into the cheapest check in the pipeline.

Pieces: the canvas-2D stub (`Label2D` paints in its constructor, happy-dom has no canvas), a
renderer double so `SceneRunner` needs no WebGL, an environment-agnostic file reader seam (the
runtime must stay browser-targeted, so the *caller* supplies `node:fs`), and `manual` time mode +
`stepFrames`, which already exist.

## Phase D — papercuts that cost an agent a round trip

1. `debug-running-game` skill does not mention `window.__PIX3_DEBUG__.agentTools.execute()` — the
   difference between a session that works *with* the editor and one that works around it (§5).
2. `read_errors` carries benign `Component type "user:X" not found in registry` noise on every
   project open (§6.4). Benign noise in the error channel trains the agent to ignore the channel.
3. No `project.open-path` (§6.2) — every agent workflow that starts from files on disk needs one
   human click.
4. `fs_write` is text-only (§6.5).
5. `juice.shake` returns `null` and fires and forgets (§6.6).

## Phase E — external-agent template refresh

`src/templates/agent/` says nothing about 2D physics, nothing about `registerGameDebug` /
`scene.commands` as the verification surface, and nothing about the headless harness. It is the
same shape of gap as the one `engine_search` had, in the other pipeline.

---

## What was done (2026-09-15)

All five phases landed. Verified three ways: `npm run test` (4652 green), `npm run type-check`,
`npm run lint`, and **live in the running editor** through `__PIX3_DEBUG__` / `agentTools` — the
review's §7 lesson being that a judgement about a pipeline has to be made by using it.

### A — drift guards

- `OffPackageTopic` gained a `claims: { present, absent }` field, and
  `engine-source.spec.ts` re-derives every claim from the sources `engine_search` actually searches.
  Verified to bite: adding a symbol the tree does not have fails with a message naming the note.
- `src/core/agent-reference-docs.spec.ts` (new): every `KNOWN_SCENE_NODE_TYPES` entry has a section
  in `node-types-reference.md`, and every registered `core:*` behaviour is named in
  `nodes-and-systems.md`. The first failed on 12 of 35 node types; the second already passed.

### B — the 12 missing node sections

`Group`, `ColorRect2D`, `TiledSprite2D`, `AnimatedSprite2D`, `Group2D`, `ScrollContainer2D`,
`Sprite3D`, `AnimatedSprite3D`, `AmbientLightNode`, `HemisphereLightNode`, `PostProcess`, plus
`Layout2D` documented as **removed** (the loader throws on it; it stays in the registry so an old
scene gets that message instead of a silent inert node). Property tables were read out of the live
schemas and constructors, not written from memory. Quick-reference rows and the "Choosing the Right
Node" lists updated to match.

### C — headless scene runner

`@pix3/runtime/testing` — `createHeadlessGame` + `installCanvas2DStub`, with
`headless-game.spec.ts` driving `samples/Carrom` end to end in ~3 s and no browser.

Four things were not obvious going in and are worth keeping in mind:

1. **Stepping has to be asynchronous.** Games do async work inside a frame (`scene.instantiate`,
   `changeScene`), and in a browser those continuations land between animation frames. A synchronous
   tick loop gives them nowhere to run, so a rack of prefabs spawned in `onStart` still did not exist
   600 frames later. `step()` yields between ticks; `start()` gets a deeper flush because start-up
   spawns are a long promise *chain*, not a batch.
2. **The asset seam already existed.** `ResourceManager`'s embedded base64 map — the single-file
   export mechanism — gives a headless run exactly the resolution a shipped game has. What did have
   to be added is an `OfflineResourceManager` that fails at a miss instead of falling through to
   `fetch()` against a localhost port nobody serves.
3. **`RuntimeRenderer` cannot be subclassed** (it builds a `WebGLRenderer` in its constructor), so
   the harness passes a structural double — the same one specs across the runtime were hand-rolling
   — and sets `renderEveryNTicks` past reach so nothing ever paints.
4. **The obvious assertion was not the discriminating one.** Re-introducing the inverted-sign bug
   and re-running was the only way to learn that "the shot eventually touches something" passes on a
   completely unplayable game: the striker fires at the far cushion, rebounds, and drifts back
   through the rack for six contacts. The property that separates them is *direction* — a break
   travels toward the centre of the board. **Verify the guard fails on the bug it was written for**,
   or it is decoration.

### D — papercuts

| # | Fix |
| --- | --- |
| §5 | `debug-running-game` §2.1: `agentTools.list()/execute()`, `agent.send()`, and why to work with the editor rather than around it |
| §6.2 | `__PIX3_DEBUG__.project.recents()` / `.open(nameOrPath)` — reopens any project this profile has already been granted, no click. Only the first-ever grant still needs a human, and `open()` says so |
| §6.4 | `createComponent` takes `expectRegistered: false` from the scene-hydration path, so pre-compile `user:*` components warn as *pending* instead of writing to the error channel. **Measured live: 13 → 0 console errors on project open** |
| §6.5 | `fs_write` accepts `encoding: 'base64'` and writes real bytes (bad base64 is refused, not written as garbage) |
| §6.6 | `juice.shake('camera2d')` with no camera, and any unresolved juice target, now warn once per target instead of failing silently |

### E — external-agent template

`src/templates/agent/skills/pix3-game-dev/SKILL.md` gained the 2D-physics tier table (the same gap
that bit the in-editor agent, in the other pipeline), a "build the debug surface as you go" step for
`scene.commands` + `registerGameDebug`, the headless harness, and the runtime traps that compile
clean. `AGENTS.md` gained rules 8 and 9: a game that type-checks is not a game that works, and give
every intent a name. The repo-level `.claude/skills/pix3-game-dev` got the same treatment against
its own numbering.

## Still open

- **§6.3 / §6.7 are covered by docs, not by tests.** `node-types-reference.md` is now guarded for
  *presence*; nothing checks that a documented property list still matches the schema. A guard that
  diffs the table against `getPropertySchema()` is the natural next step, and would have caught the
  four-scalar `sliceBorder` shape drifting from prose.
- **The 14-item API-discrepancy list from the implementer (review §5) has not been harvested** —
  `punchScale` takes `amount` not `scale`, `teleport` zeroes velocity, `Label2D`'s YAML keys are
  `label`/`labelFontSize`, contact signals are asymmetric across a body-less cushion. These belong
  in `node-types-reference.md` / the skills rather than being rediscovered per session.
- **Editor-created projects have no Node toolchain**, so the headless harness reaches consumer
  projects (DeepCore) and this repo's samples, not a folder scaffolded by the editor. Scaffolding a
  minimal `package.json` + vitest into the project template would extend it; that is a product
  decision, not a papercut.
