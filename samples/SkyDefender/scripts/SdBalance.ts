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
 * All 24 positions of the original shop (reference: shop.jpg + conf.xml
 * <Shop> prices where the garbled labels could be mapped; the rest is the
 * remaster's v1 tuning on the same scale).
 */
export const SHOP_ITEMS: ShopItem[] = [
  // ── Tower column ──
  {
    id: 'floor-1', name: 'Castle Floor 1', price: 0, cell: [103, 94], icon: 'floor1',
    desc: 'Your humble hut. Everything starts here.', effect: 'floor', tier: 1, startsOwned: true,
  },
  {
    id: 'flag', name: 'Flag', price: 100, cell: [178, 94], icon: 'flag', requires: 'floor-1',
    desc: 'The flag of your Fatherland adds 100 Health Points.', effect: 'flag',
  },
  {
    id: 'floor-2', name: 'Castle Floor 2', price: 150, cell: [103, 169], icon: 'floor2', requires: 'floor-1',
    desc: 'Raises Castle HP to 1000. The main gun moves up here.', effect: 'floor', tier: 2,
  },
  {
    id: 'turret-1', name: 'Gun 1', price: 100, cell: [178, 169], icon: 'mortyr1', requires: 'floor-2',
    desc: 'An automatic turret to compensate your fluffs.', effect: 'turret', tier: 1,
  },
  {
    id: 'floor-3', name: 'Castle Floor 3', price: 200, cell: [103, 243], icon: 'floor3', requires: 'floor-2',
    desc: 'Better accommodation: HP up to 1300 and one more gun slot.', effect: 'floor', tier: 3,
  },
  {
    id: 'turret-2', name: 'Gun 2', price: 100, cell: [178, 243], icon: 'mortyr2', requires: 'floor-3',
    desc: 'Perhaps in future you won’t have to shoot at all.', effect: 'turret', tier: 2,
  },
  {
    id: 'floor-4', name: 'Castle Floor 4', price: 1000, cell: [103, 318], icon: 'floor4', requires: 'floor-3',
    desc: 'No conservatory — an AA weapon platform. 1600 HP total.', effect: 'floor', tier: 4,
  },
  {
    id: 'air-gun', name: 'Air Gun', price: 100, cell: [178, 318], icon: 'air_turrel', requires: 'floor-4',
    desc: 'Anti-aircraft weapon fires over the sights all by itself.', effect: 'turret', tier: 3,
  },

  // ── Devices column (icons follow the surviving resources24 art:
  //    zont.png is actually the mineman portrait, plane.png the biplane;
  //    the original umbrella art only exists inside later SWFs) ──
  {
    id: 'mine-defender', name: 'Crazy Mineman', price: 100, cell: [269, 94], icon: 'zont',
    desc: 'Joe’s brother lays automatic mines on the bridge.', effect: 'mine-defender',
  },
  {
    id: 'air-support', name: 'Air Support', price: 100, cell: [269, 169], icon: 'plane',
    desc: 'Royal Air Cavalry strikes every 30 s while HP is under 50%.', effect: 'air-support',
  },
  {
    id: 'umbrella', name: 'Umbrella', price: 100, cell: [269, 243], icon: 'mine',
    desc: 'An invisible shield. Cuts damage while Castle HP is under 75%.', effect: 'umbrella',
  },
  {
    id: 'repair', name: 'Repair', price: 150, cell: [269, 340], icon: 'repair', repeatable: true,
    desc: 'Patch the walls: restores 400 Health Points.', effect: 'repair',
  },

  // ── Main gun column: weapon → special → power ──
  {
    id: 'gun', name: 'Big Gun', price: 0, cell: [362, 94], icon: 'pistol',
    desc: 'The Royal Armory classic. Better than nothing.', effect: 'weapon', weapon: 'gun', startsOwned: true,
  },
  {
    id: 'gun-reload', name: 'Reload Speed', price: 100, cell: [437, 94], icon: 'pistol1', requires: 'gun',
    desc: 'Cleaned and oiled: the Gun reloads much faster.', effect: 'special', weapon: 'gun',
  },
  {
    id: 'gun-power', name: 'Gun Power', price: 100, cell: [512, 94], icon: 'pistol2', requires: 'gun',
    desc: 'Heavier cannonballs: 70 damage per hit.', effect: 'power', weapon: 'gun',
  },
  {
    id: 'shotgun', name: 'Shotgun', price: 100, cell: [362, 169], icon: 'shotgun',
    desc: 'Strikes with a fan of cannon balls. A Royal shotgun, no kidding!', effect: 'weapon', weapon: 'shotgun',
  },
  {
    id: 'fire-shells', name: 'Fire Shells', price: 100, cell: [437, 169], icon: 'shotgun1', requires: 'shotgun',
    desc: 'Fargo found fire balls somewhere. High detonation, more damage.', effect: 'special', weapon: 'shotgun',
  },
  {
    id: 'shotgun-power', name: 'Shotgun Power', price: 100, cell: [512, 169], icon: 'shotgun2', requires: 'shotgun',
    desc: 'Tighter charges: every pellet hits harder.', effect: 'power', weapon: 'shotgun',
  },
  {
    id: 'minigun', name: 'Minigun', price: 100, cell: [362, 243], icon: 'minigun',
    desc: 'Four shells in four barrels, 100 bullets in the clip. A dream!', effect: 'weapon', weapon: 'minigun',
  },
  {
    id: 'minigun-reload', name: 'Reload Speed', price: 100, cell: [437, 243], icon: 'minigun1', requires: 'minigun',
    desc: 'A trained loader crew keeps the drums coming.', effect: 'special', weapon: 'minigun',
  },
  {
    id: 'minigun-power', name: 'Minigun Power', price: 100, cell: [512, 243], icon: 'minigun2', requires: 'minigun',
    desc: 'Hardened rounds: 70 damage per shell.', effect: 'power', weapon: 'minigun',
  },
  {
    id: 'rifle', name: 'Sniper Rifle', price: 100, cell: [362, 318], icon: 'sniper',
    desc: 'One shot — one corpse. Powerful, accurate, slow to recharge.', effect: 'weapon', weapon: 'rifle',
  },
  {
    id: 'rail-gun', name: 'Rail Gun', price: 2000, cell: [437, 318], icon: 'sniper1', requires: 'rifle',
    desc: 'If only I had this from the beginning… the war would be over.', effect: 'special', weapon: 'rifle',
  },
  {
    id: 'rifle-power', name: 'Rifle Power', price: 200, cell: [512, 318], icon: 'sniper2', requires: 'rifle',
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

/** Crazy Mineman (shop): numbers from the original shop text (v10.18). */
export const DECK_MINE = { damage: 555, respawnSec: 10, radius: 60, x: -20 };

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

/** Localization key of a 1-based mission's display name (see `locales/en.json`). */
export const missionNameKey = (mission1Based: number): string => `mission.name.${mission1Based}`;

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
  return {
    name: v.cls,
    sprite: a?.sprite ?? '',
    width: a?.w ?? 40,
    height: a?.h ?? 40,
    hp: v.hp,
    speed: Math.round(v.speed * 30),
    score: v.score,
    castleDamage: 0,
    category: v.cat,
    compound: compound || undefined,
    ground: ground || undefined,
    transporter: id === 33 ? true : undefined,
    bomber: id >= 1 && id <= 4 ? true : undefined,
    fireBomb: id === 4 ? true : undefined,
    attackDamage: v.dmg,
    attackPeriod: ground ? 5 : 1.7,
    // Informational (rigs are baked in prefabs): Avalon1 = heavy nose gun,
    // Avalon2/Lavalon/NZ/SUC = typical basket gun.
    gunType: id >= 5 && id <= 8 ? 'heavy' : id >= 9 && id <= 29 ? 'typical' : undefined,
    unsupported: a ? undefined : true,
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
  for (const [t, id, y, a] of V15_CAMPAIGN[levelIdx]) {
    const u = UNITS[id];
    const e: MissionEntry = { t, id, y, a };
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

