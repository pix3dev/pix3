# Sky Defender v15 — campaign structure, objectives, modes

Facts recovered from `noAds.swf` (`cannon_game_v15`). **Authoritative source = the wave
`<Lvl>` data** (what actually spawns). Where a claim is inferred, it says so.

## Mission names (authoritative — `ar_disc` array in MainTimeline)

30 names, matches the GDD `mission-names-en.txt` (minor spelling: "Dragon's Rag", `"Mario"`
and `"As good as Mozart"` are quoted in-game):

1 Prologue · 2 On Guard · 3 Royal Treasury · 4 Enemy At the Gate · 5 I need to go ·
6 Touchy Issue · 7 A Steak · 8 Shopping · 9 Royal Gold 2 · 10 Another Business Trip ·
11 Lemmings · 12 Problems Start I · 13 Problems Start II · 14 Problems Start III ·
15 The Real Fargo · 16 Apples of Hesperides · 17 "Mario" · 18 I'll Make You Rich ·
19 Echo of War · 20 The Crucial Point · 21 The Golden Train · 22 "As good as Mozart" ·
23 Pull Devil! · 24 Pull Devil! II · 25 Dragon's Rag · 26 Earl Furious ·
27 That Damned King · 28 Near Go · 29 Prelude · 30 A Quick Mare Is In Time Everywhere

Regions (`arRegions`): Grekon, Nyork, Magelan, Unicorn, Lisolan, Montarg.

## Story / special missions (grounded in wave-`<Lvl>` NPC spawns)

The special mechanics use "quest" NPC units (ids 63-74). These are the levels where they
actually appear in the campaign wave data, matched to their objective text (`arOpiska`):

| Lvl | Quest NPC(s) | Objective (verbatim, `arOpiska`) |
|---:|---|---|
| 3 | `MFargo` (64) | "Protect the ship during the negotiations." (Fargo paid 200 Gold advance) |
| 6 | `MWife` (65) | "Your wife have gone shopping. You need to cover her take off and return." |
| 7 | `MGold` (71) | "Defend the gold mine from enemies. Don't let them steal the gold." (repair reward) |
| 8 | `MBob` (66) | shopping/escort variant |
| 9 | `MLuckyGold` (72) | "Stop the pillage. Shoot off the stolen gold bars into the boat — keep ≤3." |
| 11 | `MSheep` (70) + `MZombee` (69) | "Save the sheep! At least 5 must survive — shoot them so they fall in the 'cup'." |
| 14 | `MTurik` (63) | |
| 17 | `MLucky` (68) | |
| 19 | `MEngin` (67) | "Protect the workers repairing the old defense system. Repair at least two turrets." |
| 21 | `MPolicek` (73) | "Shoot the cones off so they fall in the trucks. Fargo asks for 10." (Golden Train) |
| 22 | `MFargoWar` (74) | "Battle after battle. Destroy them all." |
| 23 | `MTurik` (63) | |

> The bare `arOpiska` push-order does **not** align 1:1 with `<Lvl>` numbers, so the pairing
> above is by NPC-in-wave (authoritative) + objective content, not by array index. Full
> objective texts (incl. the hypnosis / "something lures people from the castle" and the
> per-region "kick the enemy out" / "destroy the boss, conquer the region" goals) are in
> `mission-objectives.txt`.

## Bosses per level

Every 5th level (all `TIMELEVEL=300`): L5 Boss2a · L10 Boss2b+Boss3 · L15 S_Xenon+Boss5 ·
L20 Bear+Boss6 · L25 Boss4 · L30 final boss (id 84). See `README.md`.

## Enemy behavior: park-and-shoot (`a` = attack-x)

The `<a>` field is the **x the unit flies to and then holds, bombarding from there** (640-wide
coords; castle is on the left, so small `a` = parks close to the castle). `a=0` = flies
straight through to ram/breach the castle (kamikaze). This is **pervasive**, not special —
most air units from Lvl 2 on have `a>0` and become stationary gunships once they reach it
(Avalon/Lavalon canonnades, Unik/Urik gondola guns, and even rank-and-file NZ/SUC/Slevin).
Behavior in `com.enemy.*`: unit advances while `x>xx`, sets `att`, then fires on an `rld`
reload cadence toward the castle. The remaster currently only parks the canonnade types.

## Modes (authoritative — code path)

- **Campaign** = `game_tip==0`, loaded by `FN_start_company()` → the **30-level** set
  (`campaign-30-levels.waves.xml`).
- **Survival** = `game_tip==1`, loaded by `FN_btnMClick2()` → the **40-level** set
  (`campaign-40-levels.waves.xml`). Survival waves are **fully predefined** (not procedural):
  it plays Lvl 1..40 of set2 with a lives counter (`surv_zh`) and award checkpoints at waves
  16 and 31; objectives read "Survive in 10 / 20 / 30 waves".
  - **Survival Lvl 1 opens** with `S_SS` (id 33) fodder streaming in at `a=0` **plus
    `Lucky_1` (id 1) bombers that park at `a=150-200` and bomb from the left** — i.e. the
    predefined opening the remaster's procedural `startSurvivalWave` does not reproduce.
