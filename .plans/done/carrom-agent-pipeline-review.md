# What building Carrom taught us about the agent pipeline

Written after building `samples/Carrom` end to end on 2026-09-15: a Fable design pass, an Opus
implementation pass against that spec, and live verification in the running editor. The point of
the exercise was never the game — it was to walk the pipeline an agent walks and write down where
it leaks. Everything below is something that actually happened, with the evidence attached.

---

## 1. What shipped, and whether it cleared the bar

The bar was a Gemini-authored single-file canvas prototype: 1000 px virtual board, `v *= 0.981`
friction, a hand-rolled impulse solver, an HTML slider to place the striker, a flat score, no rules,
no turns, no opponent.

What `samples/Carrom` does instead, verified live:

| | Gemini prototype | This one |
| --- | --- | --- |
| Physics | ~250 lines of hand-written solver | engine `core:PhysicsBody2D` + `core:Collider2D`, zero solver code |
| Rules | score only | turn loop, continuation on own pot, Queen + cover, fouls with penalty returns, win condition |
| Opponent | none | `user:CarromAI`, ghost-ball search over striker slots × men × pockets, difficulty noise |
| Aiming | fixed-length dotted line | first-contact preview: analytic circle sweep, ghost striker, deflection arrow |
| Verification | play it and look | `scene.commands` + `registerGameDebug` — every rule drivable and assertable without input |

Measured in the editor, not asserted on paper:

- A full-power break settles in **2.46 s** (target 2–4 s, hard bound 6 s).
- Kinetic energy decays monotonically across the strike: 2 596 410 → 668 106 → 152 733 → 28 820 →
  1 864 → 0. No energy injection anywhere in the solve.
- Containment holds: max |coordinate| over a whole strike was **411**, against a limit of 420.
- `timeScale` drops to 0 for exactly 3 frames starting at the frame of first contact, then returns
  to 1 — the hitstop is real and edge-triggered, not per-frame.
- 55 s of autoplay: pieces pocketed, fouls resolved, piece conservation exact (9 − 7 = 2 white
  pocketed, 9 − 8 = 1 black), **zero runtime errors**, no stall.
- All art is 285 KB total.

So: cleared, on rules, opponent, feel and verifiability. The one place it does not obviously win is
raw screen presence — the Gemini page fills the browser with one big board, and ours is a 1080×1920
portrait layout that only looks right on a phone-shaped viewport.

---

## 2. The finding that matters most

**`engine_search` was actively steering agents away from the engine's own 2D physics.**

The natural question a carrom-building agent asks:

```
engine_search "top-down physics friction discs"  →  0 matches
```

and attached to that silence, a note stating that *rigid-body physics is NOT in `@pix3/runtime/src`*,
that an empty result is not evidence the engine lacks it, that Rapier is the answer, and that **2D
games should stay on `Collision2DService` + `core:Hitbox2D`**.

Every clause of that was written truthfully and every clause had gone wrong:

- `PhysicsBody2D` → **45 matches**, `physics2d` → **124**. The 2D solver landed *inside* the package
  after the note was written. The note was a claim about the tree, and the tree grew.
- `Collision2DService` is the **query** tier. It answers "is anything here?" and applies no impulses.
  An agent that follows the note to it, for a game that needs collision response, ends up writing
  the impulse solver by hand — which is the exact failure the note exists to prevent. The note had
  inverted into its own failure mode.
- The search is **literal**. `PhysicsBody2D` hits 45 times; the sentence a person actually types hits
  zero. So the natural-language query is precisely the one that receives *only* the note. The note
  has to be correct standing alone, because for that query it is the entire answer.

**Worse, the skill corpus had no 2D physics at all.** `grep -rn "PhysicsBody2D|physics2d|Collider2D"
src/services/agent/agent-skills/` returned **nothing**. The only physics section in
`game-prototype.md` was titled "3D rigid-body physics: Rapier is here" and closed by sending 2D games
to the hitbox tier. An agent asking the right question, reading the right skill, and following the
pointer correctly would still have arrived at "hand-roll it".

Fixed in this pass and verified through the editor's own tool: the note now leads with the 2D solver
and its API, the pattern also fires on `restitution`/`friction` (neither word appears outside the
physics files, so no noise), and `game-prototype.md` §4¾ is now "Physics: 2D is built in, Rapier is
only for 3D" with the three-tier table and an explicit warning that reaching for the query tier when
you need response is the same mistake as writing the solver yourself. 21/21 guarding tests pass,
including the one that keeps the `read_skill` pointer from becoming a dead link.

**The general lesson, which is bigger than this note:** every advisory that says "X is not here" is a
cache of the tree's shape, and nothing invalidates it when the tree changes. It needs a test that
re-derives the claim. Concretely: a spec asserting that if `PhysicsBody2D` has matches in the bundled
sources, no off-package note may claim rigid-body physics is absent. Same shape of guard for the
skills: assert every shipped `core:*` behaviour is named in at least one skill, or is explicitly
listed as not agent-facing. Without that, a capability added after the prose was written is invisible
to the agent forever, and the agent's confident wrong answer looks exactly like a confident right one.

---

## 3. The bug class that survived every check we have

The implementer's `strikerLineY()` had an inverted sign: it derived the placement line from
`forwardSign(shooter)`, which put **each player's striker on the opponent's baseline**, aimed off the
board.

What that bug passed, cleanly:

- `tsc --noEmit` — zero new errors.
- `prettier --check`.
- YAML validation of all four scene files.
- A real `SceneLoader.parseScene` headless load, asserting the striker resolves to world y = −346.
  It passed because −346 is the **authored** value in the scene file; nothing at load time calls
  `strikerLineY`.
- My own static geometry cross-checks.

What caught it: running the AI against the standard rack and measuring contact rate — **0.000**.
After the fix, **1.000**.

A game that was 100 % unplayable was invisible to every static gate in the pipeline, and obvious
within one behavioural run. That is the whole argument for the next item.

---

## 4. The missing piece: there is no headless way to *run* a scene

We can parse a scene headlessly — `multiplayer-arena-sample.spec.ts` shows the pattern and I reused
it for `src/core/carrom-sample.spec.ts`. We cannot *run* one. To answer "does a full-power break
settle within 6 seconds", the only available path was: start a dev server, open Chrome, open a
project, enter play mode, and poll over an MCP round trip.

Two concrete obstacles found while trying:

- **happy-dom has no 2D canvas**, and `Label2D` measures and paints text in its constructor. So a
  scene containing *any UI text* cannot even be parsed headlessly without stubbing
  `HTMLCanvasElement.prototype.getContext`. I wrote that stub; it is ~25 lines and belongs in the
  runtime's test utilities, not copy-pasted per spec.
- There is no fixed-step driver. `SceneRunner` exists but nothing packages "boot this scene, register
  these user scripts, advance N fixed steps, hand me the state".

**Recommendation, highest leverage item in this document:** ship a tiny headless harness in
`@pix3/runtime` — canvas stub, null renderer, fixed-step advance, script registration — so that an
agent can write

> load `main.pix3scene`, dispatch `shoot {angleDeg: 90, power: 1}`, advance 600 steps, assert the
> board settled, energy never rose, nothing left the playfield

and run it in two seconds with no browser. That converts the one failure class static checks cannot
see into the cheapest check in the pipeline. Everything else in this document is a papercut by
comparison.

---

## 5. Things that worked, and should become the default

**`scene.commands` + `registerGameDebug` was the best part of the whole pipeline.** Because the game
registered `shoot`, `place-striker`, `layout`, `restart`, `settle`, `autoplay` and a full state
snapshot, every claim above is a state assertion — no synthetic pointer events, no screenshot
guessing, no timing luck. I drove 55 seconds of autoplay and read piece conservation straight out of
the snapshot. This should be scaffolded by the project templates and treated as load-bearing, not as
an optional nicety a game may or may not add.

**Spec-then-implement held up.** Fable's spec cited file paths for every engine claim, and every API
I spot-checked independently — the whole `scene.juice.*` surface, `time.hitstop`/`slowMotion`, all
nine `SfxPreset` values — existed exactly as named. The implementer's discrepancy list (14 items:
`punchScale` takes `amount` not `scale`, `teleport` zeroes velocity, `Label2D` YAML keys are
`label`/`labelFontSize`, contact signals are asymmetric across a body-less cushion, and so on) is
the kind of artifact that should be harvested into the docs rather than rediscovered every time.

**The editor's tool layer is reachable from outside**, via
`window.__PIX3_DEBUG__.agentTools.execute(name, args)` — all 49 tools, plus `agent.send()` to drive
the chat end to end. That is how the verification in §1 was done. It is not written down anywhere;
it belongs in the `debug-running-game` skill, because it is the difference between a session that
works *with* the editor and one that works *around* it. I started this task working around it, and
had to be corrected.

---

## 6. Smaller defects found, in descending order of cost

1. **`Node2D` silently loses its transform on a save/load round trip.** `SceneSaver` writes a 2D
   node's placement only inside `properties.transform`; the loader's `Node2D` branch read only the
   flat `properties.position` — the one branch of seventeen missing the `transform` fallback that
   `Sprite2D`, `Group2D`, `Label2D` and the rest all have. A hand-authored node loads correctly
   *once*, the first editor save rewrites it into `transform:`, and the next load drops it at the
   origin with no warning. It lands hardest on hand-authored scenes, which is exactly what agents
   produce. **Fixed**, with a round-trip regression spec that I confirmed fails without the fix.
2. **Project opening cannot be automated at all.** `showDirectoryPicker` is a native dialog: no
   agent tool, no CDP path, no command. The registry has 49 tools and 72 commands including
   `project.new`, but no `project.open`. So every agent workflow that begins with files on disk
   requires one human click. Once granted, the handle persists and the recent-projects entry is an
   ordinary DOM button an agent *can* click — so it is only ever the first grant. A dev-only
   `project.open-path` command would close it.
3. **`node-types-reference.md` does not document `ColorRect2D`, `Group2D`, `AnimatedSprite2D` or
   `TiledSprite2D`** — zero mentions of `ColorRect2D`, which is the only solid-colour primitive the
   engine has. An agent following the doc router's "all properties of one node type" row would
   conclude it does not exist. A spec asserting every exported node class has a `### <Name>` section
   would have caught it.
4. **Opening a project logs 13 `Component type "user:X" not found in registry` console errors**,
   because the scene loads before the scripts compile. They are benign — the components are kept
   pending and attach on registration — but they land in `read_errors`, which is the tool an agent
   uses to decide whether something is broken. Benign noise in the error channel trains the agent to
   ignore the error channel.
5. **`fs_write` is text-only.** An agent cannot deliver a binary asset except through
   `generate_asset`. Our sprites had to be written from outside the editor. A base64 mode, or a
   documented "use the asset handle API", would close the gap.
6. **`juice.shake('camera2d', …)` returns `null` and fires and forgets** — there is no way to tell
   whether a camera was found, so a shake that silently does nothing looks identical to one that
   worked.
7. **`GameTime.hitstop` is not safe to call per frame** (it warns after 30 consecutive frames and
   deadlocks `dt` at 0). That is a reasonable design, but it means "call this on every contact" —
   the obvious reading — is wrong, and the edge-trigger requirement should be in the skill text.

---

## 7. What I would change about how the work was run

The division — Fable designs against grounded sources, Opus implements against the spec, the session
verifies live — produced a working game in one pass, and the implementer caught its own inverted-sign
bug by soaking behaviour rather than trusting its types. That part is sound.

The mistake was mine and it is worth naming: **I built the game around the editor instead of with
it.** Hand-written YAML, shell tooling, vitest — all of which produced a correct artifact, and none
of which exercised the thing under review. The whole value of this exercise is what breaks when you
use the editor's own tools, and I only found the `engine_search` defect — the most important finding
here — *after* switching to them. For a task whose deliverable is a judgement about a pipeline, using
the pipeline is not a stylistic preference; it is the measurement.
