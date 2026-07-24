import { V15_UNITS, V15_CAMPAIGN, type V15Category } from './SdV15';
/**
 * SdBalance — the remaster's balance/data tables, converted from the original
 * game data (design/original-data/conf.xml, mobs.xml, units.txt) and the shop
 * layout of gui/shop/shop_bg.png. Pure data, no Script classes.
 */

// ── Shop ─────────────────────────────────────────────────────────────────────

export type ShopEffect =
  | 'floor' // castle floor (tier in `tier`)
  | 'flag' // +100 max HP, flag animation
  | 'turret' // auto-turret (slot key in `tier`: 1=TR1, 2=TR2, 3=AA)
  | 'umbrella' // damage shield under 75% HP
  | 'air-support' // periodic strike under 50% HP
  | 'mine-defender' // arms the bridge (ground assault, M4.2)
  | 'repair' // +HP, repeatable
  | 'weapon' // unlocks a main-gun weapon (key in `weapon`)
  | 'special' // weapon special: reload speed / fire shells / rail gun
  | 'power'; // weapon damage level 2

export interface ShopItem {
  id: string;
  name: string;
  /** One-line flavor text for the info panel (from shop-texts-en, shortened). */
  desc: string;
  price: number;
  /** Cell top-left in shop_bg.png native pixels (590×480, cells are 50×50). */
  cell: [number, number];
  /** Icon base name in gui/shop/ (`<icon>.png` dark, `<icon>_buy.png` golden). */
  icon: string;
  /** Item that must be owned first (baked prerequisite arrows). */
  requires?: string;
  effect: ShopEffect;
  /** floor: 2..4; turret: 1=TR1(floor2), 2=TR2(floor3), 3=AA(floor4). */
  tier?: number;
  weapon?: 'gun' | 'shotgun' | 'minigun' | 'rifle';
  /** Owned from the start of a run (Floor 1 and the basic Gun). */
  startsOwned?: boolean;
  /** Can be bought again and again (Repair). */
  repeatable?: boolean;
}

/**
 * All 24 positions of the original shop. Prices are the verified release
 * `<Shop>` vector from design/original-data/release-v15/conf.xml, mapped
 * row-major (6 per row) against references/screens/shop.jpg — no longer the
 * remaster's tuning stubs. Every other field is unchanged.
 */
export const SHOP_ITEMS: ShopItem[] = [
  // ── Tower column ──
  {
    id: 'floor-1', name: 'Castle Floor 1', price: 0, cell: [103, 94], icon: 'floor1',
    desc: 'Your humble hut. Everything starts here.', effect: 'floor', tier: 1, startsOwned: true,
  },
  {
    id: 'flag', name: 'Flag', price: 150, cell: [178, 94], icon: 'flag', requires: 'floor-1',
    desc: 'The flag of your Fatherland adds 100 Health Points.', effect: 'flag',
  },
  {
    id: 'floor-2', name: 'Castle Floor 2', price: 550, cell: [103, 169], icon: 'floor2', requires: 'floor-1',
    desc: 'Raises Castle HP to 1000. The main gun moves up here.', effect: 'floor', tier: 2,
  },
  {
    id: 'turret-1', name: 'Gun 1', price: 750, cell: [178, 169], icon: 'mortyr1', requires: 'floor-2',
    desc: 'An automatic turret to compensate your fluffs.', effect: 'turret', tier: 1,
  },
  {
    id: 'floor-3', name: 'Castle Floor 3', price: 3000, cell: [103, 243], icon: 'floor3', requires: 'floor-2',
    desc: 'Better accommodation: HP up to 1300 and one more gun slot.', effect: 'floor', tier: 3,
  },
  {
    id: 'turret-2', name: 'Gun 2', price: 950, cell: [178, 243], icon: 'mortyr2', requires: 'floor-3',
    desc: 'Perhaps in future you won’t have to shoot at all.', effect: 'turret', tier: 2,
  },
  {
    id: 'floor-4', name: 'Castle Floor 4', price: 4500, cell: [103, 318], icon: 'floor4', requires: 'floor-3',
    desc: 'No conservatory — an AA weapon platform. 1600 HP total.', effect: 'floor', tier: 4,
  },
  {
    id: 'air-gun', name: 'Air Gun', price: 1500, cell: [178, 318], icon: 'air_turrel', requires: 'floor-4',
    desc: 'Anti-aircraft weapon fires over the sights all by itself.', effect: 'turret', tier: 3,
  },

  // ── Devices column (icons follow the surviving resources24 art:
  //    zont.png is actually the mineman portrait, plane.png the biplane;
  //    the original umbrella art only exists inside later SWFs) ──
  {
    id: 'mine-defender', name: 'Crazy Mineman', price: 1550, cell: [269, 94], icon: 'zont',
    desc: 'Joe’s brother lays automatic mines on the bridge.', effect: 'mine-defender',
  },
  {
    id: 'air-support', name: 'Air Support', price: 570, cell: [269, 169], icon: 'plane',
    desc: 'Royal Air Cavalry strikes every 30 s while HP is under 50%.', effect: 'air-support',
  },
  {
    id: 'umbrella', name: 'Umbrella', price: 275, cell: [269, 243], icon: 'mine',
    desc: 'An invisible shield. Cuts damage while Castle HP is under 75%.', effect: 'umbrella',
  },
  {
    id: 'repair', name: 'Repair', price: 100, cell: [269, 340], icon: 'repair', repeatable: true,
    desc: 'Patch the walls: restores 400 Health Points.', effect: 'repair',
  },

  // ── Main gun column: weapon → special → power ──
  {
    id: 'gun', name: 'Big Gun', price: 0, cell: [362, 94], icon: 'pistol',
    desc: 'The Royal Armory classic. Better than nothing.', effect: 'weapon', weapon: 'gun', startsOwned: true,
  },
  {
    id: 'gun-reload', name: 'Reload Speed', price: 270, cell: [437, 94], icon: 'pistol1', requires: 'gun',
    desc: 'Cleaned and oiled: the Gun reloads much faster.', effect: 'special', weapon: 'gun',
  },
  {
    id: 'gun-power', name: 'Gun Power', price: 1000, cell: [512, 94], icon: 'pistol2', requires: 'gun',
    desc: 'Heavier cannonballs: 70 damage per hit.', effect: 'power', weapon: 'gun',
  },
  {
    id: 'shotgun', name: 'Shotgun', price: 750, cell: [362, 169], icon: 'shotgun',
    desc: 'Strikes with a fan of cannon balls. A Royal shotgun, no kidding!', effect: 'weapon', weapon: 'shotgun',
  },
  {
    id: 'fire-shells', name: 'Fire Shells', price: 1500, cell: [437, 169], icon: 'shotgun1', requires: 'shotgun',
    desc: 'Fargo found fire balls somewhere. High detonation, more damage.', effect: 'special', weapon: 'shotgun',
  },
  {
    id: 'shotgun-power', name: 'Shotgun Power', price: 3000, cell: [512, 169], icon: 'shotgun2', requires: 'shotgun',
    desc: 'Tighter charges: every pellet hits harder.', effect: 'power', weapon: 'shotgun',
  },
  {
    id: 'minigun', name: 'Minigun', price: 3000, cell: [362, 243], icon: 'minigun',
    desc: 'Four shells in four barrels, 100 bullets in the clip. A dream!', effect: 'weapon', weapon: 'minigun',
  },
  {
    id: 'minigun-reload', name: 'Reload Speed', price: 4000, cell: [437, 243], icon: 'minigun1', requires: 'minigun',
    desc: 'A trained loader crew keeps the drums coming.', effect: 'special', weapon: 'minigun',
  },
  {
    id: 'minigun-power', name: 'Minigun Power', price: 5000, cell: [512, 243], icon: 'minigun2', requires: 'minigun',
    desc: 'Hardened rounds: 70 damage per shell.', effect: 'power', weapon: 'minigun',
  },
  {
    id: 'rifle', name: 'Sniper Rifle', price: 4000, cell: [362, 318], icon: 'sniper',
    desc: 'One shot — one corpse. Powerful, accurate, slow to recharge.', effect: 'weapon', weapon: 'rifle',
  },
  {
    id: 'rail-gun', name: 'Rail Gun', price: 5000, cell: [437, 318], icon: 'sniper1', requires: 'rifle',
    desc: 'If only I had this from the beginning… the war would be over.', effect: 'special', weapon: 'rifle',
  },
  {
    id: 'rifle-power', name: 'Rifle Power', price: 6000, cell: [512, 318], icon: 'sniper2', requires: 'rifle',
    desc: 'Match-grade rounds for the long barrel.', effect: 'power', weapon: 'rifle',
  },
];

/** shop_bg.png native size; the scene shows it at 1003×816 (uniform ×1.7). */
export const SHOP_BG_NATIVE = { width: 590, height: 480 };

// ── Weapons (conf.xml <DMG>: X_1 = level 1, X_2 = level 2 (power)) ──────────

/** damage[special?][power?] — special = fire shells / rail gun variant. */
export const WEAPON_DAMAGE: Record<string, { base: [number, number]; special?: [number, number] }> = {
  gun: { base: [60, 70] },
  shotgun: { base: [20, 30], special: [40, 60] },
  minigun: { base: [60, 90] },
  rifle: { base: [200, 250], special: [300, 400] },
};

/** Reload-speed special (gun/minigun): reload time multiplier. */
export const RELOAD_SPECIAL_FACTOR = 0.55;

// ── Ammo (conf.xml <AMMO>: X_M = magazine count, X_A = rounds per magazine) ──
//
// magSize = _A (rounds loaded); reserve = (_M − 1) × _A (rounds behind the mag).
// The tier-2 specials swap the whole weapon to the ShotGun2 / Rifle2 vector:
//   ShotGun1 M3/A8  → ShotGun2 M1/A15 ; Rifle1 M3/A7 → Rifle2 M2/A3.
// gun/minigun have no `special` ammo entry (their special is Reload Speed, which
// changes reload time — see RELOAD_SPECIAL_FACTOR — not the ammo layout).

/** ammo[special?] — special = fire shells (shotgun) / rail gun (rifle) variant. */
export const WEAPON_AMMO: Record<
  string,
  { base: { magSize: number; reserve: number }; special?: { magSize: number; reserve: number } }
> = {
  gun: { base: { magSize: 50, reserve: 100 } },
  shotgun: { base: { magSize: 8, reserve: 16 }, special: { magSize: 15, reserve: 0 } },
  minigun: { base: { magSize: 70, reserve: 0 } },
  rifle: { base: { magSize: 7, reserve: 14 }, special: { magSize: 3, reserve: 3 } },
};

// ── Castle (conf.xml: floors 700/1000/1300/1600, flag +100) ─────────────────

// Real release values = conf.xml <ZHILKI> (hp_dom_max = HP_zh1..4). The remaster
// previously used a guessed 700/1000/1300/1600; the original is 250/500/800/1100.
export const CASTLE_FLOOR_HP: Record<number, number> = { 1: 250, 2: 500, 3: 800, 4: 1100 };
export const FLAG_HP_BONUS = 100;
export const REPAIR_AMOUNT = 400;
export const UMBRELLA_FACTOR = 0.7; // damage multiplier while HP < 75%
export const AIR_SUPPORT_PERIOD = 30; // seconds, while HP < 50%
export const AIR_SUPPORT_DAMAGE = 120;
export const AIR_SUPPORT_TARGETS = 3;

// ── Turrets (conf.xml <TRS>: dmg 10, period in 30 fps ticks, range 500) ─────

export interface TurretDef {
  /** ShopItem tier: 1=TR1, 2=TR2, 3=AA. */
  tier: number;
  damage: number;
  periodSec: number;
  range: number;
  /** Stage-local position on the castle (x, y). */
  position: [number, number];
}

export const TURRETS: TurretDef[] = [
  { tier: 1, damage: 30, periodSec: 1.0, range: 640, position: [-116, 22] },
  { tier: 2, damage: 40, periodSec: 2.67, range: 640, position: [-116, 108] },
  { tier: 3, damage: 40, periodSec: 1.4, range: 640, position: [-128, 208] },
];

// ── Bridge (decompiled v10.18: 4 transporters per level, x=750→282/427/572/717,
//    y=412, 4 px/frame @30fps, one spawn every ~50 ticks) ─────────────────────

export const BRIDGE = {
  /** Segment centers, stage-local (original stop x − 320). */
  segmentX: [-38, 107, 252, 397],
  /** Segment center height (original y≈404; transporter hull hangs below). */
  deckY: -164,
  /** Deck surface (segment top edge) — trucks and mines sit on this. */
  deckTopY: -154,
  /** Ground vehicles ride with their wheels on the deck (half truck height). */
  truckY: -137,
  spawnX: 470,
  /** 4 px/frame at 30 fps. */
  speed: 120,
  /** ~50 ticks between transporter launches. */
  stagger: 1.7,
};

// Crazy Mineman (shop). damage = release <EWETEG> uron (was 555, from the v10.18
// shop text; the release value takes priority per spec §7.7). respawnSec/radius/x
// stay as remaster tuning. The other <EWETEG> fields (hpostova/tormoz/lechilka)
// have unresolved semantics and are deliberately left unmapped.
export const DECK_MINE = { damage: 300, respawnSec: 10, radius: 60, x: -20 };

// ── Units (v15 release registry: FN_addMob id scheme 1-84) ─────────────
// Stats from SdV15 (conf.xml <Mob>); speed = original px/frame @30fps x30. Air
// units do NOT ram (castleDamage 0) — they park at their `a` and shell, or
// (bombers) drop and climb away. Ground truth: design/original-data/release-v15/.

export interface UnitDef {
  name: string;
  sprite: string;
  /** Display size (native texture px). */
  width: number;
  height: number;
  hp: number;
  /** Flight speed, stage px/s. */
  speed: number;
  score: number;
  /** Absolute castle HP a breakthrough costs (0 for air — no ram). */
  castleDamage: number;
  /** v15 category (air/compound/ground/npc/boss). */
  category: V15Category;
  /** Compound unit spawned from the unik/urik prefab instead. */
  compound?: boolean;
  /** Gun platforms: castle damage per attack while holding at `a`. */
  attackDamage?: number;
  attackPeriod?: number;
  /**
   * Gunship type (informational — the gun rig itself is baked into the family
   * prefab; EnemyBalloon reads its own baked config.gunType for recoil/shells).
   */
  gunType?: 'typical' | 'heavy';
  /** Bombers (Lucky/Slevin): carry ONE bomb, drop at `a`, then climb away. */
  bomber?: boolean;
  /** tpb 3 fire bomb (Stone + Burn1 flame) vs plain mine/stone. */
  fireBomb?: boolean;
  /** Ground vehicle: drives the bridge deck instead of flying. */
  ground?: boolean;
  /** Enemy transporter airship (S_SS): animated brown body + static red overlay. */
  transporter?: boolean;
  /** Boss (ids 75-84): driven by the generic boss.pix3scene + BossEnemy script. */
  boss?: boolean;
  /** Boss white-flash overlay texture (`B_bossN_w`). */
  whiteTex?: string;
  /** Boss emplacement guns shown (1-3). */
  gunCount?: number;
  /** Boss escort/mini-boss: same behaviour, but stays OFF the HUD boss bar. */
  escort?: boolean;
  /** Final boss (id 84): fires the King finale below 400 HP. */
  finale?: boolean;
  /** Quest NPC (ids 63-74): driven by quest-npc.pix3scene + QuestNpc script. */
  npc?: boolean;
  /** Quest role (protect/carrier/combat) from the QUEST table. */
  role?: QuestRole;
  /** Cargo class a carrier drops (0 none, 10 gold, 11 sheep, 12 cone). */
  payloadType?: number;
  /** Quest NPC body livery (re-textured on spawn). */
  npcTex?: string;
  /** Carrier payload livery (re-textured on the falling cargo). */
  payloadTex?: string;
  /** True until the prefab/behaviour is wired — spawner skips these gracefully. */
  unsupported?: boolean;
}

const AIR = 'res://src/assets/textures/enemy/air';
const GROUND = 'res://src/assets/textures/enemy/ground';
const TB = `${AIR}/typical_bloon`;
const TYP_VARIANTS = [`${TB}/SU_typical.png`, `${TB}/Nazi_typical.png`, `${TB}/Nevada_typical.png`];

/** Per-id art + display size (visuals not derivable from stats). */
interface Art { sprite: string; w: number; h: number; variants?: string[] }
const ART: Record<number, Art> = {
  1: { sprite: `${AIR}/bomber_lucky/bl.png`, w: 40, h: 45 },
  2: { sprite: `${AIR}/bomber_lucky/slpd.png`, w: 40, h: 45 },
  3: { sprite: `${AIR}/bomber_slevin/bslevin.png`, w: 40, h: 45 },
  4: { sprite: `${AIR}/bomber_slevin/bslevin.png`, w: 40, h: 45 },
  5: { sprite: `${AIR}/avalon1/avalon1.png`, w: 167, h: 46 },
  6: { sprite: `${AIR}/avalon1/avalon1.png`, w: 167, h: 46 },
  7: { sprite: `${AIR}/avalon1/avalon1.png`, w: 167, h: 46 },
  8: { sprite: `${AIR}/avalon1/avalon1.png`, w: 167, h: 46 },
  9: { sprite: `${AIR}/avalon2/avalon2.png`, w: 167, h: 46 },
  10: { sprite: `${AIR}/avalon2/avalon2.png`, w: 167, h: 46 },
  11: { sprite: `${AIR}/avalon2/avalon2.png`, w: 167, h: 46 },
  12: { sprite: `${AIR}/avalon2/avalon2.png`, w: 167, h: 46 },
  13: { sprite: `${AIR}/lavalon1/lavalon1.png`, w: 107, h: 30 },
  14: { sprite: `${AIR}/lavalon1/lavalon1.png`, w: 107, h: 30 },
  15: { sprite: `${AIR}/lavalon1/lavalon1.png`, w: 107, h: 30 },
  16: { sprite: `${AIR}/lavalon1/lavalon1.png`, w: 107, h: 30 },
  17: { sprite: `${AIR}/lavalon2/lavalon2.png`, w: 107, h: 30 },
  18: { sprite: `${AIR}/lavalon2/lavalon2.png`, w: 107, h: 30 },
  19: { sprite: `${AIR}/lavalon2/lavalon2.png`, w: 107, h: 30 },
  20: { sprite: `${AIR}/lavalon2/lavalon2.png`, w: 107, h: 30 },
  21: { sprite: `${TB}/Nazi_typical.png`, w: 66, h: 38, variants: TYP_VARIANTS },
  22: { sprite: `${TB}/Nazi_typical.png`, w: 66, h: 38, variants: TYP_VARIANTS },
  23: { sprite: `${TB}/Nazi_typical.png`, w: 66, h: 38, variants: TYP_VARIANTS },
  24: { sprite: `${TB}/Nazi_typical.png`, w: 66, h: 38, variants: TYP_VARIANTS },
  25: { sprite: `${TB}/Nazi_typical.png`, w: 66, h: 38, variants: TYP_VARIANTS },
  26: { sprite: `${TB}/SU_typical.png`, w: 66, h: 38, variants: TYP_VARIANTS },
  27: { sprite: `${TB}/SU_typical.png`, w: 66, h: 38, variants: TYP_VARIANTS },
  28: { sprite: `${TB}/SU_typical.png`, w: 66, h: 38, variants: TYP_VARIANTS },
  29: { sprite: `${TB}/SU_typical.png`, w: 66, h: 38, variants: TYP_VARIANTS },
  30: { sprite: `${AIR}/support/fatty.png`, w: 66, h: 136 },
  31: { sprite: `${AIR}/support/fish.png`, w: 106, h: 31 },
  32: { sprite: `${AIR}/support/splash.png`, w: 74, h: 32 },
  // S_SS (SWF class uses symbol `SS`) = the propeller TRANSPORTER airship, not a
  // zeppelin. Numerous fodder, no bomb — it just clutters. Brown `00000` skin +
  // red `over` livery variant (numeric frames are the propeller animation).
  33: {
    sprite: `${AIR}/transporter/00000.png`, w: 55, h: 29,
    variants: [`${AIR}/transporter/00000.png`, `${AIR}/transporter/over.png`],
  },
  34: { sprite: `${AIR}/support/nut.png`, w: 51, h: 29 },
  35: { sprite: `${AIR}/unik/unik_body.png`, w: 61, h: 33 },
  36: { sprite: `${AIR}/unik/unik_body.png`, w: 61, h: 33 },
  37: { sprite: `${AIR}/unik/unik_body.png`, w: 61, h: 33 },
  38: { sprite: `${AIR}/unik/unik_body.png`, w: 61, h: 33 },
  39: { sprite: `${AIR}/unik/unik_body.png`, w: 61, h: 33 },
  40: { sprite: `${AIR}/unik/unik_body.png`, w: 61, h: 33 },
  41: { sprite: `${AIR}/unik/unik_body.png`, w: 61, h: 33 },
  42: { sprite: `${AIR}/unik/unik_body.png`, w: 61, h: 33 },
  43: { sprite: `${AIR}/urik/urik_body.png`, w: 72, h: 24 },
  44: { sprite: `${AIR}/urik/urik_body.png`, w: 72, h: 24 },
  45: { sprite: `${AIR}/urik/urik_body.png`, w: 72, h: 24 },
  46: { sprite: `${AIR}/urik/urik_body.png`, w: 72, h: 24 },
  47: { sprite: `${AIR}/urik/urik_body.png`, w: 72, h: 24 },
  48: { sprite: `${AIR}/urik/urik_body.png`, w: 72, h: 24 },
  49: { sprite: `${GROUND}/atabus/atabus.png`, w: 81, h: 31 },
  50: { sprite: `${GROUND}/attaban/attaban.png`, w: 75, h: 33 },
  51: { sprite: `${GROUND}/baka/baka.png`, w: 83, h: 33 },
  52: { sprite: `${GROUND}/baron/baron.png`, w: 84, h: 38 },
  53: { sprite: `${GROUND}/bb/bb.png`, w: 80, h: 43 },
  54: { sprite: `${GROUND}/bus/bus.png`, w: 80, h: 33 },
  55: { sprite: `${GROUND}/dream/dream.png`, w: 90, h: 23 },
  56: { sprite: `${GROUND}/dreamer/dreamer.png`, w: 93, h: 24 },
  57: { sprite: `${GROUND}/fatima/fatima.png`, w: 100, h: 30 },
  58: { sprite: `${GROUND}/medic/medic.png`, w: 80, h: 32 },
  59: { sprite: `${GROUND}/rracer/rracer.png`, w: 70, h: 24 },
  60: { sprite: `${GROUND}/garbag/garbag.png`, w: 80, h: 38 },
  61: { sprite: `${GROUND}/siege/siege.png`, w: 62, h: 75 },
  62: { sprite: `${GROUND}/warchild/warchild.png`, w: 80, h: 27 },
};

// ── Bosses (ids 75-84) ──────────────────────────────────────────────────────
// BEST-EFFORT art mapping: only 5 boss art sets survive in the archive
// (baby/grafz/rud/snake/xenon) for 10 boss ids, so several ids REUSE a family as
// a placeholder — flagged below. Every path is Glob-verified to exist under
// src/assets/textures/enemy/bosses/; the sizes are the display sizes from the
// remaster spec and need in-editor visual confirmation. `_white` overlays that a
// family lacks fall back to a sibling family's white (noted per-id).
const BOSSES = 'res://src/assets/textures/enemy/bosses';

interface BossDef {
  art: string;
  whiteTex: string;
  width: number;
  height: number;
  gunCount: number;
  escort?: boolean;
  finale?: boolean;
}

const BOSS: Record<number, BossDef> = {
  // 75 Boss1 — mini-boss escort (1200 hp).
  75: { art: `${BOSSES}/snake/snake1.png`, whiteTex: `${BOSSES}/snake/snake1_white.png`, width: 70, height: 70, gunCount: 1, escort: true },
  // 76 Boss2a — L5 level-ender.
  76: { art: `${BOSSES}/baby/baby.png`, whiteTex: `${BOSSES}/baby/baby_white.png`, width: 214, height: 81, gunCount: 2 },
  // 77 Boss2b — L10.
  77: { art: `${BOSSES}/grafz/grafz.png`, whiteTex: `${BOSSES}/grafz/grafz_white.png`, width: 432, height: 79, gunCount: 3 },
  // 78 Boss3 — L10.
  78: { art: `${BOSSES}/rud/rud.png`, whiteTex: `${BOSSES}/rud/rud_white.png`, width: 207, height: 107, gunCount: 2 },
  // 79 S_Xenon — L15.
  79: { art: `${BOSSES}/xenon/x.png`, whiteTex: `${BOSSES}/xenon/x_white.png`, width: 164, height: 66, gunCount: 2 },
  // 80 Boss5 — escort swarm (L15). White FALLS BACK to xenon's x_white (no xsup_white).
  80: { art: `${BOSSES}/xenon/xsup.png`, whiteTex: `${BOSSES}/xenon/x_white.png`, width: 80, height: 32, gunCount: 1, escort: true },
  // 81 Boss4 — L25. REUSE grafz art (PLACEHOLDER — no dedicated Boss4 art in archive).
  81: { art: `${BOSSES}/grafz/grafz.png`, whiteTex: `${BOSSES}/grafz/grafz_white.png`, width: 432, height: 79, gunCount: 3 },
  // 82 Bear — L20. REUSE rud art (PLACEHOLDER — Bear needs FFDec B_bear extraction).
  82: { art: `${BOSSES}/rud/rud.png`, whiteTex: `${BOSSES}/rud/rud_white.png`, width: 207, height: 107, gunCount: 2 },
  // 83 Boss6 — escort (L20). White FALLS BACK to rud_white (no rui_white).
  83: { art: `${BOSSES}/rud/rui.png`, whiteTex: `${BOSSES}/rud/rud_white.png`, width: 55, height: 33, gunCount: 1, escort: true },
  // 84 FinalBoss — L30. REUSE grafz art (PLACEHOLDER — dedicated final art in a later SWF).
  84: { art: `${BOSSES}/grafz/grafz.png`, whiteTex: `${BOSSES}/grafz/grafz_white.png`, width: 432, height: 79, gunCount: 3, finale: true },
};

// ── Quest NPCs (ids 63-74) ───────────────────────────────────────────────────
// The special "quest" mechanics (protect / cargo-into-container / combat) run on
// the generic quest-npc.pix3scene + QuestNpc script. This table gives each id its
// ROLE, cargo class and BEST-EFFORT body/payload art — there is no dedicated
// quest-NPC art in the surviving archive, so several ids reuse a fitting
// interactive/npc sprite as a placeholder. FLAG (needs in-editor art review):
//   63 MTurik   → hunter.png       (no "Turik" art; reuse the hunter livery)
//   64 MFargo   → fargo_small       (in-world Fargo — fmain.png is a portrait)
//   66 MBob     → cityzen1          (generic citizen stand-in)
//   68 MLucky   → bomber_lucky      (reuse an air-unit livery)
//   69 MZombee  → firefly           (the "zom-bee" abductor — no dedicated art)
//   70 MSheep   → sheep             (carrier body IS a sheep — reads as airlifted)
//   71 MGold    → gold bar          (stands in for the defended gold pile/mine)
//   72 MLuckyGold → hunter          (robber carrying a gold bar)
//   73 MPolicek → policehunter      (golden-train guard carrying a cone/apple)
//   74 MFargoWar → fargoship        (Fargo's warship stand-in)
// Cargo art is real: gold.png (tpb10) / sheep.png (tpb11) / apple.png (tpb12).

const INTER = 'res://src/assets/textures/interactive';
const NPC = 'res://src/assets/textures/npc';

export type QuestRole = 'protect' | 'carrier' | 'combat';

export interface QuestDef {
  role: QuestRole;
  /** Cargo class: 0 none, 10 gold bar, 11 sheep, 12 cone/apple. */
  payloadType: number;
  npcTex: string;
  payloadTex?: string;
  width: number;
  height: number;
}

/** id (63-74) → quest role + art. questId/container come from QUEST_LEVELS. */
export const QUEST: Record<number, QuestDef> = {
  63: { role: 'combat', payloadType: 0, npcTex: `${INTER}/hunter/hunter.png`, width: 60, height: 44 },
  64: { role: 'protect', payloadType: 0, npcTex: `${NPC}/fargo_small/fs_1.png`, width: 44, height: 52 },
  65: { role: 'protect', payloadType: 0, npcTex: `${INTER}/wife/wife.png`, width: 44, height: 52 },
  66: { role: 'protect', payloadType: 0, npcTex: `${NPC}/cityzen1/c1_1.png`, width: 40, height: 50 },
  67: { role: 'protect', payloadType: 0, npcTex: `${NPC}/enginer/e_run_1.png`, width: 40, height: 50 },
  68: { role: 'combat', payloadType: 0, npcTex: `${AIR}/bomber_lucky/bl.png`, width: 40, height: 45 },
  69: { role: 'carrier', payloadType: 11, npcTex: `${INTER}/firefly/firefly.png`, payloadTex: `${INTER}/sheep/sheep.png`, width: 48, height: 40 },
  70: { role: 'carrier', payloadType: 11, npcTex: `${INTER}/sheep/sheep.png`, payloadTex: `${INTER}/sheep/sheep.png`, width: 48, height: 40 },
  71: { role: 'protect', payloadType: 0, npcTex: `${INTER}/drop_objects/gold.png`, width: 40, height: 28 },
  72: { role: 'carrier', payloadType: 10, npcTex: `${INTER}/hunter/hunter.png`, payloadTex: `${INTER}/drop_objects/gold.png`, width: 60, height: 44 },
  73: { role: 'carrier', payloadType: 12, npcTex: `${INTER}/hunter/policehunter.png`, payloadTex: `${INTER}/drop_objects/apple.png`, width: 60, height: 44 },
  74: { role: 'combat', payloadType: 0, npcTex: `${INTER}/fargo/fargoship.png`, width: 80, height: 50 },
};

// ── Quest levels ──────────────────────────────────────────────────────────────
// Level (1-based) → quest metadata: the verbatim objective (mission-objectives.txt,
// matched by CONTENT per campaign-structure.md — the arOpiska push-order is not
// 1:1 with <Lvl>), the success rule the tracker evaluates at wave-clear, the gold
// reward on success, and (cargo levels only) the stage-local landing rect for the
// boat / cup / truck. FLAG: container rects are BEST-EFFORT placeholders (no
// cup/boat/truck art or reliable positions survive — mission-positions.xml is a
// bare, ambiguous <p> array); reward amounts are best-effort from the objective
// flavor. successRule: protect = no guarded NPC killed; sheep = ≥5 saved; gold =
// ≤3 taken (bars that were NOT shot into the boat); cones = ≥10 collected; repair
// = ≥2 turrets; combat = clear the wave.

export type QuestSuccessRule = 'protect' | 'sheep' | 'gold' | 'cones' | 'repair' | 'combat';

export interface QuestLevelDef {
  questId: string;
  /** Verbatim (content-matched) objective text — mission-objectives.txt. */
  objective: string;
  successRule: QuestSuccessRule;
  /** Gold granted on success (0 = none / already paid in advance). */
  reward: number;
  /** Cargo levels only: stage-local landing rect (center-origin, Y-up). */
  container?: ContainerRect;
}

/** Stage-local cargo-container landing rect (center-origin, Y-up). */
export interface ContainerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Derive the stage-local container rect from an AUTHORED `quest-container` node
 * placed in the level scene (its position + size×scale), or null when no such
 * node is present. This lets a scene-per-level author drag/resize the boat/cup/
 * truck visually and have it drive the QuestCargo landing test — the placed node
 * becomes the single source of truth. Callers fall back to
 * {@link QUEST_LEVELS}`[level].container` when this returns null (main.pix3scene
 * and any level that hasn't authored a container yet).
 */
export function containerRectFromNode(node: unknown): ContainerRect | null {
  const n = node as
    | {
        position?: { x: number; y: number };
        scale?: { x: number; y: number };
        width?: number;
        height?: number;
      }
    | null
    | undefined;
  if (!n || !n.position) return null;
  const sx = Math.abs(n.scale?.x ?? 1);
  const sy = Math.abs(n.scale?.y ?? 1);
  return {
    x: n.position.x,
    y: n.position.y,
    w: (n.width ?? 100) * sx,
    h: (n.height ?? 100) * sy,
  };
}

/** 1-based level → quest def. Levels without an entry run as ordinary battles. */
export const QUEST_LEVELS: Record<number, QuestLevelDef> = {
  3: {
    questId: 'q-fargo-ship',
    objective: 'Protect the ship during the negotiations.',
    successRule: 'protect',
    reward: 200,
  },
  6: {
    questId: 'q-wife',
    objective: 'Your wife have gone shopping. You need to cover her take off and return.',
    successRule: 'protect',
    reward: 0,
  },
  7: {
    questId: 'q-gold-mine',
    objective: "Defend the gold mine from enemies. Don't let them steal the gold.",
    successRule: 'protect',
    reward: 0,
  },
  8: {
    // FLAG: no dedicated "Bob" objective survives — protect/escort stand-in text.
    questId: 'q-bob',
    objective: 'Protect Bob while he does his shopping.',
    successRule: 'protect',
    reward: 0,
  },
  9: {
    questId: 'q-lucky-gold',
    objective:
      'Enemies are trying to rob you again. Stop the pillage. Shoot off the stolen gold bars so they fall in the boat. Don’t take more than 3.',
    successRule: 'gold',
    reward: 100,
    container: { x: 0, y: -170, w: 360, h: 90 },
  },
  11: {
    questId: 'q-sheep',
    objective:
      'Save the sheep! At least 5 of them need to survive. There is a ship under them, so they will not die if they fall into it. Shoot off sheep so that they fall in the “cup”.',
    successRule: 'sheep',
    reward: 75,
    container: { x: 0, y: -180, w: 440, h: 90 },
  },
  14: {
    questId: 'q-turik-14',
    objective: 'Kick the enemy out of the province.',
    successRule: 'combat',
    reward: 0,
  },
  17: {
    // FLAG: L17 ("Mario") has no wave-grounded quest text — combat stand-in.
    questId: 'q-lucky-17',
    objective: 'Destroy all enemy forces.',
    successRule: 'combat',
    reward: 0,
  },
  19: {
    questId: 'q-engineer',
    objective:
      'The old defense system is out of order. Protect the workers who are repairing it. Repair at least two turrets.',
    successRule: 'repair',
    reward: 150,
  },
  21: {
    // FLAG: reward already paid in advance (500) per the objective — grant 0 here.
    questId: 'q-golden-train',
    objective: 'Shoot the cones off, so that they fall in the trucks. Fargo asks for 10 ones.',
    successRule: 'cones',
    reward: 0,
    container: { x: 0, y: -160, w: 460, h: 90 },
  },
  22: {
    questId: 'q-fargo-war',
    objective: 'Battle, another battle. Destroy them all.',
    successRule: 'combat',
    reward: 75,
  },
  23: {
    questId: 'q-turik-23',
    objective: 'Kick the enemy out of the province.',
    successRule: 'combat',
    reward: 0,
  },
};

/** Localization key of a 1-based mission's display name (see `locales/en.json`). */
export const missionNameKey = (mission1Based: number): string => `mission.name.${mission1Based}`;

/**
 * `res://` path of a campaign mission's dedicated level scene (scene-per-level).
 * Each `level-NN.pix3scene` is generated by `scripts/gen-levels.mjs` and carries
 * `startMission: NN`, so loading it plays that mission directly. The map/menu
 * hand-off still sets `__SD_MISSION` too (it takes precedence in GameFlow).
 */
export const levelScenePath = (mission1Based: number): string =>
  `res://src/assets/scenes/level-${String(mission1Based).padStart(2, '0')}.pix3scene`;

/** Localization key of a speaker's display name (`speaker.king` / `speaker.fargo` / `speaker.joe`). */
export const speakerKey = (speaker: Speaker): string => `speaker.${speaker.toLowerCase()}`;

/**
 * Official mission names (ar_disc, cannon_game_v15). English source of truth —
 * mirrored into `locales/en.json` (`mission.name.<n>`); display sites resolve
 * through {@link missionNameKey} so RU/other locales apply.
 */
export const MISSION_NAMES: readonly string[] = [
  'Prologue',
  'On Guard',
  'Royal Treasury',
  'Enemy At the Gate',
  'I need to go',
  'Touchy Issue',
  'A Steak',
  'Shopping',
  'Royal Gold 2',
  'Another Business Trip',
  'Lemmings',
  'Problems Start I',
  'Problems Start II',
  'Problems Start III',
  'The Real Fargo',
  'Apples of Hesperides',
  '"Mario"',
  'I\'ll Make You Rich',
  'Echo of War',
  'The Crucial Point',
  'The Golden Train',
  '"As good as Mozart"',
  'Pull Devil!',
  'Pull Devil! II',
  'Dragon\'s Rag',
  'Earl Furious',
  'That Damned King',
  'Near Go',
  'Prelude',
  'A Quick Mare Is In Time Everywhere',
];

function buildUnit(id: number): UnitDef {
  const v = V15_UNITS[id];
  const a = ART[id];
  const compound = id >= 35 && id <= 48;
  const ground = id >= 49 && id <= 62;
  const boss = id >= 75 && id <= 84;
  const npc = id >= 63 && id <= 74;
  const b = BOSS[id];
  const q = QUEST[id];
  return {
    name: v.cls,
    // Bosses/quest-NPCs carry their body livery on `sprite`; the generic prefab
    // (boss.pix3scene / quest-npc.pix3scene) re-sets it on spawn.
    sprite: boss ? b.art : npc ? q.npcTex : (a?.sprite ?? ''),
    width: boss ? b.width : npc ? q.width : (a?.w ?? 40),
    height: boss ? b.height : npc ? q.height : (a?.h ?? 40),
    hp: v.hp,
    speed: Math.round(v.speed * 30),
    score: v.score,
    castleDamage: 0,
    category: v.cat,
    compound: compound || undefined,
    ground: ground || undefined,
    boss: boss || undefined,
    whiteTex: boss ? b.whiteTex : undefined,
    gunCount: boss ? b.gunCount : undefined,
    escort: boss ? (b.escort || undefined) : undefined,
    finale: boss ? (b.finale || undefined) : undefined,
    transporter: id === 33 ? true : undefined,
    bomber: id >= 1 && id <= 4 ? true : undefined,
    fireBomb: id === 4 ? true : undefined,
    attackDamage: v.dmg,
    attackPeriod: ground ? 5 : 1.7,
    // Informational (rigs are baked in prefabs): Avalon1 = heavy nose gun,
    // Avalon2/Lavalon/NZ/SUC = typical basket gun.
    gunType: id >= 5 && id <= 8 ? 'heavy' : id >= 9 && id <= 29 ? 'typical' : undefined,
    // Quest NPCs (generic prefab + QuestNpc): role + cargo + art from QUEST.
    npc: npc || undefined,
    role: npc ? q.role : undefined,
    payloadType: npc ? q.payloadType : undefined,
    npcTex: npc ? q.npcTex : undefined,
    payloadTex: npc ? q.payloadTex : undefined,
    // Bosses + quest NPCs are now wired (generic prefab + script); only art-less
    // ordinary ids remain unsupported.
    unsupported: boss || npc ? undefined : a ? undefined : true,
  };
}

/** id (1-84) -> UnitDef, built from the v15 registry + art map. */
export const UNITS: Record<number, UnitDef> = Object.fromEntries(
  Array.from({ length: 84 }, (_, i) => i + 1).map(id => [id, buildUnit(id)])
);

// Air-unit COMPOSITION (gasbag + suspended baskets/guns/bombs) is baked into
// the per-family prefabs under src/assets/prefabs/units/ — authored from the
// decompiled com.enemy.*.init() offsets. Ground truth + table:
// design/original-data/release-v15/air-composition.md. Review visually on the
// dev scene src/assets/scenes/dev/unit-gallery.pix3scene.

// ── Missions (campaign = V15_CAMPAIGN, 30 levels verbatim) ──────────────

export interface MissionEntry {
  t: number;
  id: number;
  y: number;
  /** Original attack x (640-wide screen coords); 0 = fly through. */
  a: number;
  /** Behaviour variant (original `tip`): ground 13 = ram-and-self-destruct. */
  tip: number;
  /** Extra spawn parameter (original `dop`). */
  dop: number;
}

export interface MissionDef {
  name: string;
  entries: MissionEntry[];
  /** Ground assault (drives the bridge deck): waits for the bridge to build. */
  ground?: MissionEntry[];
}

function buildMission(levelIdx: number): MissionDef {
  const entries: MissionEntry[] = [];
  const ground: MissionEntry[] = [];
  for (const [t, id, y, a, tip, dop] of V15_CAMPAIGN[levelIdx]) {
    const u = UNITS[id];
    const e: MissionEntry = { t, id, y, a, tip, dop };
    if (u?.ground) ground.push(e);
    else entries.push(e);
  }
  return { name: MISSION_NAMES[levelIdx] ?? `Mission ${levelIdx + 1}`, entries, ground };
}

/** All 30 campaign missions, waves verbatim from the release build. */
export const MISSIONS: MissionDef[] = V15_CAMPAIGN.map((_, i) => buildMission(i));

// ── Campaign map + briefings (M4 meta) ──────────────────────────────────────

export type Speaker = 'King' | 'Fargo' | 'Joe';

/** Round dialog portraits (128×128, transparent corners) for the briefing panel. */
export const PORTRAITS: Record<Speaker, string> = {
  King: 'res://src/assets/textures/npc/king/talk1.png',
  Fargo: 'res://src/assets/textures/npc/fargo/fmain.png',
  Joe: 'res://src/assets/textures/npc/joe/main.png',
};

export interface BriefingLine {
  speaker: Speaker;
  /** Localization key of the line's text (`briefing.m<N>.<i>` / `epilogue.m<N>.<i>`, see locales/). */
  textKey: string;
}

export interface MissionMeta {
  /** Marker spot in conquest-map pixels (497×325 image, origin top-left). */
  spot: [number, number];
  region: string;
  /** Pre-battle dialog (GDD missions-dialogues; mission 1 uses the intro speech). */
  briefing: BriefingLine[];
  /** Localization key of the one-line objective shown after the dialog, before FIGHT. */
  goalKey: string;
  /**
   * Post-victory dialog (GDD missions-dialogues epilogues), played on the map
   * once per run after the mission first clears. The GDD numbers epilogues
   * one off — they are matched here by content (the payout follows the
   * mission that promised it).
   */
  epilogue?: BriefingLine[];
}

/**
 * All 30 original mission markers in conquest-map pixels (decompiled v10.18
 * `var_260`/`var_262` — selector centers on the 497×325 map). The campaign
 * opens bottom-left in Montarg and sweeps the Old World from there; M5 gets
 * the rest of the table.
 */
export const MISSION_SPOTS: [number, number][] = [
  [14, 297], [94, 291], [31, 239], [96, 219], [28, 180], [129, 196], [184, 195],
  [181, 265], [250, 224], [266, 288], [94, 146], [25, 123], [127, 105], [77, 39],
  [177, 39], [201, 133], [288, 154], [267, 84], [271, 22], [352, 62], [372, 157],
  [397, 106], [453, 112], [458, 36], [401, 25], [344, 288], [354, 234], [314, 202],
  [459, 191], [436, 282],
];

/** Dialog line: `briefing.m<N>.<i>` / `epilogue.m<N>.<i>` key (text lives in locales/). */
const line = (speaker: Speaker, textKey: string): BriefingLine => ({ speaker, textKey });

/**
 * Placeholder meta for missions whose full GDD dialogue isn't wired yet
 * (4–30): a single Fargo line + the default objective, keys still per-mission
 * so wiring the real dialogue later is a locales-only change.
 */
const stubMeta = (n: number): MissionMeta => ({
  spot: MISSION_SPOTS[n - 1],
  region: 'Montarg',
  briefing: [line('Fargo', `briefing.m${n}.1`)],
  goalKey: `mission.goal.${n}`,
});

/** Indexed as MISSIONS (mission 1 = [0]). Missions 1–3 defend Montarg. */
export const MISSION_META: MissionMeta[] = [
  {
    spot: MISSION_SPOTS[0],
    region: 'Montarg',
    briefing: [line('King', 'briefing.m1.1'), line('King', 'briefing.m1.2')],
    goalKey: 'mission.goal.1',
  },
  {
    spot: MISSION_SPOTS[1],
    region: 'Montarg',
    briefing: [
      line('Fargo', 'briefing.m2.1'),
      line('Fargo', 'briefing.m2.2'),
      line('Joe', 'briefing.m2.3'),
      line('Fargo', 'briefing.m2.4'),
      line('Joe', 'briefing.m2.5'),
    ],
    goalKey: 'mission.goal.2',
    // GDD "Mission 1: Epilogue" — the payout for On Guard's 100-gold promise.
    epilogue: [
      line('Fargo', 'epilogue.m2.1'),
      line('Joe', 'epilogue.m2.2'),
      line('Fargo', 'epilogue.m2.3'),
      line('Joe', 'epilogue.m2.4'),
      line('Fargo', 'epilogue.m2.5'),
      line('Joe', 'epilogue.m2.6'),
      line('Fargo', 'epilogue.m2.7'),
    ],
  },
  {
    spot: MISSION_SPOTS[2],
    region: 'Montarg',
    briefing: [
      line('Fargo', 'briefing.m3.1'),
      line('Fargo', 'briefing.m3.2'),
      line('Joe', 'briefing.m3.3'),
      line('Fargo', 'briefing.m3.4'),
    ],
    goalKey: 'mission.goal.3',
    // GDD "Mission 2: Epilogue" — the payout for Royal Treasury's repair promise.
    epilogue: [line('Fargo', 'epilogue.m3.1'), line('Joe', 'epilogue.m3.2'), line('Fargo', 'epilogue.m3.3')],
  },
  ...Array.from({ length: 27 }, (_, i) => stubMeta(i + 4)),
];

