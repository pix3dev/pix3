# Release-v15 data (extracted from `noAds.swf`)

The dev build's `mobs.xml`/`conf.xml` (in `../`) only had **3 levels** — missions
4-30, the boss configs and the enemy stat table were loaded from a server at runtime
(`xmlLoader_cf`/`xmlLoader_ms`) and never survived in the source archive.

This folder is that missing data, recovered from the **final release build**.

## Provenance

- **Source:** `C:\GameDevAssets\…\SD\sub_folder2\sub_folder2\noAds.swf` (16.7 MB, Feb 2012,
  document class `cannon_game_v15`). The two siblings `skydefender_v15.swf` and
  `skydefenderjoesstory_d.swf` embed byte-identical data.
- **How:** the release build ships the config **embedded as E4X XML literals** inside
  `com.MainTimeline` (a 1.26 MB decompiled class — that's what the size is), as a
  local fallback for the server load. Decompiled with FFDec, class names are **not
  obfuscated** in this build (unlike `cannon_game_v10.18`). Blobs lifted verbatim and
  pretty-printed; every file re-parses as valid XML.
- The build embeds three data sets: **set1 ≡ set3** (the canonical **30-level** campaign,
  saved here) and **set2** (a **40-level** variant — later/extended tuning, kept as
  `campaign-40-levels.waves.xml` for reference). `map-dialogues.xml` is the campaign-map
  text (59 nodes: intro + per-mission narration).

## Files

| File | What |
|---|---|
| `campaign-30-levels.waves.xml` | Canonical campaign: 30 `<Lvl>`, 1574 `<Mob>` spawns (`t`/`id`/`y`/`a`/`tip`/`dop`/`com`) |
| `campaign-30-levels.summary.md` | Human-readable per-level breakdown (time limit, spawn count, unit mix, boss/ground/npc flags) |
| `campaign-40-levels.waves.xml` | 40-level variant set (1676 spawns) |
| `conf.xml` | Full balance: `<DMG>` (weapon L1/L2), `<AMMO>`, `<TRS>` (turrets), `<Shop>` (24 prices), `<TIMELEVEL>` (per-level sec), `<ZHILKI>` (wall HP), `<EWETEG>` (sheep/mineman), and the **84-entry `<Mob>` stat table** (hp/speed/dmg/score) |
| `mission-positions.xml` | The `<Mission>`→`<p>` flat array indexed by `xmlMS[n]` (NPC/quest aim points, spark positions) |
| `map-dialogues.xml` | Campaign-map narration text per level |
| `unit-table.md` | Derived: `id → AS3 class → category → stats` join |

## Unit id → class

`FN_addMob(id,…)` maps **spawn-id → class** by `id-1` (a switch), and stats via
`MobGetHp(id-1)` etc. over the config `<Mob>` table (filled in id order), so **spawn-id N
= config `<Mob id="N">`**. Anchor check: id 33 = class `S_SS`, hp 50 = the basic "S"
fodder balloon (matches the dev build's "27× S" opener). See `unit-table.md`.

Class *names* are the airframe art (`Slevin_2`, `Avalon1_3`, …); they do **not** imply the
dev-era stats — the same airframe is re-tuned across levels via the config table.

Rough id bands: **1-29** air (Lucky/Slevin bombers, Avalon/Lavalon gunships, NZ/SUC
rank-and-file) · **30-34** "S" support balloons · **35-42** `Unik_*` + **43-48** `Urik_*`
compound (body/ropes/gondola) · **49-62** ground vehicles (`G*` — drive the bridge) ·
**63-74** NPC/quest (`MTurik`, `MFargo`, `MWife`, `MBob`, `MEngin`, `MZombee`, **`MSheep`**,
`MGold`, `MPolicek`, `MFargoWar`) · **75-84** bosses.

> `G?(57/60/61)` in the table = ground slots where the decompiler dropped the `new` op;
> the raw wave XML is authoritative for what actually spawns.

## Bosses

Bosses land on **every 5th level** (levels 5/10/15/20/25/30, all `TIMELEVEL=300` → no timer):

| Lvl | Boss id → class | notes |
|---|---|---|
| 5 | 76 `Boss2a` | |
| 10 | 77 `Boss2b` + 78 `Boss3` | |
| 15 | 79 `S_Xenon` + 80 `Boss5` | |
| 20 | 82 `Bear` + 83 `Boss6` | |
| 25 | 81 `Boss4` | |
| 30 | **84 final boss** (40000 hp, score 3000) + escort | `king_strike`/`FN_final` ending |

`Boss1` (id 75, 1200 hp) is a mini-boss used mid-level, not a level-ender.
Art: each `BossN` loads embedded symbols `B_bossN` (+`B_bossN_w` white-flash overlay);
`Bear` uses `B_bear`; `S_Xenon` its own. These correspond to the boss PNG folders
(`textures/enemy/bosses/` baby/grafz/rud/snake/xenon).

### Boss behavior (from `com.enemy.Boss*`, e.g. `Boss6`)

- **Fly-in → hold:** advances left until `x <= xx`, then holds and **bobs on a sine**
  (`x = xx - sin(t)*4`).
- **Emplacement guns:** carries several `BigGunBoss` weapons as child slots (Boss6 has 3:
  `d3/d4/d5`). An `rld` counter fires them in a **round-robin every 5 ticks** via
  `FN_MobStrike(this, angle, type, gunIndex)`.
- **Vulnerability window (`uyaz`):** the boss is only damageable during the barrage
  window (`uyaz=true` at rld 5, `false` at rld 80) — "destroy by key points" = shoot the
  guns/slots while exposed.
- **Hit feedback:** `white` overlay (`B_boss*_w`, alpha 0.7) flashes on hit; HP bar is the
  shared `palka.hpbossa` status bar.
- **Death = signature multi-detonation:** `kill()` calls **`FN_addBumbumZep(this, size,
  childIndex)`** — the chained nose→tail zeppelin explosion + global BlowGlow, and drops
  the gun sprites. The zeppelin falls slowly/majestically (GDD pillar #1).
- **Final boss (id 84):** at `hp < 400` fires `FN_final()` and sets `king_strike` — the
  scripted King finale rather than a normal kill.
