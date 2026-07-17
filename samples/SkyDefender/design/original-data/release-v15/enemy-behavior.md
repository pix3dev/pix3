# Sky Defender v15 — enemy behavior & composition (from AS3)

Decompiled from `noAds.swf` (`com.enemy.*`, `com.Bomber`, `com.Car`, `MainTimeline`).
This is the ground truth for how enemies are built and behave — several remaster
assumptions were wrong; those are flagged **REMASTER GAP**.

## Unit composition — everything hangs under a balloon

Air units are **NOT single sprites**. Each is a balloon/gasbag body with a **separately
suspended craft/gun/payload** as child display objects (`d1`/`d2`/`kor`/`up`/`down`):

- **Bomber (`Lucky_1`)** = `B_Lucky` balloon body (`d2`) **+ a `Mine` bomb suspended below it**
  (`d1`, offset +27 y). The bomb is its own sprite that stays until dropped.
- **Gunship (`Avalon1_1`)** = `B_Avalon1` balloon body (`d2`) **+ a `BigGun` suspended gun**
  (`d1`, offset x-67) that recoils and plays its fire animation (`gotoAndPlay(2)`) on each
  shot, **+ a gondola** (`B_AvalonC`, `kor`).
- **Compound (`Unik*`/`Urik*`)** = body + ropes + gondola, each an independent hitbox
  (already modelled in the remaster's `CompoundBalloon`).

> **REMASTER GAP:** the current remaster draws many units as one flat craft sprite
> ("самолёт на самолёте"). Correct model = **gasbag on top + craft/gun/gondola suspended
> beneath**, drawn as separate layered sprites. Art exists: `B_<name>` = body,
> `B_<name>C` = gondola/korzina, `BigGun`/`TypGunMob` = the weapon.

HP bars (`Hp`) are children too, and are **only visible when the cursor is near the unit**
(`iMob_dist < rad`, `rad≈40`) — see `MobObject.update`.

## Flight & the castle — balloons do NOT ram

`MobObject.update` (base): a live air unit that reaches the far left simply **despawns at
`x < -80`** — there is **no ram/collision damage** from air units. Damage to the castle
comes only from (a) weapons fired while parked, or (b) dropped bombs. `<a>` (attack-x) is
the x the unit flies to and holds.

- **`a = 0`** → flies straight across and off-screen (harmless fly-through) — unless it
  carries a bomb it drops en route.
- **`a > 0`** → **park-and-shoot**: advances until `x <= xx`, sets `att=false`, then fires on
  a reload cadence (`rld`) toward the castle with recoil. Pervasive from Lvl 2 on
  (Avalon/Lavalon, Unik/Urik gondola guns, and rank-and-file NZ/SUC/Slevin).

**Bomber flight (`Bomber.update`):** flies left bobbing on `sin(t)*8`; while `att && x<340`
it accelerates (`_speed += 0.05`, the run-up); at `x < xx` it calls `goAttack()` = **drops
its bomb (`FN_addBomb`) and sets `att=false`**, then **climbs and flies past** (`yy -= 0.5`
per frame, gaining altitude). Shot down while still carrying → drops the bomb at half speed.
So bombers **release payload and leave**, never ram. ✔ (matches your observation)

Only **ground vehicles ram** — see below.

## Bombs — plain vs fire (`FN_addBomb`, param `tpb`)

| tpb | Payload sprite | Type | Sound |
|---:|---|---|---|
| 1, 4 | `B_Mine` (naval mine) | plain | `edrop2` |
| 2 | `Stone` (iron/stone ball) | plain | `edrop2` |
| **3** | `Stone` **+ `Burn1` flame** (rotated) | **FIRE bomb** (burning, with flame child) | `edrop3` |
| 10 / 11 / 12 | gold bar / **sheep** / apple-cone | quest "payload" (shoot into cup/boat/truck) | — |

Bomb carriers by `tpb`: `Lucky_1`=1, `Lucky_2`=2, `Slevin_1`=1, **`Slevin_2`=3 (fire)**.
A dropped `Bomb` inherits the carrier's momentum, falls, and detonates on the castle/bridge.

> **REMASTER GAP:** document + implement both bomb variants (plain mine/stone vs
> fire-stone with a flame trail) and the distinct drop sounds.

## Enemy weapons (`FN_MobStrike`, param `param3` = weapon class)

Projectile is a `Ball` (bitmap `Ball1`). `param2` = angle, `param4` = muzzle-offset index.

- **`param3 = 0` — light arced cannon:** `dirx = cos(a)·8`, `diry = sin(a)·320` (lobbed arc),
  sound `eshot1`. Per-gun muzzle offsets (param4 0-10).
- **`param3 = 1` — heavy/direct cannon:** larger muzzle offsets (−100/−160 from unit x),
  `moveBallMob_2`, sound `eshot2`. (Avalon fires this: `FN_MobStrike(this,180,1,0)`.)
- **`param3 = 2` — torpedo/rocket:** `com.Torpedo` (has `lbg` = `Littlebg` trail + `rail`) —
  GDD: free-fall, then engine ignites and it flies straight, leaving a trail. Launchers:
  `TorpedoGun` / `TorpedoGun2`; light variant `B_LTorpedo`.

So enemy armament = **light lobbed cannon, heavy direct cannon, and torpedoes/rockets**
(plus the dropped bombs above). Muzzle flashes = `FxMg1`/`FxMg2`.

> **REMASTER GAP:** verify all three enemy weapon classes exist; the remaster should spawn a
> visible shell/`Ball` per shot with a muzzle flash (currently missing on some units).

## Ground vehicles (`com.Car` base + `G*` bodies)

Structure: body sprite + **multiple wheel sprites** (`d1`/`d2`/`d6`/`d7`/`d8`) that **bob on
suspension** as it drives (`Car.update` nudges each `+1` y on `t==3/6…`) + an optional gun
(`TypGunMob`, `tpg1/tpg2`) with `FxMg` muzzle flash. `GRracer` also carries the mine
component (`GRracer_B_minec`).

Behavior at the gate (`x < xx`):
- **`tip == 13` (rammer, e.g. GRracer):** `hp -= 500` + `damageDom(dmg)` → **rams and
  self-destructs** on the gate.
- otherwise: parks (wheels settle to `oldy`) and fires its cannon.
- **Bridge mine (Crazy Mineman):** if `est_mine && x < 220` the vehicle takes `hp -= 500`
  and the mine detonates under it (`addBumBumM`).

> **REMASTER GAP (yours):** ground vehicles are **missing their wheels** and **don't spawn a
> shell when firing**. Correct model = body + N bouncing wheel sprites + `TypGunMob` cannon
> that emits a `Ball` shell + `FxMg` flash; rammers self-destruct on contact.

## Death: multi-point detonation for everyone

Even regular gunships detonate in a **nose→tail chain**: `Avalon1_1.kill()` fires 7×
`addBumBumX` at spread offsets + `FN_addBumbum3`. Bombers use `FN_addBumbum1/2`; bosses use
`FN_addBumbumZep` (biggest chain + global BlowGlow, slow majestic fall). The chained
detonation is a core visual identity, not boss-only.
