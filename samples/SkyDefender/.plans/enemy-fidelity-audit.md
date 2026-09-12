# Enemy fidelity audit — verified diagnosis + fix spec (no code changed)

Scope: why campaign level 1 (and many others) spawn the wrong prefab / wrong
composition / wrong order compared to the original Flash release
(`design/noAds.swf`, doc class `cannon_game_v15`). Everything below was
re-derived from the SWF with FFDec 26.2.1 (`ffdec-cli.exe -selectclass … -export
script|pcode`, `-export image|sprite|symbolClass`). Decompiled sources and
intermediate tables live in the session scratchpad; the quotes below are verbatim
from those exports.

Evidence key: `MT` = `com.MainTimeline` (decompiled AS), `MT.pcode` = same class as
P-code, `E/<Class>` = `com.enemy.<Class>.init()`, `XML` =
`design/original-data/release-v15/campaign-30-levels.waves.xml`.

---

## 0. Level 1 in one picture

Original (`XML` Lvl 1, sorted by `t`; `FN_addMob` maps id→class as in §A):

| t (s) | id | class (corrected) | what the player sees |
|---:|---:|---|---|
| 7 | 53 | **GBaron** | orange box-body truck, ladder, **fat mortar barrel** (`B_gun`) on `TypGunMob`, 2 bouncing wheels |
| 10 | 25 | **NZ_5** | orange asterisk gasbag (`B_NZ`) with a **burning stone bomb** hung under it (`Stoneb` + `Burn1` flame + `Littlebg` glow) — no basket, no gun |
| 15,17,17 | 4 | Slevin_2 | fire bomber (already right in the remaster) |
| 20 | 25 | NZ_5 | second burning-bomb zeppelin |
| 25,27,27 | 4 | Slevin_2 | |
| 37 | 18 | **Lavalon2_2** | Lavalon2 hull carrying **2× `Stoneb`** bombs (com "Bomber") — not a basket gun |
| 37 | 40 | **Unik_6** | an **airplane** (`B_unik_nd`) with a `TypGun` (com "ATS") — not a rope-hung balloon |
| 40,40 | 4 | Slevin_2 | |

Remaster today: `t=10 NZ` renders `nz.pix3scene` (basket + gun) → the "zeppelin with
a gun and a strange gondola"; the truck comes **after** the bridge finishes and is
`bb.pix3scene` (`GBB` = the yellow "TV" truck, no gun). Both halves of the user's
complaint are reproduced by the evidence below.

---

## 1. Verdicts per suspicion

### A — "the ground band of the id→class switch is off by one" → **CONFIRMED (ids ≥ 50 are shifted by one; id 49 is dead)**

`FN_addMob` is a two-stage switch. Stage 1 turns the spawn id into a 0-based index
(`MT` lines 4919–5236). It is `id − 1` only up to 48:

```
case 44: §§push(43); break;
default:
   §§push(45); §§push(_loc12_); … if(§§pop() === §§pop()) { §§push(44); break; }   // id 45 → 44
   switch(_loc12_) {
      case 46: §§push(45); …  case 47: §§push(46); …  case 48: §§push(47); …
      case 50: §§push(48); …  case 51: §§push(49); …  case 52: §§push(50); …
      case 53: §§push(51); …  case 54: §§push(52); …  case 55: §§push(53); …
      case 56: §§push(54); …  case 57: §§push(55); …  case 58: §§push(56); …
      default: §§push(59); … if(…) { §§push(57); }                                // id 59 → 57
      case 60: §§push(58); case 61: §§push(59); … case 63: §§push(61); … case 73: §§push(71);
      default: §§push(74) … { §§push(72) }  case 75: §§push(73); … case 84: §§push(82);
      default: §§push(83);
```

There is **no `case 49`**: from id 50 upward every id maps to `id − 2`; id 49 (and
anything unlisted) falls to `push(83)`, which has no constructor case, so `_loc6_`
stays `null` and the next line `_loc6_.id = _loc8_` throws. The campaign never
spawns id 49 (histogram: 0), so that is harmless in practice.

Stage 2 (`MT` lines 5238–5811) is the constructor list, in this order:

```
case 48: new GAtabus()   case 49: new GAtaban()   case 50: new GBaka()
case 51: new GBaron()    case 52: new GBB()       case 53: new GBus()
case 54: new GDream()    case 55: new GDreamer()  case 56: (no constructor)
case 57: (no constructor)  case 58: new GMedic()  case 59: new GRracer()
case 60: (no constructor)  case 61: new GWarchild()
case 62: new MTurik()  … case 73: new MFargoWar()
case 74: new Boss1() 75: Boss2a 76: Boss2b 77: Boss3 78: S_Xenon 79: Boss5 80: Boss4 81: Bear 82: Boss6
```

So **id 53 → case 51 → `GBaron`**, the cannon truck. `unit-table.md`,
`SdV15.ts` `V15_UNITS` and `SdBalance.ts` `ART`/`buildUnit` all assume `id − 1`
across the board and are therefore wrong for every id ≥ 50.

Stats are *not* shifted: the tail of `FN_addMob` uses `_loc8_ = param1 - 1`:
`_loc6_.max_hp = this.MobGetHp(_loc8_); … _speed = MobGetSpeed(_loc8_); dmg = MobGetDmg(_loc8_); scr = MobGetScore(_loc8_);`
→ the `conf.xml` `<Mob id=N>` row still belongs to spawn id N. Only the class/art column moves.

Three independent confirmations that the ground band is 50–63 (not 49–62):

1. `MT` (same function): `if(param1 >= 50 && param1 <= 63) { _loc6_.y = 380; }` — the deck height is forced exactly for ids 50–63.
2. `MT`: `if(param1 == 64 || … 65 || 66 || 67 || 68 || 75) { x = aim_x1; y = aim_y1 … }` — NPC aim-point setup for ids 64–68 and 75 = `MTurik, MFargo, MWife, MBob, MEngin, MFargoWar` under the corrected mapping (under the old one 75 would be `Boss1`, which has no aim points). `if(param1 > 75) x = 820` (bosses start at 76) and `if(param1 == 84) x = 950`; `if(param1 == 79 || param1 == 81)` uses `aim_y1` — only `Boss3.as` and `Boss5.as` declare `aim_y1`, and those are ids 79/81 under the corrected mapping.
3. The wreck table: every `G*.kill()` calls `FN_addMobCar(n, …)`, `CorsetCar(n)` maps `1..14` alphabetically → `atabus, attaban, baka, baron, bb, bus, dream, dreamer, fatima, garbag, medic, rracer, siege, warchild`. `GBaron` passes 4 (baron), `GBB` 5 (bb), `GMedic` 11, `GRracer` 12, `GWarchild` 14. Slots 9 fatima / 10 garbag / 13 siege are passed by **nobody** — exactly the three constructor-less switch cases (56, 57, 60 ⇒ ids 58, 59, 62).

The three empty cases are really empty. `MT.pcode` for case 56/57/60:

```
ofs0860: label ; getlocal 6 ; pushbyte 12 ; setproperty QName(PackageNamespace(""),"tip") ; jump ofs194c
```

— `tip` is set on a null local, nothing is constructed. `-dumpAS3` over all 576
scripts finds no `GFatima`/`GGarbag`/`GSiege`; only the `CorsetCar_B_*_d` wreck
bitmaps for those liveries survive. Campaign histogram for ids 58/59/62 = 0 and
the 40-level set uses no id ≥ 49, so the three `fatima/garbag/siege` trucks are
**cut content** — the remaster should stop presenting them as spawnable.

Art identity is *not* part of the bug: SWF `129_com.enemy.GBaron_B_body.png` is
84×38 = `textures/enemy/ground/baron/baron.png`; `130_com.enemy.GBB_B_body.png`
is 80×43 = `bb/bb.png` (visually the yellow "TV" truck). The switch is the only
thing that was wrong.

### B — "ground vehicles have no mounted gun / wheels" → **CONFIRMED**

`E/GBaron.init()`:

```
this._mobBmp2 = new this.B_body();  this._mobBmp2.x = -42;  this._mobBmp2.y = -23;
this._tpg = new TypGunMob();  this._tpg.x = 12;  this._tpg.y = -23;  this._tpg.tip = 3;
this._tpg.grad = 11;  this._tpg.rld_max = 25;  this._tpg.scaleY = -1;
this.mobTG = new MainTimeline.inst.B_gun();  … this.mobTG.scaleX = -1;  this.mobTG.x = 23;  this.mobTG.y = -4;
this._mobBmp3 = new Bitmap(new B_Wheel(0,0)…);  x = 10.5;  y = 6.5;
this._mobBmp1 = new Bitmap(new B_Wheel(0,0)…);  x = -33.5;  y = 6.5;
```

`B_gun` is the SWF bitmap `51_com.MainTimeline_B_gun.png`, **24×9** = the loose
`textures/enemy/ground/gun1.png`/`gun2.png` (both 24×9); `B_gunD`
(`69_…_B_gunD.png`, 23×9) is the Dream/Dreamer barrel; `B_Wheel` is 11×11 =
`ground/wheel.png`. `Car.update()` bobs `d1`/`d2`/`d6..d8` by ±1 px on `t==3`/`t==6`
while driving and resets them to `oldy*` when parked. Every remaster ground prefab
(`units/bb.pix3scene`, `units/baron.pix3scene`, …) is a single body `Sprite2D`
and its own header says so: *"Body art includes its wheels; separate bouncing wheel
sprites + gun … are a later increment."* Nine of the eleven surviving `G*` classes
mount a weapon (§3); `GBB` and `GMedic` are the two that do not (they carry the
`Wave` clip instead).

### C — "what hangs under an NZ" → **`air-composition.md` is wrong for the family; `nz.pix3scene` renders only `NZ_1`**

`air-composition.md` gives one row for ids 21–25 ("1× TypGun @ (0,−14)"). The SWF has
five different rigs (composition matrix from `init()`):

| id | class | hangs under `B_NZ` |
|---:|---|---|
| 21 | NZ_1 | `B_Korzina` + `TypGunMob`/`B_TypGun` (what the prefab renders) |
| 22 | NZ_2 | `B_Korzina` + `TypGunMob`/**`B_TypSnp`** (55×10 sniper barrel, `rld_max 70`, gun at (−12,21)) |
| 23 | NZ_3 | **3× `Mine`** (19×21) at x −18/0/+18, y +17/+21/+17 |
| 24 | NZ_4 | **3× `Burn2`** flames (a burning wreck-in-flight) |
| 25 | NZ_5 | **`Stoneb` (13×25) + `Burn1` flame (rot 90°) + `Littlebg` glow (23×23)** in a `d1` Sprite at (+45, 2) |

`E/NZ_5.init()` verbatim:

```
var _loc1_:Sprite = new Sprite(); this.addChild(_loc1_); this.d1 = _loc1_; _loc1_.x += 45; _loc1_.y = 2;
var _loc2_:Burn1 = new Burn1(); _loc1_.addChild(_loc2_); _loc2_.y += 26; _loc2_.x -= 29; _loc2_.rotation = 90;
this._mobBmp1 = new Bitmap(new Stoneb(0,0)…); _loc1_.addChild(_mobBmp1); x -= (width>>1) + 45; y -= (height>>1) - 21;
var _loc3_ = new Bitmap(new Littlebg(0,0)…); _loc1_.addChild(_loc3_); x -= (width>>1) + 45; y -= (height>>1) - 26;
this._mobBmp2 = new Bitmap(new B_NZ(0,0)…); x -= width>>1; y -= (height>>1) + 5;
```

Resolved to body-centre coordinates (Flash, y-down): bomb centre ≈ (0, +23),
glow centre ≈ (0, +28), flame origin ≈ (+16, +30) rotated 90°, gasbag centre
(0, −5). The same `Stoneb+Burn1+Littlebg` triple is what `Slevin_2`, `Lavalon1_4`,
`Avalon1_4` (×3) and `Unik_4` carry — it is the release's "fire bomb". The level-1
zeppelin the user remembers is therefore `NZ_5`, and it hangs a burning bomb, not
a basket. `SUC` (26–29) is collapsed the same way (SUC_2 = 2× sniper, SUC_3 = 2×
Mine, SUC_4 = 2× Stoneb).

Every other family has the same collapse — see §3. Two more structural errors in
`air-composition.md`: `Unik_5–8` (ids 39–42) and `Urik_4–6` (ids 46–48) are
**airplanes** (`B_unik_nd` 56×23 / `B_urik_nd` 72×24; the `M_Unik`/`M_Urik`
sprites render as biplanes), not rope-hung compounds, and the `Urik` family's
"torpedo launcher" applies only to `Urik_1`. The two-rope V rig (`B_unik_ropes`
52×33) belongs to `Unik_1–4` / `Urik_1–3` only.

What the SWF does **not** show: any rope asset or vector line drawing in `NZ_5`
(grep for `lineTo|graphics.` over `NZ_5`, `Rider`, `MobObject`, `Car`, `Bomber`,
`Avalon`, `TypGunMob`: none). The user's "two thin ropes" is unexplained by the
data — see §6.

### D — "spawn order is broken by the remaster's own gating" → **CONFIRMED; the original has one clock and no gating**

`MT` level load (`arMobs` fill, lines 2684–2727): `this.elMobs[0] = xml[0] * 30;` —
`<t>` seconds → frames. `MT.gameCode` (lines 14561–14592):

```
++this.g_time;
while(_loc2_ < this.kolvo) {
   if(this.g_time == this.arMobs[_loc2_][0])
      this.FN_addMob(arMobs[_loc2_][1], arMobs[_loc2_][2], arMobs[_loc2_][3], arMobs[_loc2_][4], arMobs[_loc2_][5]);
   _loc2_++;
}
```

One counter, every mob, no ground/bridge branch. The bridge carriers are a
**separate, concurrent** timer in the same `gameCode`: `if(this.n_enTP < this.c_enTP) { … if(this.i_enTP > this.t_enTP) { this.FN_addMobTP(this.pozTP); ++this.n_enTP; this.i_enTP = 0; } }` with `t_enTP = 50` frames, `ct_speedTp = 4` px/frame,
`pozTP` starting at 282 and `+= 145` per carrier; `moveMobTP` docks each one when `x <= xx` and the 4th (`etoTPnum == 4`) triggers `FN_bridgesBum()` (the random crumple). `FN_startLevel` resets `n_enTP/i_enTP/pozTP/eto_TP` every level, sets `c_enTP = 4`, and sets `c_enTP = 0` on levels 7/9/16/17/19/21/22 (which is exactly the set of campaign levels with no ground spawns); on levels 11 and 17 it pre-places `MobTP`s at x 282/427/… before the level starts.

So in the original, level 1 runs: TP1 launches ≈1.7 s and docks ≈5.6 s, TP4 launches
≈6.7 s and docks ≈7 s, the `GBaron` spawns at **7 s** at x=750 (`_loc6_.x = 750`)
and reaches the bridge end while the deck is closing. The truck is the first
enemy on screen, three seconds ahead of the `NZ_5`.

Remaster: `SdBalance.buildMission` splits `ground` out of `entries`;
`WaveSpawner.onUpdate` only advances `groundElapsed` after `bridge-ready`, and
`BridgeController` emits `bridge-ready` only when all four carriers have docked
(first launch after `BRIDGE.stagger` = 1.7 s, 120 px/s from x 470 to the far
segment at −38 → ≈4.2 s each; ready ≈ 7.5–8 s). The truck's own `t=7` then
starts counting → it appears at ≈15 s, five seconds **after** the zeppelin.
Same defect on every level with ground units (18 of 30).

Bonus finding in the same function: `tip` on a ground unit is set **per class** by
`FN_addMob` (`pushbyte 12; setproperty tip` for all `G*` except `GRracer`, which
gets `pushbyte 13`); the XML `<tip>` lands in `_loc6_.tpp = param4`, and every ground
`<tip>` in the campaign is `0`. `WaveSpawner.applyGroundStats` does
`logic.config.tip = entry.tip`, so `GroundVehicle`'s rammer branch (`tip === 13`)
can never fire, while the original's `GRracer` (id 61, **45 spawns**, always `a=100`)
always rams (`Car.update`: `if(this.tip != 13) {park} else { hp -= 500; damageDom(dmg) }`).

---

## 2. Corrected id → class → art → prefab table (ids whose mapping changes)

Stats (hp/speed/dmg/score) stay on the same id — only class/art/behaviour moves.
"Today" = `SdV15.V15_UNITS[id].cls` / `SdBalance.ART` / `WaveSpawner.unitPrefabPath`.

| id | today (class → prefab) | **correct class** | correct body art (SWF bitmap = remaster file, size) | correct prefab / notes |
|---:|---|---|---|---|
| 49 | GAtabus → units/atabus | **none** (stage-1 `default` → idx 83 → no case → null → TypeError) | — | drop from registry; never spawned (hp 0 row) |
| 50 | GAtaban → attaban | **GAtabus** | `GAtabus_B_body` 81×31 = `ground/atabus/atabus.png` | ground, rear `TypSnp` |
| 51 | GBaka → baka | **GAtaban** | `GAtaban_B_body` 75×33 = `attaban/attaban.png` | ground, `B_gun` mortar, 1 wheel |
| 52 | GBaron → baron | **GBaka** | `GBaka_B_body` 83×33 = `baka/baka.png` | ground, `B_gun` mortar |
| 53 | GBB → bb | **GBaron** | `GBaron_B_body` 84×38 = `baron/baron.png` | ground, `B_gun` mortar — **level 1 truck** |
| 54 | GBus → bus | **GBB** | `GBB_B_body` 80×43 = `bb/bb.png` | ground, no gun, `Wave` TV clip, `gun_tormoz` (jams player gun) |
| 55 | GDream → dream | **GBus** | `GBus_B_body` 80×33 = `bus/bus.png` | ground, 2× `TypSnp` |
| 56 | GDreamer → dreamer | **GDream** | `GDream_B_body` 90×23 = `dream/dream.png` | ground, `B_gunD` |
| 57 | G57 → fatima | **GDreamer** | `GDreamer_B_body` 93×24 = `dreamer/dreamer.png` | ground, `B_gunD` |
| 58 | GMedic → medic | **none (cut)** | (`fatima` exists only as a `CorsetCar` wreck) | never spawned; mark unsupported |
| 59 | GRracer → rracer | **none (cut)** | (`garbag` wreck only) | never spawned; mark unsupported |
| 60 | G60 → garbag | **GMedic** | `GMedic_B_body` 80×32 = `medic/medic.png` | ground, no gun, `Wave` clip, heals (`kolvo_medic`) |
| 61 | G61 → siege | **GRracer** | `GRracer_B_body` 70×24 = `rracer/rracer.png` + 3× `GRracer_B_minec` 19×18 = `weapons/mine_free.png` | ground **rammer** (`tip 13`), 45 campaign spawns |
| 62 | GWarchild → warchild | **none (cut)** | (`siege` wreck only) | never spawned; mark unsupported |
| 63 | MTurik → quest-npc | **GWarchild** | `GWarchild_B_body` 80×27 = `warchild/warchild.png` | **ground**, 2× `TypSnp` (L14 ×3, L23 ×4 — currently spawn as a quest NPC) |
| 64 | MFargo | **MTurik** | `B_NZ` gasbag + `B_rope` + `B_gold` | quest-npc (L3 ×10) |
| 65 | MWife | **MFargo** | `B_fargo` 66×62 + `Pp` | quest-npc (L6) |
| 66 | MBob | **MWife** | `B_wife` 89×83 + `B_gifts` | quest-npc (L8) |
| 67 | MEngin | **MBob** | `B_bob/L/R` 129×57 | quest-npc (L19) |
| 68 | MLucky | **MEngin** | `Engineer` clip | quest-npc (L17) |
| 69 | MZombee | **MLucky** | `B_Slevin` + `B_rope` + `Stone` | quest-npc (L11 ×12) |
| 70 | MSheep | **MZombee1–4** (random of 4) | `Engineer1–4` | quest-npc (L11 ×31) |
| 71 | MGold | **MSheep** | `B_NZ` + `B_rope` + `B_sheep` 27×20 | quest-npc (L7 ×20) |
| 72 | MLuckyGold | **MGold** | `B_NZ` + `B_rope` + `B_gold` 76×78 | quest-npc (L9 ×22) |
| 73 | MPolicek | **MLuckyGold** | `B_Slevin` + `B_rope` + `B_gold` | quest-npc (L21 ×40) |
| 74 | MFargoWar | **MPolicek(param4)** | `B_police` 40×45 | quest-npc (L22 ×12) |
| 75 | Boss1 | **MFargoWar** | `B_fargo` + `B_gun` + `TypGunMob` | quest-npc; unused in campaign |
| 76 | Boss2a → baby 214×81 | **Boss1** | `B_boss1` **214×81 = `bosses/baby/baby.png`** (+`_w`,`_d`) | L5 boss (8000 hp row) |
| 77 | Boss2b → grafz | **Boss2a** | `B_boss2a` **278×89 — not in remaster archive** (SWF `99_com.MainTimeline_B_boss2a.png`, `_w` 80, `_d` 79) | L10 |
| 78 | Boss3 → rud | **Boss2b** | `B_boss2b` **269×110 — not in remaster archive** (SWF `43_…_B_boss2b.png`, `_w` 67, `_d` 93) | L10 |
| 79 | S_Xenon → xenon/x | **Boss3** | `B_boss3` 164×66 = `xenon/x.png` (+`x_white`, `x_d`) | L15 boss (18000 hp) |
| 80 | Boss5 → xsup | **S_Xenon** | `B_xsup` 80×32 = `xenon/xsup.png` | L15 escort ×42 (1100 hp row) |
| 81 | Boss4 → grafz | **Boss5** | `B_boss5` 70×70 = `snake/snake1.png` (+`snake1_white`) | L25 boss (30000 hp row) |
| 82 | Bear → rud | **Boss4** | `B_boss4` 207×107 = `rud/rud.png` | L20 boss (27000 hp) |
| 83 | Boss6 → rui | **Bear** | `B_bear` 55×33 = `rud/rui.png`; rig = body + `TypGunMob` at (−2,+9) | L20 escort ×40 (1000 hp row) |
| 84 | FinalBoss → grafz | **Boss6** | `B_boss6` 432×79 = `grafz/grafz.png` (+`grafz_white`, `grafz_d`) | L30 final (40000 hp); `Boss6.as` is the only class calling `FN_final` |

The boss art table in `SdBalance.BOSS` is thus wrong for 76–84 in six of nine used
slots; the two "placeholder" comments (81, 84) are unnecessary once shifted, and
the genuinely missing art is Boss2a/Boss2b (L10), recoverable from the SWF export.

Ids 1–48 keep their class; their problem is §3.

---

## 3. Per-family rig corrections (what each class really hangs, Flash y-down offsets)

Conventions from the sources: bitmaps are placed by top-left then centred
(`x -= w>>1`), bodies sit at `y -= (h>>1) + 5` (NZ_1/2: `+7`); `TypGunMob` is a
container whose barrel is `mobTG` at `(20, −4.5)` (`B_TypGun` 23×9) or `(30, −4)`
(`B_TypSnp` 55×10), `scaleX = −1`; muzzle flashes `FxMg1/2` at `(−23, 15)`.
`Burn1`/`Burn2` are flame MovieClips (rendered: Burn1 ≈ 35×65, Burn2 ≈ 100×170 at
1×), always `rotation = 90`. Sizes: `Stoneb` 13×25, `Mine` 19×21, `B_Mine` 19×18,
`Littlebg` 23×23, `B_Korzina` 20×13, `B_Torpedo` 72×12, `B_LTorpedo` 48×8,
`BigGun` clip ≈ 55×10 (`weapons/big_gun1.png`).

### Air, one prefab per *class* is required (today: one per family)

| id | class | rig (`init()`) | offsets (Flash, relative to unit origin) |
|---:|---|---|---|
| 1 | Lucky_1 | `B_Lucky` + `Mine` | mine `y -= (h>>1) − 27` (centre +27) |
| 2 | Lucky_2 | `B_Lucky` + `Stoneb` | bomb centre (0, +25) |
| 3 | Slevin_1 | `B_Slevin` + `Mine` | as Lucky_1 |
| 4 | Slevin_2 | `B_Slevin` + `Stoneb` + `Burn1` + `Littlebg` | bomb (0,+25), glow (0,+29), flame origin (+15,+30) rot 90 — prefab `slevin-fire` already approximates this |
| 5 | Avalon1_1 | `B_Avalon1` + `BigGun` + `B_AvalonC` hidden | gun `x −67, y +4`, `scaleX *= −1` (matches doc) |
| 6 | Avalon1_2 | `B_Avalon1` + `TorpedoGun` + `B_Torpedo` | torpedo centre (−6, +22) |
| 7 | Avalon1_3 | `B_Avalon1` + 3× `Mine` | centres (−45,+20), (−8,+24), (+29,+20) |
| 8 | Avalon1_4 | `B_Avalon1` + 3× (`Stoneb`+`Burn1`+`Littlebg`) | bombs at x −45 / −8 / +29, y ≈ +21..+25; glows +26..+30 |
| 9 | Avalon2_1 | `B_Avalon2` + 2× `B_Korzina` + 2× `TypGunMob`/`B_TypGun` | guns (−51,18) tip 0 & (−9,24) tip 1; baskets centre (−8,+20), (−50,+14) (matches doc) |
| 10 | Avalon2_2 | `B_Avalon2` + **4×** `Stoneb` | centres x −61/−28/+13/+46, y +16/+25/+25/+16 |
| 11 | Avalon2_3 | `B_Avalon2` + 2× `TorpedoGun2` + 2× `B_LTorpedo` | (−8,+21) and (−8,+27) |
| 12 | Avalon2_4 | `B_Avalon2` + **5×** `Mine` | x −67/−43/−15/+16/+?, y +5/+11/+16/+13/+5 |
| 13 | Lavalon1_1 | `B_Lavalon1` + `B_Korzina` + `TypGun` | gun (−6,14); basket (−5,+11) (matches doc) |
| 14 | Lavalon1_2 | `B_Lavalon1` + `TorpedoGun2` + `B_LTorpedo` | (−2,+12) |
| 15 | Lavalon1_3 | `B_Lavalon1` + 2× `Mine` | (−21,+15), (+12,+15) |
| 16 | Lavalon1_4 | `B_Lavalon1` + `Stoneb`+`Burn1`+`Littlebg` in a Sprite at (+40,−4) | bomb ≈ (−5,+17), glow ≈ (−5,+22) |
| 17 | Lavalon2_1 | `B_Lavalon2` + `B_Korzina` + `TypGun` | as Lavalon1_1 |
| 18 | Lavalon2_2 | `B_Lavalon2` + 2× `Stoneb` | (−29,+15), (+21,+15) — **level-1 "Bomber"** |
| 19 | Lavalon2_3 | `B_Lavalon2` + 2× `Burn1` + `Burn2` | flames at (+55,−12), (+30,−4), (−30,−7) — a burning hull, no weapon |
| 20 | Lavalon2_4 | `B_Lavalon2` + 2× `Mine` | (−6,+7), (+25,+2) |
| 21 | NZ_1 | `B_NZ` + `B_Korzina` + `TypGun` | gun (0,17); basket (0,+14); body `y −= (h>>1)+7` |
| 22 | NZ_2 | `B_NZ` + `B_Korzina` + **`B_TypSnp`** | gun (−12,21) grad 1 rld 70; basket (0,+14) |
| 23 | NZ_3 | `B_NZ` + 3× `Mine` | (−18,+17), (0,+21), (+18,+17) |
| 24 | NZ_4 | `B_NZ` + 3× `Burn2` | (−6,−7), (+2,−7), (−15,−4) rot 90 |
| 25 | NZ_5 | `B_NZ` + `Stoneb`+`Burn1`+`Littlebg` | see §C — **level-1 zeppelin** |
| 26 | SUC_1 | `B_SUC` + `B_Korzina` + `TypGun` | as NZ_1 |
| 27 | SUC_2 | `B_SUC` + `B_Korzina` + **2×** `TypSnp` | guns (−12,21) & (−35,−4) |
| 28 | SUC_3 | `B_SUC` + 2× `Mine` | (−22,−2), (+4,−2) top-left |
| 29 | SUC_4 | `B_SUC` + 2× `Stoneb` | (−24,+2), (+11,+2) top-left |
| 35 | Unik_1 | `B_unik_s`(−25,−36) + `B_unik_ropes`(−25,−13) + `B_unik_body`(x centred, y 6) + `TypSnp` gun (−16,28) rld 70 | top-left coords; matches prefab layout roughly, but barrel must be the 55×10 sniper |
| 36 | Unik_2 | same rig + `TorpedoGun2` + `B_LTorpedo` at (0,+34) | |
| 37 | Unik_3 | same rig + `Stoneb` at (−17,25) | |
| 38 | Unik_4 | same rig + `Stoneb`+`Burn1`+`Littlebg` (Sprite at (34,15)) | |
| 39 | Unik_5 | **PLANE** `B_unik_nd` (56×23 at −28,−13) + `TypSnp` gun (−16,11) | not a balloon |
| 40 | Unik_6 | **PLANE** `B_unik_nd` + `TypGun` gun (−13,10) rld 20 | **level-1 "ATS"** |
| 41 | Unik_7 | **PLANE** `B_unik_nd` + `TorpedoGun2` + `B_LTorpedo` (−28,8) | |
| 42 | Unik_8 | **PLANE** `B_unik_nd` + `Burn1` + 2× `Burn2` | burning plane |
| 43 | Urik_1 | `B_urik_s`(−25,−36) + `B_urik_ropes`(−21,−13) + `B_urik_body`(−36,3) + `B_Torpedo` (−36,20) | heavy torpedo 72×12, not `ltorpedo` |
| 44 | Urik_2 | same rig + 3× `Mine` (−30,21)(−11,19)(+9,16) | |
| 45 | Urik_3 | same rig + `BigGun` (−21,26) mirrored | |
| 46 | Urik_4 | **PLANE** `B_urik_nd` (72×24 at −28,−13) + `TypGun` (4,9) rld 20 | |
| 47 | Urik_5 | **PLANE** `B_urik_nd` + `B_Mine` (−37,−8) | |
| 48 | Urik_6 | **PLANE** `B_urik_nd` (−31,−13) + `B_urik_b` blur (112×24 at −16,−13) + 3× `Burn1` | burning plane |
| 83 | Bear | `B_bear` (55×33, `y −= (h>>1)+4`) + `TypGunMob`/`B_TypGun` at (−2, 9) | the L20 escort; boss.pix3scene has no gun rig for it |

Unchanged/verified: 30–34 support bodies; 33 `S_SS` = `SS` clip (rendered 55×29 =
`transporter/00000.png`).

### Ground (`Car` base; body top-left, wheels centre-ish, gun container)

| class (id) | body top-left | wheels (x, y) | weapon |
|---|---|---|---|
| GAtabus (50) | `scaleX` flipped body | (12.5, 4.5), (−35.5, 4.5) | `TypGunMob` (−25, −15.5) tip 10 + `B_TypSnp` (30,−4), **not** `scaleY −1` |
| GAtaban (51) | (−37, −20) | one wheel (15.5, 6.5) + (−30.5, 6.5) | `TypGunMob` (10, −13) `scaleY −1`, `B_gun` (23,−4) |
| GBaka (52) | (−37, −20) | (18.5, 6.5), (−30.5, 6.5) | `TypGunMob` (10, −19) `scaleY −1`, `B_gun` |
| GBaron (53) | (−42, −23) | (10.5, 6.5), (−33.5, 6.5) | `TypGunMob` (12, −23) `scaleY −1`, `B_gun` |
| GBB (54) | (−40, −30) | (15.5, 6), (−32.5, 6) | none; `Wave` clip `d5` (hidden until active), `moveTVMob`, `gun_tormoz` |
| GBus (55) | (−40, −20) | (−36.5, 6) + second | 2× `TypGunMob` (−14,−19) & (5,−21.5) with `B_TypSnp` |
| GDream (56) | (−45, −9) | (−36.5, 6.5) + second | `TypGunMob` (10,−13) `scaleY −1`, `B_gunD` (23,−2) |
| GDreamer (57) | (−46, −10.5) | (17, 6.5), (−36, 6.5) | `TypGunMob` (5,−13) `scaleY −1`, `B_gunD` |
| GMedic (60) | (−40, −19) | (18.5, 6), (−25.5, 6) | none; `Wave` clip; heals (`kolvo_medic`) |
| GRracer (61) | (−35, −12) | (15, 6.5), (−30.5, 6.5) | 3× `B_minec` at (−1,−12), (17,−12), (9,−17); **rammer** |
| GWarchild (63) | (−40, −14) | (12.5, 5.5), (−34.5, 5.5) | 2× `TypGunMob` (−15,−13) & (10,−13), `B_TypSnp` |

`TypGunMob.scaleY = −1` on the mortar trucks flips the gun container so the barrel
sits *above* the body; `rld_max 25` for all ground guns (air `TypGun` default 50,
snipers 70/20).

### Corrections to `design/original-data/release-v15/*.md` (record only; edit later)

- `unit-table.md` / `README.md` "Unit id → class": the switch is `id−1` only for
  1–48; ≥50 is `id−2`; 49 unmapped; 58/59/62 constructor-less (cut). Ground band is
  50–63, NPC 64–75, bosses 76–84 (Boss6 = final). The `G?(57/60/61)` note ("decompiler
  dropped the `new`") is wrong — the P-code shows there was never a constructor.
- `README.md` boss table: L5 = 76 **Boss1** (baby), L10 = 77 Boss2a + 78 Boss2b, L15 = 79
  **Boss3** (xenon) + 80 **S_Xenon** ×42 escorts, L20 = 82 **Boss4** (rud) + 83 **Bear** ×40,
  L25 = 81 **Boss5** (snake), L30 = 84 **Boss6** (grafz). "`Boss1` (id 75) is a mini-boss"
  is wrong — 75 is `MFargoWar`.
- `air-composition.md`: only the `_1` variants were transcribed; add the 40 rows above;
  Unik_5–8/Urik_4–6 are planes; Urik "torpedo launcher" is Urik_1 only; NZ/SUC row is
  wrong for 22–25 / 27–29.
- `enemy-behavior.md` §Ground: `tip==13` comes from the class (`GRracer`), not from the
  XML; "optional gun" understates it — 9 of 11 trucks are armed.
- `campaign-30-levels.summary.md`: regenerate class names with the corrected mapping.

---

## 4. Per-level diff (what changes on screen after the fix)

Generated from `XML` with the corrected mapping; rows are ids whose class or
visible rig differs from what the remaster spawns today. Ids 2/4 (`lucky2`,
`slevin-fire`) and 30–34 already have faithful prefabs and are omitted.
Level 16 has no `<Mob>` at all in the release data (bridge-less quest level).

| Lvl | id x n | remaster today (class / rig) | original (class / rig) | kind |
|---|---|---|---|---|
| L1 | 18 x1 | Lavalon2_2 / lavalon2 (basket+TypGun) | Lavalon2_2 / Lavalon2 + 2x Stoneb | RIG (variant collapsed to _1) |
| L1 | 25 x2 | NZ_5 / nz (basket+TypGun) | NZ_5 / B_NZ + Stoneb+Burn1+Littlebg (fire bomb) | RIG (variant collapsed to _1) |
| L1 | 40 x1 | Unik_6 / unik (gasbags+ropes+carriage+TypGun) | Unik_6 / PLANE unik_nd + TypGun | RIG (variant collapsed to _1) |
| L1 | 53 x1 | GBB / ground body only, no gun/wheels | GBaron / body+2 wheels + B_gun mortar | CLASS SHIFT; RIG (no gun/wheels) |
| L2 | 18 x2 | Lavalon2_2 / lavalon2 (basket+TypGun) | Lavalon2_2 / Lavalon2 + 2x Stoneb | RIG (variant collapsed to _1) |
| L2 | 53 x2 | GBB / ground body only, no gun/wheels | GBaron / body+2 wheels + B_gun mortar | CLASS SHIFT; RIG (no gun/wheels) |
| L3 | 64 x10 | MFargo / quest-npc | MTurik / - | CLASS SHIFT |
| L4 | 51 x1 | GBaka / ground body only, no gun/wheels | GAtaban / body+1 wheel + B_gun mortar | CLASS SHIFT; RIG (no gun/wheels) |
| L4 | 52 x2 | GBaron / ground body only, no gun/wheels | GBaka / body+2 wheels + B_gun mortar | CLASS SHIFT; RIG (no gun/wheels) |
| L5 | 60 x2 | G60(garbag art) / ground body only, no gun/wheels | GMedic / body+2 wheels + Wave (medic), NO gun | CLASS SHIFT; RIG (no gun/wheels) |
| L5 | 76 x1 | Boss2a / boss | Boss1 / - | CLASS SHIFT; BOSS art |
| L6 | 22 x4 | NZ_2 / nz (basket+TypGun) | NZ_2 / B_NZ + Korzina + TypSnp (sniper 55x10) | RIG (variant collapsed to _1) |
| L6 | 23 x2 | NZ_3 / nz (basket+TypGun) | NZ_3 / B_NZ + 3x Mine | RIG (variant collapsed to _1) |
| L6 | 25 x10 | NZ_5 / nz (basket+TypGun) | NZ_5 / B_NZ + Stoneb+Burn1+Littlebg (fire bomb) | RIG (variant collapsed to _1) |
| L6 | 36 x2 | Unik_2 / unik (gasbags+ropes+carriage+TypGun) | Unik_2 / unik_s+ropes+unik_body + TorpedoGun2+LTorpedo | RIG (variant collapsed to _1) |
| L6 | 39 x3 | Unik_5 / unik (gasbags+ropes+carriage+TypGun) | Unik_5 / PLANE unik_nd + TypSnp | RIG (variant collapsed to _1) |
| L6 | 65 x1 | MWife / quest-npc | MFargo / - | CLASS SHIFT |
| L7 | 16 x6 | Lavalon1_4 / lavalon1 (basket+TypGun) | Lavalon1_4 / Lavalon1 + Stoneb+Burn1+Littlebg | RIG (variant collapsed to _1) |
| L7 | 22 x9 | NZ_2 / nz (basket+TypGun) | NZ_2 / B_NZ + Korzina + TypSnp (sniper 55x10) | RIG (variant collapsed to _1) |
| L7 | 40 x9 | Unik_6 / unik (gasbags+ropes+carriage+TypGun) | Unik_6 / PLANE unik_nd + TypGun | RIG (variant collapsed to _1) |
| L7 | 71 x20 | MGold / quest-npc | MSheep / - | CLASS SHIFT |
| L8 | 23 x2 | NZ_3 / nz (basket+TypGun) | NZ_3 / B_NZ + 3x Mine | RIG (variant collapsed to _1) |
| L8 | 27 x15 | SUC_2 / suc (basket+TypGun) | SUC_2 / B_SUC + Korzina + 2x TypSnp | RIG (variant collapsed to _1) |
| L8 | 39 x6 | Unik_5 / unik (gasbags+ropes+carriage+TypGun) | Unik_5 / PLANE unik_nd + TypSnp | RIG (variant collapsed to _1) |
| L8 | 41 x6 | Unik_7 / unik (gasbags+ropes+carriage+TypGun) | Unik_7 / PLANE unik_nd + TorpedoGun2+LTorpedo | RIG (variant collapsed to _1) |
| L8 | 54 x1 | GBus / ground body only, no gun/wheels | GBB / body+2 wheels + Wave (TV jammer), NO gun | CLASS SHIFT; RIG (no gun/wheels) |
| L8 | 61 x6 | G61(siege art) / ground body only, no gun/wheels | GRracer / body+2 wheels + 3x minec, tip 13 RAMMER | CLASS SHIFT; RIG (no gun/wheels) |
| L8 | 66 x1 | MBob / quest-npc | MWife / - | CLASS SHIFT |
| L9 | 22 x9 | NZ_2 / nz (basket+TypGun) | NZ_2 / B_NZ + Korzina + TypSnp (sniper 55x10) | RIG (variant collapsed to _1) |
| L9 | 39 x9 | Unik_5 / unik (gasbags+ropes+carriage+TypGun) | Unik_5 / PLANE unik_nd + TypSnp | RIG (variant collapsed to _1) |
| L9 | 72 x22 | MLuckyGold / quest-npc | MGold / - | CLASS SHIFT |
| L10 | 39 x47 | Unik_5 / unik (gasbags+ropes+carriage+TypGun) | Unik_5 / PLANE unik_nd + TypSnp | RIG (variant collapsed to _1) |
| L10 | 77 x1 | Boss2b / boss | Boss2a / - | CLASS SHIFT; BOSS art |
| L10 | 78 x1 | Boss3 / boss | Boss2b / - | CLASS SHIFT; BOSS art |
| L11 | 54 x1 | GBus / ground body only, no gun/wheels | GBB / body+2 wheels + Wave (TV jammer), NO gun | CLASS SHIFT; RIG (no gun/wheels) |
| L11 | 69 x12 | MZombee / quest-npc | MLucky / - | CLASS SHIFT |
| L11 | 70 x31 | MSheep / quest-npc | MZombee1-4 / - | CLASS SHIFT |
| L12 | 25 x28 | NZ_5 / nz (basket+TypGun) | NZ_5 / B_NZ + Stoneb+Burn1+Littlebg (fire bomb) | RIG (variant collapsed to _1) |
| L12 | 39 x21 | Unik_5 / unik (gasbags+ropes+carriage+TypGun) | Unik_5 / PLANE unik_nd + TypSnp | RIG (variant collapsed to _1) |
| L12 | 61 x4 | G61(siege art) / ground body only, no gun/wheels | GRracer / body+2 wheels + 3x minec, tip 13 RAMMER | CLASS SHIFT; RIG (no gun/wheels) |
| L13 | 16 x3 | Lavalon1_4 / lavalon1 (basket+TypGun) | Lavalon1_4 / Lavalon1 + Stoneb+Burn1+Littlebg | RIG (variant collapsed to _1) |
| L13 | 41 x14 | Unik_7 / unik (gasbags+ropes+carriage+TypGun) | Unik_7 / PLANE unik_nd + TorpedoGun2+LTorpedo | RIG (variant collapsed to _1) |
| L13 | 55 x4 | GDream / ground body only, no gun/wheels | GBus / body+2 wheels + 2x TypSnp | CLASS SHIFT; RIG (no gun/wheels) |
| L13 | 61 x2 | G61(siege art) / ground body only, no gun/wheels | GRracer / body+2 wheels + 3x minec, tip 13 RAMMER | CLASS SHIFT; RIG (no gun/wheels) |
| L14 | 10 x2 | Avalon2_2 / avalon2 (2 baskets+TypGun) | Avalon2_2 / Avalon2 + 4x Stoneb | RIG (variant collapsed to _1) |
| L14 | 18 x4 | Lavalon2_2 / lavalon2 (basket+TypGun) | Lavalon2_2 / Lavalon2 + 2x Stoneb | RIG (variant collapsed to _1) |
| L14 | 25 x6 | NZ_5 / nz (basket+TypGun) | NZ_5 / B_NZ + Stoneb+Burn1+Littlebg (fire bomb) | RIG (variant collapsed to _1) |
| L14 | 27 x3 | SUC_2 / suc (basket+TypGun) | SUC_2 / B_SUC + Korzina + 2x TypSnp | RIG (variant collapsed to _1) |
| L14 | 28 x3 | SUC_3 / suc (basket+TypGun) | SUC_3 / B_SUC + 2x Mine | RIG (variant collapsed to _1) |
| L14 | 36 x3 | Unik_2 / unik (gasbags+ropes+carriage+TypGun) | Unik_2 / unik_s+ropes+unik_body + TorpedoGun2+LTorpedo | RIG (variant collapsed to _1) |
| L14 | 40 x3 | Unik_6 / unik (gasbags+ropes+carriage+TypGun) | Unik_6 / PLANE unik_nd + TypGun | RIG (variant collapsed to _1) |
| L14 | 50 x2 | GAtaban / ground body only, no gun/wheels | GAtabus / body+2 wheels + TypSnp (rear) | CLASS SHIFT; RIG (no gun/wheels) |
| L14 | 56 x2 | GDreamer / ground body only, no gun/wheels | GDream / body+2 wheels + B_gunD | CLASS SHIFT; RIG (no gun/wheels) |
| L14 | 57 x1 | G57(fatima art) / ground body only, no gun/wheels | GDreamer / body+2 wheels + B_gunD | CLASS SHIFT; RIG (no gun/wheels) |
| L14 | 61 x7 | G61(siege art) / ground body only, no gun/wheels | GRracer / body+2 wheels + 3x minec, tip 13 RAMMER | CLASS SHIFT; RIG (no gun/wheels) |
| L14 | 63 x3 | MTurik / quest-npc | GWarchild / body+2 wheels + 2x TypSnp | CLASS SHIFT; RIG (no gun/wheels) |
| L15 | 60 x6 | G60(garbag art) / ground body only, no gun/wheels | GMedic / body+2 wheels + Wave (medic), NO gun | CLASS SHIFT; RIG (no gun/wheels) |
| L15 | 79 x1 | S_Xenon / boss | Boss3 / - | CLASS SHIFT; BOSS art |
| L15 | 80 x42 | Boss5 / boss | S_Xenon / - | CLASS SHIFT; BOSS art |
| L17 | 12 x10 | Avalon2_4 / avalon2 (2 baskets+TypGun) | Avalon2_4 / Avalon2 + 5x Mine | RIG (variant collapsed to _1) |
| L17 | 20 x3 | Lavalon2_4 / lavalon2 (basket+TypGun) | Lavalon2_4 / Lavalon2 + 2x Mine | RIG (variant collapsed to _1) |
| L17 | 22 x11 | NZ_2 / nz (basket+TypGun) | NZ_2 / B_NZ + Korzina + TypSnp (sniper 55x10) | RIG (variant collapsed to _1) |
| L17 | 23 x10 | NZ_3 / nz (basket+TypGun) | NZ_3 / B_NZ + 3x Mine | RIG (variant collapsed to _1) |
| L17 | 27 x5 | SUC_2 / suc (basket+TypGun) | SUC_2 / B_SUC + Korzina + 2x TypSnp | RIG (variant collapsed to _1) |
| L17 | 28 x5 | SUC_3 / suc (basket+TypGun) | SUC_3 / B_SUC + 2x Mine | RIG (variant collapsed to _1) |
| L17 | 41 x14 | Unik_7 / unik (gasbags+ropes+carriage+TypGun) | Unik_7 / PLANE unik_nd + TorpedoGun2+LTorpedo | RIG (variant collapsed to _1) |
| L17 | 45 x3 | Urik_3 / urik (gasbags+ropes+carriage+ltorpedo) | Urik_3 / urik_s+ropes+urik_body + BigGun | RIG (variant collapsed to _1) |
| L17 | 48 x3 | Urik_6 / urik (gasbags+ropes+carriage+ltorpedo) | Urik_6 / PLANE urik_nd + urik_b(blur) + 3x Burn1 (burning) | RIG (variant collapsed to _1) |
| L17 | 68 x1 | MLucky / quest-npc | MEngin / - | CLASS SHIFT |
| L18 | 27 x3 | SUC_2 / suc (basket+TypGun) | SUC_2 / B_SUC + Korzina + 2x TypSnp | RIG (variant collapsed to _1) |
| L18 | 50 x3 | GAtaban / ground body only, no gun/wheels | GAtabus / body+2 wheels + TypSnp (rear) | CLASS SHIFT; RIG (no gun/wheels) |
| L18 | 54 x3 | GBus / ground body only, no gun/wheels | GBB / body+2 wheels + Wave (TV jammer), NO gun | CLASS SHIFT; RIG (no gun/wheels) |
| L18 | 55 x3 | GDream / ground body only, no gun/wheels | GBus / body+2 wheels + 2x TypSnp | CLASS SHIFT; RIG (no gun/wheels) |
| L19 | 11 x2 | Avalon2_3 / avalon2 (2 baskets+TypGun) | Avalon2_3 / Avalon2 + 2x TorpedoGun2 + 2x LTorpedo | RIG (variant collapsed to _1) |
| L19 | 12 x1 | Avalon2_4 / avalon2 (2 baskets+TypGun) | Avalon2_4 / Avalon2 + 5x Mine | RIG (variant collapsed to _1) |
| L19 | 16 x13 | Lavalon1_4 / lavalon1 (basket+TypGun) | Lavalon1_4 / Lavalon1 + Stoneb+Burn1+Littlebg | RIG (variant collapsed to _1) |
| L19 | 22 x4 | NZ_2 / nz (basket+TypGun) | NZ_2 / B_NZ + Korzina + TypSnp (sniper 55x10) | RIG (variant collapsed to _1) |
| L19 | 23 x3 | NZ_3 / nz (basket+TypGun) | NZ_3 / B_NZ + 3x Mine | RIG (variant collapsed to _1) |
| L19 | 27 x3 | SUC_2 / suc (basket+TypGun) | SUC_2 / B_SUC + Korzina + 2x TypSnp | RIG (variant collapsed to _1) |
| L19 | 39 x3 | Unik_5 / unik (gasbags+ropes+carriage+TypGun) | Unik_5 / PLANE unik_nd + TypSnp | RIG (variant collapsed to _1) |
| L19 | 40 x6 | Unik_6 / unik (gasbags+ropes+carriage+TypGun) | Unik_6 / PLANE unik_nd + TypGun | RIG (variant collapsed to _1) |
| L19 | 41 x13 | Unik_7 / unik (gasbags+ropes+carriage+TypGun) | Unik_7 / PLANE unik_nd + TorpedoGun2+LTorpedo | RIG (variant collapsed to _1) |
| L19 | 46 x7 | Urik_4 / urik (gasbags+ropes+carriage+ltorpedo) | Urik_4 / PLANE urik_nd + TypGun | RIG (variant collapsed to _1) |
| L19 | 67 x1 | MEngin / quest-npc | MBob / - | CLASS SHIFT |
| L20 | 46 x22 | Urik_4 / urik (gasbags+ropes+carriage+ltorpedo) | Urik_4 / PLANE urik_nd + TypGun | RIG (variant collapsed to _1) |
| L20 | 60 x3 | G60(garbag art) / ground body only, no gun/wheels | GMedic / body+2 wheels + Wave (medic), NO gun | CLASS SHIFT; RIG (no gun/wheels) |
| L20 | 82 x1 | Bear / boss | Boss4 / - | CLASS SHIFT; BOSS art |
| L20 | 83 x40 | Boss6 / boss | Bear / - | CLASS SHIFT; BOSS art |
| L21 | 73 x40 | MPolicek / quest-npc | MLuckyGold / - | CLASS SHIFT |
| L22 | 74 x12 | MFargoWar / quest-npc | MPolicek / - | CLASS SHIFT |
| L23 | 36 x2 | Unik_2 / unik (gasbags+ropes+carriage+TypGun) | Unik_2 / unik_s+ropes+unik_body + TorpedoGun2+LTorpedo | RIG (variant collapsed to _1) |
| L23 | 37 x5 | Unik_3 / unik (gasbags+ropes+carriage+TypGun) | Unik_3 / unik_s+ropes+unik_body + Stoneb | RIG (variant collapsed to _1) |
| L23 | 38 x4 | Unik_4 / unik (gasbags+ropes+carriage+TypGun) | Unik_4 / unik_s+ropes+unik_body + Stoneb+Burn1+Littlebg | RIG (variant collapsed to _1) |
| L23 | 39 x8 | Unik_5 / unik (gasbags+ropes+carriage+TypGun) | Unik_5 / PLANE unik_nd + TypSnp | RIG (variant collapsed to _1) |
| L23 | 41 x7 | Unik_7 / unik (gasbags+ropes+carriage+TypGun) | Unik_7 / PLANE unik_nd + TorpedoGun2+LTorpedo | RIG (variant collapsed to _1) |
| L23 | 44 x5 | Urik_2 / urik (gasbags+ropes+carriage+ltorpedo) | Urik_2 / urik_s+ropes+urik_body + 3x Mine | RIG (variant collapsed to _1) |
| L23 | 46 x5 | Urik_4 / urik (gasbags+ropes+carriage+ltorpedo) | Urik_4 / PLANE urik_nd + TypGun | RIG (variant collapsed to _1) |
| L23 | 48 x10 | Urik_6 / urik (gasbags+ropes+carriage+ltorpedo) | Urik_6 / PLANE urik_nd + urik_b(blur) + 3x Burn1 (burning) | RIG (variant collapsed to _1) |
| L23 | 61 x5 | G61(siege art) / ground body only, no gun/wheels | GRracer / body+2 wheels + 3x minec, tip 13 RAMMER | CLASS SHIFT; RIG (no gun/wheels) |
| L23 | 63 x4 | MTurik / quest-npc | GWarchild / body+2 wheels + 2x TypSnp | CLASS SHIFT; RIG (no gun/wheels) |
| L24 | 6 x1 | Avalon1_2 / avalon1 (BigGun nose) | Avalon1_2 / Avalon1 + TorpedoGun + B_Torpedo | RIG (variant collapsed to _1) |
| L24 | 12 x2 | Avalon2_4 / avalon2 (2 baskets+TypGun) | Avalon2_4 / Avalon2 + 5x Mine | RIG (variant collapsed to _1) |
| L24 | 22 x6 | NZ_2 / nz (basket+TypGun) | NZ_2 / B_NZ + Korzina + TypSnp (sniper 55x10) | RIG (variant collapsed to _1) |
| L24 | 28 x16 | SUC_3 / suc (basket+TypGun) | SUC_3 / B_SUC + 2x Mine | RIG (variant collapsed to _1) |
| L24 | 39 x6 | Unik_5 / unik (gasbags+ropes+carriage+TypGun) | Unik_5 / PLANE unik_nd + TypSnp | RIG (variant collapsed to _1) |
| L24 | 45 x3 | Urik_3 / urik (gasbags+ropes+carriage+ltorpedo) | Urik_3 / urik_s+ropes+urik_body + BigGun | RIG (variant collapsed to _1) |
| L24 | 48 x2 | Urik_6 / urik (gasbags+ropes+carriage+ltorpedo) | Urik_6 / PLANE urik_nd + urik_b(blur) + 3x Burn1 (burning) | RIG (variant collapsed to _1) |
| L24 | 50 x3 | GAtaban / ground body only, no gun/wheels | GAtabus / body+2 wheels + TypSnp (rear) | CLASS SHIFT; RIG (no gun/wheels) |
| L24 | 52 x2 | GBaron / ground body only, no gun/wheels | GBaka / body+2 wheels + B_gun mortar | CLASS SHIFT; RIG (no gun/wheels) |
| L24 | 54 x1 | GBus / ground body only, no gun/wheels | GBB / body+2 wheels + Wave (TV jammer), NO gun | CLASS SHIFT; RIG (no gun/wheels) |
| L25 | 22 x33 | NZ_2 / nz (basket+TypGun) | NZ_2 / B_NZ + Korzina + TypSnp (sniper 55x10) | RIG (variant collapsed to _1) |
| L25 | 54 x3 | GBus / ground body only, no gun/wheels | GBB / body+2 wheels + Wave (TV jammer), NO gun | CLASS SHIFT; RIG (no gun/wheels) |
| L25 | 60 x3 | G60(garbag art) / ground body only, no gun/wheels | GMedic / body+2 wheels + Wave (medic), NO gun | CLASS SHIFT; RIG (no gun/wheels) |
| L25 | 81 x1 | Boss4 / boss | Boss5 / - | CLASS SHIFT; BOSS art |
| L26 | 22 x38 | NZ_2 / nz (basket+TypGun) | NZ_2 / B_NZ + Korzina + TypSnp (sniper 55x10) | RIG (variant collapsed to _1) |
| L26 | 25 x44 | NZ_5 / nz (basket+TypGun) | NZ_5 / B_NZ + Stoneb+Burn1+Littlebg (fire bomb) | RIG (variant collapsed to _1) |
| L26 | 39 x10 | Unik_5 / unik (gasbags+ropes+carriage+TypGun) | Unik_5 / PLANE unik_nd + TypSnp | RIG (variant collapsed to _1) |
| L26 | 53 x3 | GBB / ground body only, no gun/wheels | GBaron / body+2 wheels + B_gun mortar | CLASS SHIFT; RIG (no gun/wheels) |
| L26 | 55 x4 | GDream / ground body only, no gun/wheels | GBus / body+2 wheels + 2x TypSnp | CLASS SHIFT; RIG (no gun/wheels) |
| L26 | 56 x3 | GDreamer / ground body only, no gun/wheels | GDream / body+2 wheels + B_gunD | CLASS SHIFT; RIG (no gun/wheels) |
| L26 | 61 x9 | G61(siege art) / ground body only, no gun/wheels | GRracer / body+2 wheels + 3x minec, tip 13 RAMMER | CLASS SHIFT; RIG (no gun/wheels) |
| L27 | 16 x44 | Lavalon1_4 / lavalon1 (basket+TypGun) | Lavalon1_4 / Lavalon1 + Stoneb+Burn1+Littlebg | RIG (variant collapsed to _1) |
| L27 | 27 x38 | SUC_2 / suc (basket+TypGun) | SUC_2 / B_SUC + Korzina + 2x TypSnp | RIG (variant collapsed to _1) |
| L27 | 46 x10 | Urik_4 / urik (gasbags+ropes+carriage+ltorpedo) | Urik_4 / PLANE urik_nd + TypGun | RIG (variant collapsed to _1) |
| L27 | 57 x8 | G57(fatima art) / ground body only, no gun/wheels | GDreamer / body+2 wheels + B_gunD | CLASS SHIFT; RIG (no gun/wheels) |
| L28 | 39 x18 | Unik_5 / unik (gasbags+ropes+carriage+TypGun) | Unik_5 / PLANE unik_nd + TypSnp | RIG (variant collapsed to _1) |
| L29 | 6 x3 | Avalon1_2 / avalon1 (BigGun nose) | Avalon1_2 / Avalon1 + TorpedoGun + B_Torpedo | RIG (variant collapsed to _1) |
| L29 | 27 x7 | SUC_2 / suc (basket+TypGun) | SUC_2 / B_SUC + Korzina + 2x TypSnp | RIG (variant collapsed to _1) |
| L29 | 45 x3 | Urik_3 / urik (gasbags+ropes+carriage+ltorpedo) | Urik_3 / urik_s+ropes+urik_body + BigGun | RIG (variant collapsed to _1) |
| L29 | 54 x1 | GBus / ground body only, no gun/wheels | GBB / body+2 wheels + Wave (TV jammer), NO gun | CLASS SHIFT; RIG (no gun/wheels) |
| L29 | 55 x11 | GDream / ground body only, no gun/wheels | GBus / body+2 wheels + 2x TypSnp | CLASS SHIFT; RIG (no gun/wheels) |
| L29 | 61 x12 | G61(siege art) / ground body only, no gun/wheels | GRracer / body+2 wheels + 3x minec, tip 13 RAMMER | CLASS SHIFT; RIG (no gun/wheels) |
| L30 | 39 x47 | Unik_5 / unik (gasbags+ropes+carriage+TypGun) | Unik_5 / PLANE unik_nd + TypSnp | RIG (variant collapsed to _1) |
| L30 | 60 x12 | G60(garbag art) / ground body only, no gun/wheels | GMedic / body+2 wheels + Wave (medic), NO gun | CLASS SHIFT; RIG (no gun/wheels) |
| L30 | 84 x1 | FinalBoss(84) / boss | Boss6 / - | CLASS SHIFT; BOSS art |

---

## 5. Ranked fix plan

Order chosen so that level 1 becomes checkable after step 3 and each later step
is independently verifiable on the dev scene `src/assets/scenes/dev/unit-gallery.pix3scene`.

### P0 — level 1 correct (mapping + order + the two level-1 rigs)

1. **`scripts/SdV15.ts` (regenerate via `scripts/gen-levels.mjs`, do not hand-edit) —
   fix `V15_UNITS[id].cls`/`cat` for ids 49–84** per §2: shift classes by one from 50 up,
   mark 49/58/59/62 as `cut` (or `unsupported`), move 63 into `ground`, 64–75 into `npc`,
   76–84 bosses with `Boss6` as the finale. Keep every stat row where it is.
   *Visible:* nothing yet (data only), but `UNITS[53].name === 'GBaron'`.
2. **`scripts/SdBalance.ts` — `ART`, `BOSS`, `buildUnit`, `GROUND`/`QUEST` bands.**
   Re-key `ART[50..63]` to the corrected body files (`50 atabus, 51 attaban, 52 baka,
   53 baron, 54 bb, 55 bus, 56 dream, 57 dreamer, 60 medic, 61 rracer, 63 warchild`),
   delete 49/58/59/62 (return `unsupported`), change `ground = id >= 50 && id <= 63`,
   `npc = 64..75`, `boss = 76..84`, `finale: id === 84`, `escort: id 80 || 83`; re-key
   `BOSS` per §2 (76 baby, 79 xenon/x, 80 xsup, 81 snake1, 82 rud, 83 rui, 84 grafz;
   77/78 need the two SWF bitmaps imported as `bosses/boss2a/`, `bosses/boss2b/`).
   Re-key `QUEST` (64 Turik … 75 FargoWar). *Visible:* level 1 spawns `baron.pix3scene`
   instead of `bb`; L14/L23's id 63 becomes a truck.
3. **`scripts/WaveSpawner.ts` + `SdBalance.buildMission` — one clock.** Remove the
   `ground` split (`MissionDef.ground`, `groundEntries/groundFlags/groundElapsed/bridgeReady`)
   and spawn ground entries from `entries` on `elapsed` like everything else. Keep
   `BridgeController` launching carriers on `mission-started` (that matches
   `FN_startLevel` + the `t_enTP` timer); if a truck reaches the deck before the span
   closes the original simply lets it drive (no gate) — accept that, or clamp the truck's
   x to the last docked segment as a remaster-only nicety (call it out as such).
   `GROUND_FAMILY` becomes an explicit `Record<number,string>` `{50:'atabus',51:'attaban',
   52:'baka',53:'baron',54:'bb',55:'bus',56:'dream',57:'dreamer',60:'medic',61:'rracer',
   63:'warchild'}`. Also stop feeding `entry.tip` into `GroundVehicle.tip`; set
   `tip = id === 61 ? 13 : 12` (or a `rammer` flag on the unit def). *Visible:* level 1 —
   truck at 7 s, first on screen; L8/L12/L13/L14/L23/L26/L29 racers ram the gate.
4. **`src/assets/prefabs/units/nz-fire.pix3scene` (new) for id 25** — `Nazi_typical.png`
   body + `weapons/stone.png`… **note** the remaster's `stone.png` is 13×13, the SWF
   `Stoneb` is 13×25 (bomb + fuse): import `282_Stoneb.png` as `weapons/stoneb.png`;
   `weapons/littlebg.png` glow at (0,−28) pix3 y-up; a flame child (reuse the
   `slevin-fire` flame node) at (+16,−30) rotated 90°. Behaviour = bomber? **No** — `NZ_5`
   extends `Rider`, holds at `a` and never drops (`dropBomb` only toggles visibility on
   death); `EnemyBalloon` with `gunType` none. Route 25 → this prefab in `AIR_FAMILY`.
   *Visible:* level-1 zeppelin now has the burning bomb and no basket/gun.
5. **`units/baron.pix3scene` (+ the other mortar trucks) — add the gun and wheels**
   per §3 ground table: `Gun` = `ground/gun1.png` (24×9) as a child of a `Mount` group at
   (12, +23) pix3 (Flash (12,−23) with `scaleY −1` → barrel above the deck), barrel offset
   (23,−4) mirrored; two `wheel.png` children at (10.5,−6.5) and (−33.5,−6.5) pix3 and a
   ±1 px bob in `GroundVehicle` while moving. `GroundVehicle.gun` already looks for a
   child to recoil — name the node `Gun`. *Visible:* the user's "truck with the fat
   mortar" on level 1.

### P1 — the rest of level 1 and the same families everywhere

6. **Airplanes:** new `units/unik-plane.pix3scene` (`unik_nd.png` 56×23) and
   `units/urik-plane.pix3scene` (`urik_nd.png` 72×24) with a mount slot; route ids
   39–42 and 46–48 to them (39/40 gun variants, 41 torpedo, 42/48 burning, 47 mine).
   Their behaviour is still `Rider` (hold at `a`, shoot) — `EnemyBalloon` fits; drop
   them from `CompoundBalloon`. *Visible:* L1 "ATS" is a plane; L10/L28/L30's 47×
   `Unik_5` swarm becomes planes.
7. **Bomb-rack variants** (`Lavalon2_2` id 18 = 2× stone; `NZ_3`, `SUC_3`, `Lavalon1_3`,
   `Lavalon2_4`, `Avalon1_3`, `Avalon2_4`, `Urik_2` = mines; `Avalon2_2`, `SUC_4`, `Unik_3` =
   stones): one generic `bomb-rack` child group per prefab variant with the counts and
   offsets from §3. These classes are `Rider`/`Avalon` holders, not `Bomber`s — the bombs
   are visual load (dropped only via `dropBomb(false)` on kill), so no drop logic.
8. **Sniper barrels** (`NZ_2`, `SUC_2` ×2, `Unik_1/5`, `GAtabus`, `GBus`, `GWarchild`):
   add `weapons/typsnp.png` (import `325_B_TypSnp.png`, 55×10) and a `gunType: 'sniper'`
   with `rld_max 70` (NZ_2/SUC_2/Unik_1) or 25 (trucks) → `attackPeriod` 70/30 s vs 25/30 s.
9. **Torpedo variants** (`Avalon1_2` heavy `B_Torpedo`, `Avalon2_3` ×2 / `Lavalon1_2` /
   `Unik_2` / `Unik_7` light `B_LTorpedo`, `Urik_1` heavy, `Urik_3` `BigGun`): reuse the
   existing `weaponClass: 'torpedo'` path from `CompoundBalloon` or port it into
   `EnemyBalloon`.
10. **Burning variants** (`NZ_4`, `Lavalon2_3`, `Unik_8`, `Urik_6`): body + 2–3 flame
    children, no weapon; they only fly through/hold.

> **P1 status: DONE (steps 6–10, ids 1–48).** Implemented as ONE PREFAB PER CLASS.
> The 38 collapsed-family classes (ids 5–24, 26–29, 35–48) are **generated** from a
> rig table in `scripts/gen-levels.mjs` (`AIR_RIGS`, transcribed from each
> `com.enemy.*.init()`) into `src/assets/prefabs/units/`; the four bombers (1–4)
> were hand-corrected and `nz-fire` (25, P0) was left untouched. Routing is an
> explicit `AIR_CLASS` record in `WaveSpawner`. Planes confirmed against the
> sources and moved to `EnemyBalloon`: `Unik_5–8`/`Urik_4–6` build only
> `B_unik_nd`/`B_urik_nd` and never touch `B_*_s`/`_ropes`/`_body`, and the
> `M_Unik`/`M_Urik` clips those bitmaps live in render as a fighter and a biplane
> bomber — so `SdV15.categoryOf` now puts them in `air`, not `compound`.
> Review surface: the generated `src/assets/scenes/dev/air-gallery.pix3scene`.
>
> Three findings from the implementation worth recording:
> - **`grad` is an aim-MODE index, not an elevation.** `MainTimeline.moveTGMob`
>   maps it to the mount's `rotation` (0 = live tracking of the player's gun,
>   clamped 95°–175°; 1 = 160°; **≥2 = 180°**; 12 = 195°; 13 = 190°) and to the
>   `FN_MobStrike` shell branch. `GBaron`'s `grad = 11` is therefore a fixed 180°,
>   i.e. horizontal — no elevation is baked in, and none should be invented.
> - **`mobTG.scaleX = -1` makes the barrel point along +x INSIDE the mount** so
>   the container rotation can swing it onto the target; the 180° pose then puts
>   the barrel at `-(bx - w/2)` from the pivot. Step 5's `baron` placed the barrel
>   at `+(bx - w/2)` (it skipped the rotation), which put the mortar 22 px too far
>   back on the box — corrected here.
> - **`weapons/big_gun1.png` is pixel-identical to the SWF `325_B_TypSnp.png`**
>   (55×10), so step 8's "import `typsnp.png`" would have added a duplicate; the
>   sniper barrel was already in the project under the `BigGun` clip's frame name.
>   Same for `B_Mine` ≡ `B_minec` ≡ `weapons/mine_free.png` (19×18).

### P2 — ground/NPC/boss bands beyond level 1

11. Remaining truck prefabs per §3 (`attaban` 1 wheel + mortar, `baka`, `dream`/`dreamer`
    with `gun2.png`-style `B_gunD` 23×9, `bus`/`warchild` 2× sniper, `atabus` rear sniper,
    `bb`/`medic` + a `Wave` ring effect and their special behaviours — `GBB` sets
    `gun_tormoz` (player gun brake) while alive, `GMedic` heals `ar_enemies`).
    Delete `fatima`/`garbag`/`siege` prefabs or keep them out of the registry.
12. `QUEST` table shift (64–75) and `QUEST_LEVELS` re-check (L3 id 64 is `MTurik`, L7 id 71
    `MSheep`, L9 id 72 `MGold`, L11 69 `MLucky` + 70 `MZombee`, L21 73 `MLuckyGold`, L22 74
    `MPolicek`).
13. Boss art/ids per §2; import `B_boss2a`/`B_boss2b` (+`_w`, `_d`) from the SWF export for
    L10; `Bear` needs a gun rig (`TypGunMob` at (−2,+9)); `S_Xenon` ×42 and `Bear` ×40 are
    escorts (`escort: true`), `Boss3`/`Boss5` hold at `aim_y1`.
14. Docs: apply §3's "Corrections to release-v15/*.md"; regenerate
    `campaign-30-levels.summary.md`; update `unit-gallery.pix3scene` labels.

### Verification checklist (level 1)

- `UNITS[53].name === 'GBaron'`, `unitPrefabPath(53)` ends in `baron.pix3scene`.
- Play L1: at ~7 s a truck with a barrel is on the deck **before** any zeppelin; at 10 s an
  asterisk gasbag with a burning bomb (no basket) parks at `a=150`; at 37 s a plane with a
  gun and a Lavalon hull with two stones.
- `game_observe`: `enemies` children by prefab name in that order; no `GroundVehicle`
  with `tip 0` firing (all `12`), and on L8 racers (`61`) self-destruct at `x ≈ 100−320`.

---

## 6. Open questions (not settled by the SWF)

1. ~~**The "two thin ropes" under the level-1 zeppelin.**~~ **SETTLED (main session,
   after this audit): the ropes are drawn INTO the `Stoneb` bitmap.** `282_Stoneb.png`
   is 13x25 for a 13 px ball: the upper 12 px are **two vertical dark straps**, so
   `Stoneb` = ball + ropes as one sprite, and `NZ_5` needs no separate rope child.
   Composing `B_NZ` + `Stoneb` + `Littlebg` at this document's offsets reproduces the
   user's reference frame exactly. The remaster's `weapons/stone.png` is the same ball
   **cropped to 13x13**, which is why the ropes vanished; `weapons/rope.png` (8x21, two
   straps) exists separately and is the `MSheep`/`MTurik` hanger, not this.
   *Action:* import `282_Stoneb.png` as `weapons/stoneb.png` and use it (not `stone.png`)
   for every `Stoneb` rig; keep `stone.png` for the bare-stone racks.

   (superseded original note) **The "two thin ropes" under the level-1 zeppelin.** `NZ_5.init()` builds gasbag +
   `Stoneb` + `Burn1` + `Littlebg` and nothing else; no `B_rope`/`B_unik_ropes` bitmap and
   no `graphics.lineTo` in `NZ_5`, `Rider`, `MobObject`. Candidates: (a) the `Burn1` clip
   rotated 90° reads as two thin dark strokes when small; (b) `Stoneb`'s upper 12 px
   (it is 13×25 for a 13 px ball) contain a hanger drawn into the bitmap — the exported PNG
   suggests a fuse/cap rather than ropes; (c) memory of a different unit
   (`MSheep`/`MTurik` hang from `B_rope`). Settling it needs a frame render of the composed
   `NZ_5` — FFDec cannot execute `init()`; run the SWF in a Flash player/Ruffle and
   screenshot level 1 at t≈11 s, or trust the user's reference screenshot if it can be
   re-shared at native size.
2. **Exact wheel/gun bob and `Wave` visuals** for `GBB`/`GMedic` (`moveTVMob`,
   `kolvo_medic`) — behaviour read only at the `init()`/`kill()` level; `moveTVMob` in
   `MainTimeline` was not decompiled for this pass.
3. **`GAtabus` body `scaleX`** — decompiler left `scaleX = _loc1_` (value not recovered);
   likely a mirror flip (the only truck whose gun is not `scaleY −1`). Check the P-code
   before authoring.
4. **`Boss5` (id 81) = `snake1` 70×70 with 30000 hp on L25** looks odd but is what the
   class/bitmap link says (`B_boss5` = `84_com.MainTimeline_B_boss5.png` 70×70); the
   remaster's `snake` folder may be a cropped export. Compare pixels before trusting the
   size.
5. **40-level "survival" set** (`campaign-40-levels.waves.xml`) uses no id ≥ 49, so the
   ground shift does not affect survival — but its rig collapse (§3) does.
6. **Whether the remaster should gate trucks on the bridge at all.** The original does not;
   its timing merely makes the two coincide on level 1. The plan removes the gate; if a
   designer wants trucks to wait, that is a remaster decision, not fidelity.
