# Air-unit composition — transcribed from decompiled `com.enemy.*.init()`

Ground truth for how each air unit is **assembled from layered display objects**
in the original (noAds.swf v15). Coordinates are the Flash values (y-DOWN, bitmaps
placed by top-left then centered with `x -= w>>1`); the **pix3** column converts to
our engine (y-UP, center-origin, body centered at 0,0). Bodies keep their native
px size (see `ART` in SdBalance). This replaces the earlier single-flat-sprite +
bolt-on-gun guess.

Legend: **body** = gasbag/hull; **korzina** = small hanging basket (`B_Korzina`,
20×13); **gondola** = full-size overlay (`B_AvalonC` 167×46 / `B_LavalonC` 107×30,
drawn aligned to the body, hidden until damaged); **TypGun** = `typical_gun` 23×9
barrel (points left, mirrored); **BigGun** = `big_gun1` 55×10; **torpedo** =
`torpedo.png` 72×12 (+ `littlebg` trail).

| ids | family | body | mounts (guns on baskets, pix3 x,y) | nose gun | gondola overlay | bomb |
|----:|--------|------|-----------------------------------|----------|-----------------|------|
| 1 | Lucky | bl / slpd 40×45 | — | — | — | mine (tpb1) |
| 2 | Lucky | bl 40×45 | — | — | — | stone (tpb2) |
| 3 | Slevin | bslevin 40×45 | — | — | — | mine (tpb1) |
| 4 | Slevin | bslevin 40×45 | — | — | — | **fire** (tpb3: stone+Burn1) |
| 5–8 | Avalon1 | avalon1 167×46 | — | **BigGun @ (−67,+4) mirrored** | avalon (hidden) | — |
| 9–12 | Avalon2 | avalon2 167×46 | **2× TypGun**: (−50,−16), (−8,−20) | — | avalon (hidden) | — |
| 13–16 | Lavalon1 | lavalon1 107×30 | 1× TypGun @ (−5,−11) | — | lavalon (hidden) | — |
| 17–20 | Lavalon2 | lavalon2 107×30 | 1× TypGun @ (−5,−11) | — | lavalon (hidden) | — |
| 21–25 | NZ | Nazi_typical 66×38 | 1× TypGun @ (0,−14) | — | — | — |
| 26–29 | SUC | SU_typical 66×38 | 1× TypGun @ (0,−14) | — | — | — |
| 30 | Fatty (SUP) | fatty 66×136 | — | — | — | — |
| 31 | Fish (SUP) | fish 106×31 | — | — | — | — |
| 32 | Splash (SUP)| splash 74×32 | — | — | — | — |
| 33 | S / SS | transporter (propeller) | — | — | — | — (separate prefab `transporter-enemy`) |
| 34 | Nut (SUP) | nut 51×29 | — | — | — | — |
| 35–42 | Unik | unik_s gasbags + ropes + unik_body carriage | 1× TypGun on carriage | — | — | — (compound prefab `unik`) |
| 43–48 | Urik | urik_s gasbags + ropes + urik_body carriage | **torpedo launcher** (`B_Torpedo`) | — | — | — (compound prefab `unik`, urik livery) |

## Source offsets (Flash, before y-up conversion)

- **Avalon1_1**: body centered (`y -= h/2+5`); `BigGun` added, `x = center.x − 67`,
  `y += 4`, `scaleX *= −1`; `B_AvalonC` centered, `visible = false` (damage frame).
- **Avalon2_1**: TWO `TypGunMob` at `(−51,18)` and `(−9,24)`; TWO `B_Korzina`:
  `1a x −= w/2+8` (center x −8), `y −= h/2−20` (center y +20 down);
  `1b x −= w/2+50` (center x −50), `y −= h/2−14` (center y +14 down); `B_AvalonC` hidden.
- **Lavalon1_1**: `TypGunMob (−6,14)`; `B_Korzina 1a x −= w/2+5` (x −5), `y −= h/2−11` (+11 down).
- **NZ_1**: `TypGunMob (0,17)`; `B_Korzina x −= w/2` (x 0), `y −= h/2−14` (+14 down).
- **SUC_1**: `TypGunMob (0,17)`; `B_Korzina x −= w/2` (x 0), `y −= h/2−14` (+14 down).
- Inside each `TypGunMob`: barrel `mobTG` at `(20,−4.5)` `scaleX=−1` (points left);
  muzzle flashes `FxMg1/FxMg2` at `(−23,15)`.
- **Bomber (`Bomber`/`class_108`)**: one bomb hung below body (`d1`, +27 y in Flash),
  dropped at the `a` mark; `dropBomb()` toggles `d1/d3` visibility.

## Weapons fired (`FN_MobStrike`, param3 = class)
- 0 light lobbed cannon (arc), sound `eshot1`; 1 heavy direct cannon, `eshot2`
  (Avalon: `FN_MobStrike(this,180,1,0)`); 2 torpedo/rocket (`com.Torpedo` + `littlebg`
  trail + `rail`), launchers `TorpedoGun`/`TorpedoGun2`, light `B_LTorpedo` (Urik).
- Every shot spawns a visible `Ball`/shell + `FxMg` muzzle flash.

## Death
Multi-point nose→tail detonation for everyone (`Avalon1_1.kill()` = 7× `addBumBumX`
+ `FN_addBumbum3`); bombers `FN_addBumbum1/2`; bosses `FN_addBumbumZep`.
