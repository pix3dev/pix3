# Carrom prototype — implementation-ready build spec

Status: **M0–M5 implemented and verified** (2026-09-15); optional M6 remains a separate follow-up. Target: one evening of implementation on the Pix3 engine as a
standalone sample project (`samples/Carrom/`). Bar to beat: the Gemini single-file canvas
prototype (`carrom_board_game_prototype.html`, 1000 px virtual board, per-disc `v *= 0.981`,
hand-rolled impulses, slider-positioned striker, flat score, no rules / turns / opponent).

Every engine fact below was checked against the runtime source or the router docs on
2026-09-15; file paths are given so the implementer can re-check. Where the engine offers
two ways, one is picked and the reason is one sentence.

---

## 1. Design intent

**What makes it feel like carrom, not billiards-with-discs:**

- The board is a _square_ with tight corner pockets that are barely wider than a disc, so
  pots along a cushion are the bread and butter and open-board pots are a reward.
- Cloth is _slick_ but stops _crisply_: a struck man glides ~600 px then dies in under two
  seconds; a full-power striker crosses the board in ~0.4 s and can rebound twice.
- The striker is _heavier_ than the men (mass 2.4 : 1), so a soft touch nudges a man in and
  a hard hit scatters the rack without the striker stopping dead.
- Real turn structure: pocket your own colour and you keep shooting; the Queen must be
  covered; potting the striker costs you a man.

**Where we beat the Gemini prototype (4 concrete places):**

1. **Rules + turn loop + AI opponent.** White (you) vs Black (AI), continuation on own pots,
   Queen-and-cover, fouls with penalty men returned to the centre, win condition, end
   screen. Gemini has a single-player "flat score" and nothing else.
2. **First-contact aim preview.** The dotted guide stops at the first thing the striker will
   hit, draws a ghost striker at the contact point and a short deflection arrow on the struck
   man (analytic circle sweep, `scripts/carrom-geometry.ts`). Gemini draws a fixed-length
   dotted line that ignores everything on the board.
3. **Direct manipulation.** Drag the striker along the baseline to position it, pull back
   from anywhere on the board to aim, release to shoot — no HTML slider. Power is shown on a
   `Bar2D` and by the guide colour.
4. **Game feel from engine systems, not oscillators:** edge-triggered hitstop on the striker's
   first contact, `Camera2D` shake scaled by impact, pocket particle burst + floating "+1",
   Queen slow-motion beat, turn banner punch-in, striker ghost trail, procedural SFX with
   velocity-driven volume/pitch.

---

## 2. Rules to implement (prototype subset, decided)

Players: **Human = White**, **AI = Black**. Human breaks. Human always strikes from the
**bottom** baseline, the AI from the **top** baseline (the board is not rotated between turns —
simplest, and the AI never needs the camera).

A **strike** = one shot and everything that happens until every disc is settled.

| Event on a strike                                        | Outcome                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| At least one own man pocketed, no foul                   | Pocketed men are credited; **shooter keeps the turn**.                                                                                       |
| Nothing pocketed / striker touched nothing               | Turn passes. **Not a foul** (matches ICF; the prompt's "no contact" case is deliberately a plain turn loss).                                 |
| Opponent's man pocketed (only)                           | It is credited **to the opponent**; turn passes. If an own man was also pocketed on the same strike, shooter keeps the turn.                 |
| **Striker pocketed** (foul)                              | Every man pocketed on this strike returns to the centre **plus one penalty man** of the shooter's colour (or a "due" if none pocketed yet). Turn passes. If the Queen was pocketed on this strike she returns too. |
| **Queen pocketed**, an own man pocketed on the same strike | Queen is **covered** immediately; credited to shooter; turn continues.                                                                       |
| **Queen pocketed**, no own man on the same strike        | Shooter keeps the turn and must pocket an own man on the **very next strike** (`queenCoverPending`). If that strike pockets an own man → covered. Otherwise the Queen returns to the centre and the turn passes. |
| Own **last man** pocketed while the Queen is still on the board | The man returns to the centre; turn passes. (Forgiving prototype version of the real "lose the board" rule.)                                 |

**Win:** the first player whose 9 men are all pocketed **after** the Queen has been covered
(by anyone) wins. End-screen score, real-carrom style: `opponent men left on board` + `3 if the
winner covered the Queen`.

**Penalty "due":** a foul with no pocketed men to return records `due[colour] += 1`; the next
time that colour pockets a man it is returned instead of credited (`due -= 1`).

**Returned pieces** go to the centre `(0, 0)` if free, else the nearest free spot walking
outwards on a hex spiral in steps of `2 * MAN_R + 2` (a spot is free when no disc centre is
within `2 * MAN_R + 1`).

**Deliberately cut** (say so in the HUD help text, not in code): the "must pocket a man before
the Queen counts" rule, thumb/back-shots, the striker-must-cross-front-line rule, the 29-point
multi-board match, breaking re-tries, pieces landing on top of each other / off the board.

**Shot legality (enforced by input, not by rules):** the striker is placed on the shooter's
baseline `x ∈ [-240, 240]`, and the shot direction is clamped to the forward cone (see §6).

---

## 3. Board geometry (design pixels)

**Coordinate convention — verified:** 2D nodes use design pixels, **origin at the parent
container's centre, X right, Y UP** (`docs/node-types-reference.md` "2D Nodes": "Y increases
upward"; `Node2D.ts` flow comment: "a child's position is its CENTRE, the origin is the
container's centre, and y points UP"; `Physics2DService.ts`: "Design pixels, y up, radians
CCW"). Rotation is degrees, clockwise-positive on `Node2D`. The board is centred on the scene
root, so **board space == 2D world space**. The human sits at **negative y** (bottom).

Project viewport: `viewportBaseSize 1080 × 1920`, `projectType: 2d`, `targetPlatform: mobile`
(portrait: 1000 px board centred, HUD bands above/below). Scale from a real 74 cm playfield:
`880 px / 74 cm ≈ 11.9 px/cm`; disc sizes are rounded up slightly for touch.

| Element                                  | Value (px)                                              | Note                                                              |
| ---------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| Board outer square (wood frame)          | 1000 × 1000, centre (0,0) → edges at **±500**           | `BOARD_HALF = 500`                                                |
| Frame thickness                          | **60**                                                  |                                                                   |
| Playfield inner square                   | 880 × 880 → cushion faces at **±440**                   | `FIELD_HALF = 440`                                                |
| Cushion collider rects (static)          | Top `(0, 480)` 1000×80; Bottom `(0, −480)`; Left `(−480, 0)` 80×1000; Right `(480, 0)` | inner faces land exactly on ±440; 80 thick so nothing tunnels |
| Pocket centres                           | `(±408, ±408)`                                          | `POCKET_INSET = 32` from each cushion face                        |
| Pocket visual radius                     | **32**                                                  | drawn hole; tangent to both cushions                              |
| Pocket **capture** radius                | **28**                                                  | a disc is pocketed when its **centre** is within 28 of a pocket centre |
| Carrom-man radius                        | **20** (sprite 40×40)                                   | `MAN_R`                                                           |
| Striker radius                           | **26** (sprite 52×52)                                   | `STRIKER_R`                                                       |
| Queen radius                             | 20 (same as a man)                                      |                                                                   |
| Baselines (human)                        | y = **−330** (front line) and **−362** (rear line), x ∈ **[−280, 280]** | double line, 32 apart                                     |
| Baselines (AI)                           | y = **+330** / **+362**, same x-extent                  | plus left/right pairs at x = ±330/±362, y ∈ [−280, 280], **drawn only** |
| Striker placement line                   | y = **−346** (human) / **+346** (AI) — midway between the two lines; x ∈ **[−240, 240]** | striker centre; the 240 keeps its 26 radius inside the base circles |
| Base circles (red)                       | centres `(±280, −346)` and `(±280, +346)` (and the side pairs), radius **19** | drawn only                                                 |
| Centre circle (queen spot)               | radius **19**, filled red at 35 % alpha                 | drawn only                                                        |
| Centre ring                              | radius **95**                                           | drawn only                                                        |
| Outer centre ring                        | radius **170**                                          | drawn only                                                        |
| Corner arrow lines                       | from `(±150, ±150)` to `(±340, ±340)`, 3 px             | drawn only                                                        |
| Rack — Queen                             | `(0, 0)`                                                |                                                                   |
| Rack — inner ring (6)                    | radius **41** (`2*MAN_R + 1`), angles 0°,60°,…,300°; colours W,B,W,B,W,B starting at 0° (white points at +x) | 3 W + 3 B |
| Rack — outer ring (12)                   | 6 at radius **82** on 0°,60°,…; 6 at radius **71** (`41·√3`) on 30°,90°,…; sorted by angle, colours alternate **B,W,B,W…** starting with B at 0° | 6 W + 6 B → totals 9/9 |
| Striker parking (pocketed / off-turn)    | `(0, −1200)` hidden                                     | outside every collider; sleeps                                    |

Put every number in `scripts/carrom-geometry.ts` as exported constants and generate the
board PNG from the **same** constants (see §7), so art and physics cannot drift.

---

## 4. Physics parameters

Engine: built-in `scene.physics2d` (`packages/pix3-runtime/src/core/Physics2DService.ts`),
sequential impulses, stepped at the runner's **fixed 1/60 s** (`ECSService.DEFAULT_FIXED_TIME_STEP`,
max 4 steps/frame), so hitstop/slow-mo dilate it for free. Solver constants that matter and
are **not** configurable: `RESTITUTION_THRESHOLD = 40 px/s` (slower contacts never bounce),
`SLEEP_LINEAR_THRESHOLD = 4 px/s` sustained `SLEEP_TIME = 0.5 s`, `MAX_POSITION_CORRECTION = 4 px`,
`PENETRATION_SLOP = 0.05`. Damping is exponential: `v *= 1 / (1 + dt·linearDamping)`.
Restitution combines as **max** of the pair, friction as the geometric mean.

| Parameter                         | Value                                  | Why                                                                                                                                                                       |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gravity                           | `(0, 0)`                               | top-down. `core:PhysicsWorld2D {gravityX: 0, gravityY: 0}` on `GameRoot` **and** `scene.physics2d.setGravity(0, 0)` in `GameController.onStart` (belt and braces; the behaviour's default is −1960). |
| Man mass                          | **1.0** (explicit `mass`)              | `mass: 0` would derive area × density = 1257 — never leave it at 0.                                                                                                        |
| Striker mass                      | **2.4**                                | real ≈ 15 g : 5.5 g = 2.7; a touch lighter so a soft pot does not blast the man.                                                                                          |
| `linearDamping` (all discs)       | **0.6 s⁻¹**                            | viscous part of cloth drag.                                                                                                                                               |
| Extra constant deceleration       | **220 px/s²** (script, every `onUpdate`, all awake discs) | real cloth is Coulomb (constant decel) and stops crisply; the engine only has viscous damping (**engine gap #1**). Combined: a man at 800 px/s travels ≈ 630 px and stops in ≈ 1.9 s; a 2200 px/s striker would run ≈ 2.7 board-lengths (before cushion losses) and dies in ≈ 3.3 s. Everything settles in 2–4 s. |
| Stop snap                         | speed < **6 px/s** → `setVelocity(0,0)` | kills the sub-pixel creep; then the solver sleeps the island 0.5 s later.                                                                                                |
| Restitution (discs **and** cushions) | **0.78**                            | one value because the combine rule is `max` — a "softer cushion" is impossible (**engine gap #2**). 0.78 gives a lively but not floaty clack (Gemini's 0.94 floated).      |
| Friction, discs                   | **0.05**                               | acrylic on powdered wood; low so shots are predictable.                                                                                                                    |
| Friction, cushions                | **0.10**                               | pair value √(0.05·0.10) ≈ 0.07.                                                                                                                                            |
| `fixedRotation`                   | `true` on every disc                   | no spin semantics top-down; avoids angular jitter.                                                                                                                         |
| `canSleep`                        | `true`                                 | settle detection may read `isSleeping`.                                                                                                                                    |
| `bullet` (CCD)                    | `true` on the **striker only**         | sweeps against static geometry (cushions); dynamic-vs-dynamic CCD does not exist (**engine gap #3**), hence the speed cap below.                                          |
| `emitContacts`                    | `true` on every disc                   | SFX + hitstop come from `contact-started`.                                                                                                                                 |
| Striker launch speed              | `350 + power · (2200 − 350)` px/s, power ∈ [0, 1] | 2200 px/s × 1/60 = 36.7 px/step < combined man+striker diameter 92, so a head-on hit is always sampled; only a full-speed graze can be missed. 2200 crosses the 880 field in 0.4 s. |
| Man launch (AI/tests only)        | never launched directly                |                                                                                                                                                                            |
| Settle rule (game)                | all discs speed < 6 px/s for **0.35 s** continuously **or** 8 s elapsed since the shot (then force `setVelocity(0,0)` on all) | independent of the 0.5 s sleep latency; the timeout guards a jitter case.                                              |

Collider shape for every disc: `shape: circle`, `radius` as in §3, `offsetX/Y: 0`,
`density: 1` (unused because mass is explicit), `group`: `'striker'`, `'man'`, `'queen'`.

---

## 5. Scene graph — `scenes/main.pix3scene`

Two roots (same pattern as `samples/CanonGame/scenes/main.pix3scene`): the game under a
`Group2D`, the HUD under a `CanvasLayer2D` so a camera shake never moves the UI. Positions are
`transform.position: [x, y]` (y up). Component YAML shape (verified against
`.plans/physics-engine.md` §authoring and the CanonGame sample):

```yaml
components:
  - id: striker-body
    type: core:PhysicsBody2D
    enabled: true
    config: { bodyType: dynamic, gravityScale: 0, mass: 2.4, linearDamping: 0.6, angularDamping: 0.05, fixedRotation: true, bullet: true, canSleep: true, emitContacts: true }
  - id: striker-shape
    type: core:Collider2D
    enabled: true
    config: { shape: circle, radius: 26, offsetX: 0, offsetY: 0, friction: 0.05, restitution: 0.78, density: 1, sensor: false, group: striker }
```

**Authored in the scene** (A) vs **spawned at runtime** (R):

```
GameRoot                Group2D 1080×1920, layout stretch                       (A)
  components: core:PhysicsWorld2D {gravityX:0, gravityY:0}
              user:GameController, user:ShotInput, user:CarromAI
├─ Camera2D             Camera2D (0,0) priority 10, zoom 1, shakeAmplitude 6, shakeDuration 0.2   (A)
├─ Board                Group2D 1000×1000 @ (0,0)                                (A)
│  ├─ BoardArt          Sprite2D res://sprites/board.png 1000×1000 @ (0,0)      (A)
│  ├─ Cushions          Node2D                                                   (A)
│  │  ├─ CushionTop     Node2D @ (0, 480)   core:Collider2D {shape: rect, width: 1000, height: 80, friction: 0.1, restitution: 0.78, group: cushion}
│  │  ├─ CushionBottom  Node2D @ (0, −480)  same
│  │  ├─ CushionLeft    Node2D @ (−480, 0)  core:Collider2D {shape: rect, width: 80, height: 1000, …}
│  │  └─ CushionRight   Node2D @ (480, 0)   same
│  ├─ Pockets           Node2D — four empty Node2D markers PocketTL (−408,408), PocketTR (408,408), PocketBL (−408,−408), PocketBR (408,−408); no components (GameController reads their positions; the editor shows them)   (A)
│  ├─ Pieces            Node2D @ (0,0) — parent for spawned men                  (A)  children (R)
│  ├─ Trail             Node2D — 8 × Sprite2D "Ghost0..7" res://sprites/striker.png 52×52 opacity 0, visible true, blendMode additive   (A)
│  ├─ Striker           Sprite2D res://sprites/striker.png 52×52 @ (0, −346)     (A)
│  │     components: core:PhysicsBody2D (above), core:Collider2D (above), user:Disc {kind: striker}, user:StrikerTrail
│  └─ AimGuide          Node2D @ (0,0) visible false, zIndex 10                   (A)
│        components: user:AimGuide
│        children: Dot0..Dot11  Sprite2D res://sprites/dot.png 12×12 color #38bdf8
│                  RubberBand  ColorRect2D 6×100 color #f43f5e opacity 0.7  (rotated/stretched by script)
│                  Ghost       Sprite2D res://sprites/striker_ring.png 52×52 opacity 0.4
│                  Deflect     ColorRect2D 4×80 color #ffffff opacity 0.6
HUD                     CanvasLayer2D 1080×1920, layout stretch                  (A)
├─ TopPanel             ColorRect2D 1080×300 @ (0, 810) color #14100d opacity 0.85
├─ OpponentName         Label2D "OPPONENT · BLACK" @ (−270, 870) size 40 color #cfc6b8
├─ OpponentLeft         Label2D "9 left" @ (−270, 810) size 64 color #ffffff, core:PunchScale {triggerEvent: bump}
├─ PlayerName           Label2D "YOU · WHITE" @ (270, 870) size 40
├─ PlayerLeft           Label2D "9 left" @ (270, 810) size 64, core:PunchScale {triggerEvent: bump}
├─ QueenStatus          Label2D "Queen: on board" @ (0, 730) size 34 color #f5ae39
├─ TurnBanner           Label2D "YOUR TURN" @ (0, 600) size 72 glowStrength 2 glowColor #f5ae39, core:PopIn {triggerEvent: show}
├─ Toast                Label2D "" @ (0, −600) size 40 color #ff6a5a outlineWidth 3
├─ PowerBar             Bar2D 600×22 @ (0, −680) value 0 minValue 0 maxValue 1 barColor #f43f5e backBackgroundColor #2a2320, visible false
├─ HelpLabel            Label2D "Drag the striker to place it · pull back anywhere to aim · release to shoot" @ (0, −740) size 28 color #9a8f82
├─ RestartButton        Button2D 300×90 @ (0, −850) backgroundColor #3b2d24 hoverColor #4a3a2f pressedColor #2b1f18
│     └─ RestartLabel   Label2D "Restart" size 40
└─ EndOverlay           Group2D 1080×1920 visible false
     ├─ Dim              ColorRect2D 1080×1920 color #000000 opacity 0.6
     ├─ Panel            ColorRect2D 820×560 @ (0,0) color #1b1410 opacity 0.95, core:PopIn {playOnStart: true}
     ├─ ResultLabel      Label2D "YOU WIN" @ (0, 140) size 96 glowStrength 2
     ├─ ScoreLabel       Label2D "Score 7 (Queen +3)" @ (0, 20) size 48
     └─ PlayAgainButton  Button2D 360×110 @ (0, −150) + Label2D "Play again"
```

**Prefabs (R, spawned by `scene.instantiate`)** — three files, one root each; a single prefab
plus a runtime `texturePath` swap was rejected because it is not verified that a runtime
`texturePath` reassignment triggers a texture load (engine-gap #9), and three 25-line files cost
nothing:

- `scenes/man-white.pix3scene` — root `Sprite2D` "Man" `res://sprites/man_white.png` 40×40;
  components `core:PhysicsBody2D {dynamic, gravityScale 0, mass 1, linearDamping 0.6, fixedRotation true, bullet false, canSleep true, emitContacts true}`,
  `core:Collider2D {circle, radius 20, friction 0.05, restitution 0.78, group: man}`, `user:Disc {kind: white}`.
- `scenes/man-black.pix3scene` — same, `man_black.png`, `kind: black`.
- `scenes/queen.pix3scene` — same, `queen.png`, `kind: queen`, collider `group: queen`.

Notes: `scene.instantiate(path, { parent: 'Pieces' })` clones with unique ids and the
components `onStart` (→ `registerBody`) on the next tick, so `GameController` must spawn the rack
and **wait one frame** before reading `physics2d.getBody(node)`. Draw order is tree order
(`Pieces` before `Striker` before `AimGuide` → striker over men, guide over everything);
`AimGuide.zIndex: 10` is belt-and-braces.

---

## 6. Script breakdown (`scripts/`, all `user:` ids = class names)

Shared plain module (not a Script): **`scripts/carrom-geometry.ts`** — every constant from §3/§4,
`rackLayout(): {kind, x, y}[]`, `pockets: {x,y}[]`, `sweepCircle(origin, dir, radius, discs, fieldHalf) → {t, point, hitDisc | 'cushion', normal} | null`
(ray vs circles of radius `radius + disc.r` and vs the AABB inset by `radius`), `freeSpotNear(x, y, discs)`
(hex spiral), `clampForwardCone(dir, shooter)`.

### `user:GameController` — on `GameRoot` — owns the state machine and every rule

```
AIM ──(human release ≥ minPower)──▶ SHOOT ──(1 frame)──▶ SIMULATE ──(settled)──▶ RESOLVE ──▶ NEXT_TURN ──┬──▶ AIM (human)
AI_THINK ──(0.9 s, AI picked a shot)──▶ SHOOT                                                          └──▶ AI_THINK (AI)
RESOLVE ──(win)──▶ GAME_OVER ──(Play again / Restart)──▶ rack reset ──▶ NEXT_TURN
```

Responsibilities: spawn/despawn the rack (19 instantiates, then one-frame wait), striker
placement per shooter (`body.teleport(x, ±346)` + `setVelocity(0,0)` + `visible = true`), pocket
detection every `onUpdate` in SIMULATE (distance ≤ 28 to any pocket → man: record + `queueFree()`
+ pocket juice; striker: record foul, `visible=false`, `teleport(0, −1200)`), the constant
deceleration + stop snap over all live discs, settle detection (§4), the RESOLVE table (§2),
returns to centre (`freeSpotNear` + instantiate), HUD text (`Label2D.setText`), banners/toasts,
`Restart`/`PlayAgain` (`connect('click', …)` — `UIControl2D` emits `pressed`, `released`,
`click`; use `click`), first-contact hitstop + shake (listens to `contact-started` on the striker
node; **edge-triggered, once per strike**), `scene.commands` + `registerGameDebug` (see §10).

Inspector config (`static getPropertySchema`): `aiEnabled: boolean = true`,
`aiDifficulty: number = 0.6` (0..1), `settleHoldSec = 0.35`, `settleTimeoutSec = 8`,
`decelPxPerSec2 = 220`, `stopSnapSpeed = 6`, `hitstopMs = 40`, `bannerSec = 0.9`.

Public API used by the other scripts: `requestShot(dir: {x,y}, power: number): boolean` (only
in AIM / AI_THINK), `placeStriker(x: number)` (clamped ±240; only in AIM), `state`, `shooter`,
`getDiscs(): Disc[]`, `strikerBody`.

### `user:ShotInput` — on `GameRoot` — the human gesture

Reads `this.input.pointerEvents` (`{type:'down'|'move'|'up'|'cancel', pointerId, x, y}` in
canvas px) and converts with `this.scene.getPointer2DWorldPosition(pointerId)` (2D world =
board px, y up). Ignores input unless `GameController.state === 'AIM'` and the shooter is human;
ignores a pointer for which `input.isPointerOverUI(pointerId)` is true (so the Restart button
wins). Owns exactly one pointer at a time (first `down` wins; others ignored).

- **Down** anywhere inside the board square (|x|,|y| ≤ 500) starts a gesture; record `down`
  world point and whether it is within `STRIKER_R + 18` of the striker (`nearStriker`).
- **Mode lock** at the first `move` with `|Δ| > 12 px` from the down point:
  `SLIDE` if `nearStriker && |Δx| > 2·|Δy|`, otherwise `AIM`. The mode never changes for the rest
  of the gesture.
- **SLIDE:** each move → `placeStriker(pointer.x)` (clamped to [−240, 240]); striker follows
  the finger via `teleport`. Release → nothing else.
- **AIM:** pull vector `P = pointer − strikerPos`. `dir = clampForwardCone(−normalize(P))`
  (forward cone: the shot's y must be ≥ +0.12 for the human, i.e. within ±83° of straight up;
  pulls outside it are clamped to the cone edge and the guide turns red). `power =
  clamp((|P| − 20) / 260, 0, 1)`. Each move → `AimGuide.show(strikerPos, dir, power, preview)`
  and `PowerBar.value = power`, `PowerBar.visible = true`.
- **Release (`up`)** in AIM: `power < 0.08` → cancel (hide guide); else
  `GameController.requestShot(dir, power)`. `cancel` event → always cancel.
- Also pull-anywhere is what makes the 52 px striker usable under a thumb.

### `user:AimGuide` — on `AimGuide` — presentation only

`show(origin, dir, power, preview)`: `preview = sweepCircle(origin, dir, STRIKER_R, discs)`;
places the 12 `Dot*` sprites every 28 px from `origin + dir·(STRIKER_R+8)` up to
`min(preview.t, 520)` (surplus dots hidden); colour lerp `#38bdf8 → #f43f5e` by power;
`RubberBand` = `ColorRect2D` stretched to `|P|clamped` (set `height`) and rotated to point along
the pull, opacity `0.3 + 0.7·power` (no `Line2D` exists — **engine gap #4**); `Ghost` at
`preview.point` when the hit is a disc; `Deflect` = 80 px rect from the struck disc centre along
`normalize(disc − preview.point)`. `hide()` sets `visible=false`.

### `user:CarromAI` — on `GameRoot` — picks Black's shot

Called by `GameController` on entering `AI_THINK`; returns `{x, dir, power}` synchronously.
Candidates: for each striker x in `{−240, −180, …, 240}` (9) × each black man (+ Queen when AI has
≥ 1 man pocketed) × each pocket: ghost point `G = man + normalize(man − pocket)·(STRIKER_R+MAN_R)`;
require `sweepCircle(S→G, STRIKER_R)` to reach `G` unobstructed and `sweepCircle(man→pocket, MAN_R)`
to be clear; score `= cos(angle between (G−S) and (pocket−man))^2 · (1 − dist(man,pocket)/1200)`;
choose the max; `dir = normalize(G − S)` + Gaussian noise `σ = (1 − difficulty)·2.5°`; `power =
clamp(0.35 + dist(S,G)/1400 + dist(man,pocket)/2200, 0.3, 0.95)`. **Fallback** (no clear pot):
aim at the nearest black man's centre with power 0.45 (guarantees contact). Uses the same
geometry module as the guide, so what the AI "sees" is what the player sees.

### `user:Disc` — on the striker and every man prefab root — tag + contact SFX

`config.kind: 'white'|'black'|'queen'|'striker'` (select). On `onStart` connects
`contact-started` on its own node; stores `lastVx/lastVy` each `onUpdate` from
`physics2d.getBody(node)`. Handler `(other)`: dedupe by `this.node.id < other.id`; impact speed
= `|v_prev(self) − v_prev(other)|`; cushion (other has no body) → `scene.audio.sfx('bounce',
{volume: clamp(speed/1800, 0.05, 0.8), pitch: 0.8 + random·0.2})`; disc → `sfx('tap', {volume:
clamp(speed/1600, 0.08, 1), pitch: 1.1 + random·0.25})`. Ignore contacts below 60 px/s. (No
impulse/normal in the payload — **engine gap #6**.)

### `user:StrikerTrail` — on `Striker` — ghost trail

Every 40 ms while striker speed > 300 px/s: take the next of the 8 `Trail/Ghost*` sprites,
`teleport`-free (plain `position.set`), `opacity = 0.35`; every frame decay each ghost's opacity
by `dt / 0.3`. (No 2D trail renderer — **engine gap #5**.)

Signals / engine APIs used, in one place: `scene.instantiate`, `node.queueFree`,
`scene.physics2d.{setGravity,getBody}` + handle `{velocityX, velocityY, isSleeping, setVelocity,
teleport, wake}`, `contact-started`, `Label2D.setText`, `Bar2D.value`, `UIControl2D 'click'`,
`scene.time.{hitstop, slowMotion}`, `scene.juice.{shake, burst, floatText, punchScale, flash}`,
`scene.audio.sfx`, `node.emit('bump'|'show')` into `core:PunchScale`/`core:PopIn`,
`scene.commands.register/dispatch`, `registerGameDebug`, `input.pointerEvents`,
`input.isPointerOverUI`, `scene.getPointer2DWorldPosition`.

---

## 7. Art plan

Decision: **no AI-generated art in the base milestones.** The board's value is exact line work
at exact coordinates, which a generator cannot promise and which physics depends on; discs are
flat colour with a ring. All PNGs are produced by **one offline HTML page**
`samples/Carrom/design/bake-board-art.html` that draws with canvas 2D from the §3 constants
(copy the numbers; the page has no imports) and downloads: `board.png` 2000×2000 (2× for
crispness; the Sprite2D is 1000×1000), `man_white.png`, `man_black.png`, `queen.png`,
`striker.png`, `striker_ring.png` (all 128×128), `dot.png` 32×32. Save into
`samples/Carrom/sprites/`. This keeps the editor viewport, the atlas and the export all working
(a runtime `CanvasTexture` via `Sprite2D.setTexture` was considered and rejected: it only shows
in play mode, so the editor board would be blank).

Palette (from the reference photo):

| Element                 | Hex                                            |
| ----------------------- | ---------------------------------------------- |
| Cloth (radial gradient) | centre `#1e5fd6` → mid `#1a4fb8` → edge `#132f75` |
| Frame wood              | `#4a2a12` → `#2e1708` gradient, 2 px inner bevel `#6b3f1d`, highlight `#8a5a2b` |
| Pocket hole             | `#07090f`, rim `#8e99a8` 4 px, inner `#020409`  |
| Line work               | `rgba(255,255,255,0.55)`, 3 px (baselines 3 px, rings 2.5 px, arrows 3 px) |
| Base circles / centre   | fill `rgba(230,57,70,0.38)`, stroke white 55 %  |
| White man               | body `#f3e9d2`, edge `#b89a6a`, inner ring `#c9b283` |
| Black man               | body `#23201d`, edge `#5a5049`, inner ring `#6e6259` |
| Queen                   | body `#c8202f`, edge `#f5ae39`, centre dot `#ffd166` |
| Striker                 | body `#f7f3ea`, rim `#0284c7` 3 px, inner ring `#0ea5e9`, hub `#0284c7` |
| Guide                   | dots `#38bdf8` → `#f43f5e`; rubber band `#f43f5e`; ghost 40 % |
| HUD                     | panels `#14100d`/`#1b1410`, text `#ffffff`/`#cfc6b8`, accent `#f5ae39`, foul `#ff6a5a` |

Optional polish milestone only: a generated wood-frame overlay (`frame_wood.png`, 1000×1000
with transparent centre) via the Sprite Editor — the one element where generated texture
beats a gradient.

Fonts: default (`Arial`), no font assets. Audio: **no assets** — all `scene.audio.sfx` presets.

---

## 8. Game-feel checklist → engine system

| Beat                                  | Trigger                                  | Engine call                                                                                                     |
| ------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Shot release                          | `requestShot` accepted                   | `scene.juice.punchScale(striker, {scale: 1.12})`, `sfx('tap', {volume: 0.5+0.5·power, pitch: 0.9})`              |
| First contact hitstop                 | striker `contact-started`, first per strike | `scene.time.hitstop(40)` (edge-triggered — never per frame)                                                  |
| Impact shake                          | same, if impact speed > 600              | `scene.juice.shake('camera2d', {amplitude: clamp(speed/400, 2, 8), duration: 0.18, frequency: 26})`             |
| Clack / cushion thud                  | every `contact-started` (deduped)        | `sfx('tap')` / `sfx('bounce')` with speed-scaled volume + pitch variation (`user:Disc`)                          |
| Pocket                                | capture                                  | `sfx('score', {pitch: white? 1.0 : 0.85})`, `juice.burst({x,y}, {count: 18, speed: 240, colors: [body, edge, '#ffffff'], sizePx: 8, gravityY: 0, lifeSec: 0.45})`, `juice.floatText('+1', {at: {x,y}, color, fontSizePx: 44, glow: true})`, `PlayerLeft/OpponentLeft.emit('bump')` |
| Queen pocketed                        | capture of `queen`                       | `scene.time.slowMotion(0.35, {durationMs: 450, blendMs: 80})`, `sfx('powerup')`, golden burst `count: 40`, `QueenStatus.setText(...)` |
| Foul (striker pocketed)               | RESOLVE                                  | `sfx('lose', {volume: 0.6})`, `scene.juice.flash({color: '#ff3b30', intensity: 0.25, durationSec: 0.25})`, `Toast.setText('Foul — striker pocketed. One man returned.')` + auto-clear after 1.8 s |
| Turn banner                           | NEXT_TURN                                | `TurnBanner.setText('YOUR TURN' / 'BLACK TO PLAY')`, `TurnBanner.emit('show')` → `core:PopIn`; `sfx('tick')`    |
| Striker trail                         | speed > 300                              | `user:StrikerTrail` ghosts (additive blend)                                                                     |
| Return to centre                      | RESOLVE returns                          | `juice.popIn(newMan)` on each returned man                                                                      |
| Win / lose                            | GAME_OVER                                | `sfx('win'|'lose')`, three `burst`s at the winner's HUD label, `EndOverlay.visible = true` (Panel `core:PopIn playOnStart`) |
| Idle hint                             | AIM for > 4 s with no pointer down       | `HelpLabel` opacity pulse via `scene.juice.punchScale(HelpLabel, {scale: 1.05})` every 2 s                      |

---

## 9. Build order (each milestone ends in something checkable in the running editor)

**M0 — Project skeleton + art bake.** `samples/Carrom/pix3project.yaml` (copy CanonGame's, set
`projectType: 2d`, `targetPlatform: mobile`, `textureFiltering: linear`, `projectName: Carrom`),
`design/bake-board-art.html`, all PNGs in `sprites/`, `scripts/carrom-geometry.ts`. Verify: the
project opens; `board.png` is 2000×2000.

**M1 — Board renders + one striker can be flicked and stops.** `scenes/main.pix3scene` with
GameRoot, Camera2D, Board (art, cushions, pockets, Striker), AimGuide, and an empty HUD;
`user:GameController` in a reduced form (states AIM/SHOOT/SIMULATE only, striker placement,
decel + stop snap, settle → back to AIM), `user:ShotInput`, `user:AimGuide`. Verify (§10-M1).

**M2 — Rack, pockets, pocket juice.** Three prefabs, `user:Disc`, rack spawn on start,
pocket detection, `queueFree`, contact SFX, burst/floatText, counts in the HUD. Verify (§10-M2).

**M3 — Rules + turn loop + HUD (hot-seat: both sides human).** Full state machine, RESOLVE
table, Queen/cover, fouls, dues, returns to centre, banners, toasts, Restart, EndOverlay,
`scene.commands` + `registerGameDebug` incl. `layout` action. Verify (§10-M3).

**M4 — AI opponent.** `user:CarromAI`, AI_THINK timing, `aiEnabled` toggle, auto-play debug mode
(both sides AI) for soak. Verify (§10-M4).

**M5 — Feel pass.** Hitstop, shake, Queen slow-mo, trail, banner PopIn, end-screen bursts, idle
hint, guide colours. Verify (§10-M5).

**M6 (optional).** Generated wood-frame overlay; single-file HTML export; check export size and
that `bullet`/physics behave identically in the exported player.

---

## 10. Verification plan (state, not screenshots)

Everything below is read through the editor's `window.__PIX3_DEBUG__` (see the
`debug-running-game` skill) and the game's own `registerGameDebug` provider, driven by
`scene.commands`:

- Commands: `restart`, `shoot {angleDeg, power}` (angle in board space, 90 = straight up),
  `place-striker {x}`, `settle` (force-stop), `layout {discs: [{kind, x, y}], striker?: {x}, shooter?: 'white'|'black'}` (clears the board and places exactly these — the rule-test harness), `ai.toggle {enabled}`, `autoplay {enabled}` (AI plays both sides).
- Snapshot: `{state, shooter, whiteLeftOnBoard, blackLeftOnBoard, whitePocketed, blackPocketed, due:{white,black}, queen: 'board'|'pending-cover:white'|'covered:white'|…, discs:[{id, kind, x, y, vx, vy, speed, sleeping}], striker:{x,y,vx,vy,visible}, lastStrike:{contacts, pocketed:[kind…], foul, keptTurn}, kineticEnergy, timeScale, settleTimerSec}`.

**Global invariants (assert on every snapshot in every milestone ≥ M1):**

1. **Containment:** for every visible disc `|x| ≤ 440 − r + 2` and `|y| ≤ 440 − r + 2`
   (2 px slop = solver position-correction cap is 4 px per iteration, but a resting disc must
   be inside the slop).
2. **Conservation of pieces:** `whiteLeftOnBoard + whitePocketed + returnedThisStrike(white) = 9`,
   same for black; exactly one `queen` disc exists on the board **or** `queen` is
   `pending-cover`/`covered`.
3. **Energy:** sampled every 100 ms during SIMULATE, `KE(t+100ms) ≤ KE(t) · 1.005 + 0.5`
   (KE = Σ ½ m v²; the 0.5 % tolerance covers Baumgarte bias). The only allowed increase is
   the SHOOT frame.
4. **Settling:** every strike reaches RESOLVE within **6 s** of SHOOT (target 2–4 s); at RESOLVE
   every disc has `speed === 0` and, 0.5 s later, `sleeping === true`.
5. `timeScale === 1` outside a hitstop/slow-mo window; never 0 for more than 60 ms.

**M1:** `place-striker {x: 200}` → striker `x === 200`, `y === −346`. `shoot {angleDeg: 90,
power: 1}` → striker `vy ≈ 2200` on the next frame; it hits the top cushion (`lastStrike.contacts
≥ 1`) and `y` never exceeds `414`; RESOLVE in ≤ 4 s; final `speed === 0`. `shoot {angleDeg: 270,
power: 0.5}` (backwards) is refused (`state` stays AIM) — cone clamp works. Gesture test via
chrome-devtools `drag` on the canvas: a horizontal drag over the striker moves `striker.x` and
leaves `state === 'AIM'`; a diagonal drag ending 200 px below shows `AimGuide.visible === true`
during the drag and produces a shot on release.

**M2:** after `restart` the snapshot lists 19 men whose `(x, y)` equal `rackLayout()` within
0.5 px, 9 white / 9 black / 1 queen. `layout {discs:[{kind:'white', x: 380, y: 400}], striker:{x: 100}}` then `shoot` straight at it → `lastStrike.pocketed === ['white']`, the disc is gone from
`discs`, `whitePocketed === 1`. A `layout` that puts a man at `(419, 419)` is pocketed within 1 s
without a shot (capture radius sanity). A man placed at `(0, 0)` and a striker shot at power 1
never produces `contacts === 0`.

**M3 rule scenarios (each = `layout` + `shoot` + wait for RESOLVE, then assert):**

- own man potted → `keptTurn === true`, `shooter` unchanged;
- opponent's man potted → `blackPocketed === 1`, `keptTurn === false`;
- striker into pocket with a white man also potted → `foul === true`, `whitePocketed === 0`, a
  white man exists near `(0,0)` **and** a second white man returned (or `due.white === 1` when
  none pocketed before);
- queen potted alone → `queen === 'pending-cover:white'`, `keptTurn === true`; next strike pots
  nothing → `queen === 'board'`, a queen disc is back within 41 px of `(0,0)`, `shooter === 'black'`;
- queen + own man same strike → `queen === 'covered:white'`;
- last white man potted with queen on board → man returned, `whiteLeftOnBoard === 1`;
- 9 white pocketed with queen covered → `state === 'GAME_OVER'`, `EndOverlay.visible`, score
  `= blackLeftOnBoard + 3`.
- Restart button `click` (drive via `invokeInteraction` or a real tap) → 19 men, `state === 'NEXT_TURN'` then `AIM`, `shooter === 'white'`.

**M4:** with `autoplay {enabled: true}` run 20 AI strikes: `contacts ≥ 1` on ≥ 95 % of them;
a full autoplay game reaches `GAME_OVER` in < 5 min with no invariant violation; `aiDifficulty 1.0`
pots on ≥ 40 % of strikes from the standard rack, `0.2` on ≤ 25 %.

**M5:** after a full-power `shoot` into the rack the snapshot shows `timeScale === 0` for one
sample within 100 ms of the first contact and `1` afterwards; the Queen capture shows
`timeScale ≈ 0.35` for ~0.45 s; `Trail/Ghost*` opacities are > 0 during flight and all 0 within
0.5 s after settle; `TurnBanner.label` alternates `'YOUR TURN'`/`'BLACK TO PLAY'`. Screenshot only
the board rectangle, only to eyeball the guide and pocket burst.

---

## Engine gaps found while designing (feed to the tooling review)

1. **No Coulomb / constant rolling friction on `core:PhysicsBody2D`** — only exponential
   `linearDamping`. Sliding discs on cloth stop crisply in reality; scripts must hand-apply a
   constant deceleration and a stop snap each frame. Godot has `linear_damp` only too, but a
   per-body "rolling resistance" would remove ~20 lines of game code from every top-down
   sliding game (air hockey, shuffleboard, curling, pinball ball on a slope).
2. **Restitution combines as `max`** — a cushion cannot be less bouncy than the discs; Box2D
   uses `max`, Godot uses the "mix" mode of the colliding body; a `combineMode` per collider
   would fix it.
3. **CCD (`bullet`) sweeps only against static geometry** — no dynamic–dynamic sweep, so fast
   grazes between two small circles can be missed; forces a launch-speed cap.
4. **No vector primitive node** (`Line2D` / `Polygon2D` / `Circle2D` / dashed line) — the aim
   guide is a sprite pool + rotated `ColorRect2D`; exact line art must be baked to a PNG offline
   (no `CanvasTexture` node that also renders in the editor viewport).
5. **No 2D trail / ghost renderer** (`Particles3D` has trails; nothing 2D) — scripts pool
   sprites.
6. **Contact signals carry only `(otherNode)`** — no contact point, normal, or impulse; SFX
   intensity and shake amplitude are estimated from previous-frame velocities.
7. **No shape cast** — `physics2d.raycast` is a zero-width ray; the aim preview and the AI do
   their own analytic circle sweep.
8. **Sleep thresholds and latency are fixed constants** (4 px/s, 0.5 s) — settle detection has
   to be re-implemented in game code to get a sub-0.5 s response.
9. **Unverified: does assigning `Sprite2D.texturePath` at runtime trigger a texture load?**
   The setter exists but the loading path was not traced; the spec sidesteps it with three
   prefabs. Worth a one-line doc statement either way.
10. **Circle sensor semantics** are overlap-based, so a "pocket" sensor fires on a grazing
    edge; centre-containment pockets are a script distance check. A `containment` mode on
    sensors (or a `body-fully-inside` signal) would make pockets/goals declarative.
11. **Restitution threshold (40 px/s) is global** — fine here, but a soft "dead cushion" would
    want it per material.
