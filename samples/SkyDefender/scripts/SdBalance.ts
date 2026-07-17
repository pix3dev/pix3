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
  gun: { base: [50, 70] },
  shotgun: { base: [25, 30], special: [40, 80] },
  minigun: { base: [50, 70] },
  rifle: { base: [100, 150], special: [200, 400] },
};

/** Reload-speed special (gun/minigun): reload time multiplier. */
export const RELOAD_SPECIAL_FACTOR = 0.55;

// ── Castle (conf.xml: floors 700/1000/1300/1600, flag +100) ─────────────────

export const CASTLE_FLOOR_HP: Record<number, number> = { 1: 700, 2: 1000, 3: 1300, 4: 1600 };
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
  { tier: 1, damage: 10, periodSec: 1.0, range: 500, position: [-116, 22] },
  { tier: 2, damage: 10, periodSec: 2.7, range: 500, position: [-116, 108] },
  { tier: 3, damage: 14, periodSec: 1.4, range: 620, position: [-128, 208] },
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

// ── Units (units.txt registry + conf.xml <Mob> stats) ───────────────────────

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
  /** Absolute castle HP a breakthrough costs. */
  castleDamage: number;
  /** Compound unit spawned from the unik prefab instead. */
  compound?: boolean;
  /** Bombers: castle damage per attack while holding at their `a` position. */
  attackDamage?: number;
  attackPeriod?: number;
  /**
   * Original class_108 bombing run (decompiled v10.18): the unit carries ONE
   * bomb, accelerates on approach, releases it at its `a` position and climbs
   * away instead of holding/ramming. `attackDamage` is the bomb's castle hit.
   */
  bomber?: boolean;
  /** Typical aerostats carry a naval mine on a rig (dropped when shot down). */
  carriesMine?: boolean;
  /** Alternate liveries — the spawner picks one at random per spawn. */
  spriteVariants?: string[];
  /** Ground vehicle: drives the bridge deck instead of flying. */
  ground?: boolean;
}

const AIR = 'res://src/assets/textures/enemy/air';
const GROUND = 'res://src/assets/textures/enemy/ground';

/** Only the ids used by the surviving mobs.xml (Lvl 1–3) + survival. */
export const UNITS: Record<number, UnitDef> = {
  // Lucky bombers (conf: hp 270, dmg 10) — original class_108 bombing run:
  // one carried bomb released at the `a` mark, then the freed ship climbs away.
  1: {
    name: 'Lucky 1', sprite: `${AIR}/bomber_lucky/bl.png`, width: 40, height: 45,
    hp: 270, speed: 42, score: 20, castleDamage: 80, attackDamage: 10, bomber: true,
  },
  2: {
    name: 'Lucky 2', sprite: `${AIR}/bomber_lucky/slpd.png`, width: 40, height: 45,
    hp: 270, speed: 42, score: 20, castleDamage: 80, attackDamage: 10, bomber: true,
  },
  // Slevin bombers (conf: hp 370; dev conf dmg is a placeholder 1 — bomb kept
  // at the remaster's tuned 12).
  3: {
    name: 'Slevin 1', sprite: `${AIR}/bomber_slevin/bslevin.png`, width: 40, height: 45,
    hp: 370, speed: 38, score: 25, castleDamage: 90, attackDamage: 12, bomber: true,
  },
  4: {
    name: 'Slevin 2', sprite: `${AIR}/bomber_slevin/bslevin.png`, width: 40, height: 45,
    hp: 370, speed: 38, score: 25, castleDamage: 90, attackDamage: 12, bomber: true,
  },
  // Avalon fighter wing (big zeppelin) — a gun platform, not a bomber: holds
  // at `a` and shells the castle. Cadence per the original mounted weapon
  // (class_63 default rld_max 50 ticks ≈ 1.7 s), damage rescaled to keep the
  // tuned pressure (dev conf <Mob> dmg is a placeholder 1).
  10: {
    name: 'Avalon 2-2', sprite: `${AIR}/avalon2/avalon2.png`, width: 167, height: 46,
    hp: 200, speed: 58, score: 30, castleDamage: 100, attackDamage: 4, attackPeriod: 1.7,
  },
  // Typical aerostat "S" (the Lvl 1 rank and file) — carries a hanging naval
  // mine on its weapon rig (GDD "миноносец"); the mine falls when the balloon
  // is shot down and detonates if it lands on the bridge.
  33: {
    name: 'S', sprite: `${AIR}/typical_bloon/SU_typical.png`, width: 66, height: 38,
    hp: 100, speed: 50, score: 8, castleDamage: 60, carriesMine: true,
    spriteVariants: [
      `${AIR}/typical_bloon/SU_typical.png`,
      `${AIR}/typical_bloon/Nazi_typical.png`,
      `${AIR}/typical_bloon/Nevada_typical.png`,
    ],
  },
  34: {
    name: 'S Nut', sprite: `${AIR}/typical_bloon/Nazi_typical.png`, width: 66, height: 38,
    hp: 100, speed: 50, score: 8, castleDamage: 60, carriesMine: true,
  },
  // Unik — compound aerostat (body/ropes/gondola prefab).
  39: {
    name: 'Unik 2-1', sprite: '', width: 0, height: 0,
    hp: 0, speed: 0, score: 0, castleDamage: 0, compound: true,
  },
  // Ground vehicles (drive the assembled bridge; ram the gate until killed).
  // Stats are remaster v1 tuning — the surviving dev mobs.xml has no ground
  // waves, but the original demo opens mission 1 with a truck on the bridge.
  50: {
    name: 'Attaban', sprite: `${GROUND}/attaban/attaban.png`, width: 75, height: 33,
    hp: 300, speed: 35, score: 25, castleDamage: 0, ground: true,
    attackDamage: 25, attackPeriod: 5,
  },
  51: {
    name: 'Garbag', sprite: `${GROUND}/garbag/garbag.png`, width: 80, height: 38,
    hp: 340, speed: 32, score: 30, castleDamage: 0, ground: true,
    attackDamage: 30, attackPeriod: 6,
  },
  52: {
    name: 'Baka', sprite: `${GROUND}/baka/baka.png`, width: 83, height: 33,
    hp: 380, speed: 30, score: 30, castleDamage: 0, ground: true,
    attackDamage: 30, attackPeriod: 5,
  },
};

// ── Missions (mobs.xml converted verbatim; t seconds, y in 640×480 coords) ──

export interface MissionEntry {
  t: number;
  id: number;
  y: number;
  /** Original attack x (640-wide screen coords); 0 = fly through to the castle. */
  a: number;
}

export interface MissionDef {
  name: string;
  entries: MissionEntry[];
  /**
   * Ground assault (drives the bridge deck): `t` counts from the moment the
   * bridge finishes assembling, `a` is the original hold x (→ stop position).
   */
  ground?: MissionEntry[];
}

/** mobs.xml `<Lvl n="1">` — 27 typical "S" balloons, exact times and heights. */
const MISSION_1: MissionEntry[] = [
  { t: 1, id: 33, y: 120, a: 0 }, { t: 1, id: 33, y: 300, a: 0 }, { t: 4, id: 33, y: 210, a: 0 },
  { t: 7, id: 33, y: 120, a: 0 }, { t: 7, id: 33, y: 300, a: 0 }, { t: 10, id: 33, y: 210, a: 0 },
  { t: 13, id: 33, y: 210, a: 0 }, { t: 14, id: 33, y: 180, a: 0 }, { t: 14, id: 33, y: 240, a: 0 },
  { t: 15, id: 33, y: 150, a: 0 }, { t: 15, id: 33, y: 270, a: 0 }, { t: 16, id: 33, y: 120, a: 0 },
  { t: 16, id: 33, y: 300, a: 0 }, { t: 17, id: 33, y: 90, a: 0 }, { t: 17, id: 33, y: 330, a: 0 },
  { t: 18, id: 33, y: 60, a: 0 }, { t: 18, id: 33, y: 360, a: 0 }, { t: 21, id: 33, y: 210, a: 0 },
  { t: 22, id: 33, y: 210, a: 0 }, { t: 23, id: 33, y: 210, a: 0 }, { t: 22, id: 33, y: 180, a: 0 },
  { t: 22, id: 33, y: 240, a: 0 }, { t: 27, id: 33, y: 210, a: 0 }, { t: 26, id: 33, y: 180, a: 0 },
  { t: 28, id: 33, y: 180, a: 0 }, { t: 26, id: 33, y: 240, a: 0 }, { t: 28, id: 33, y: 240, a: 0 },
];

/** mobs.xml `<Lvl n="2">` — Lucky/Slevin bombers, an Avalon and the first Unik. */
const MISSION_2: MissionEntry[] = [
  { t: 1.1, id: 1, y: 150, a: 230 },
  { t: 1, id: 10, y: 200, a: 150 },
  { t: 2, id: 2, y: 100, a: 300 },
  { t: 5, id: 39, y: 240, a: 320 },
  { t: 1, id: 3, y: 250, a: 110 },
  { t: 1, id: 3, y: 300, a: 110 },
  { t: 1, id: 3, y: 350, a: 110 },
];

/** mobs.xml `<Lvl n="3">` — a lone compound Unik (the dev build's finale). */
const MISSION_3: MissionEntry[] = [{ t: 5, id: 39, y: 240, a: 320 }];

export const MISSIONS: MissionDef[] = [
  // Official mission names from the GDD list (mission-names-en.txt).
  // The original demo opens with the bridge assembling and a lone truck
  // driving up while the S wave flies in.
  { name: 'Prologue', entries: MISSION_1, ground: [{ t: 2, id: 50, y: 0, a: 250 }] },
  {
    name: 'On Guard',
    entries: MISSION_2,
    ground: [
      { t: 2, id: 50, y: 0, a: 250 },
      { t: 14, id: 51, y: 0, a: 330 },
    ],
  },
  { name: 'Royal Treasury', entries: MISSION_3, ground: [{ t: 3, id: 52, y: 0, a: 250 }] },
];

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
  text: string;
}

export interface MissionMeta {
  /** Marker spot in conquest-map pixels (497×325 image, origin top-left). */
  spot: [number, number];
  region: string;
  /** Pre-battle dialog (GDD missions-dialogues; mission 1 uses the intro speech). */
  briefing: BriefingLine[];
  /** One-line objective shown after the dialog, before FIGHT. */
  goal: string;
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

/** Indexed as MISSIONS (mission 1 = [0]). Missions 1–3 defend Montarg. */
export const MISSION_META: MissionMeta[] = [
  {
    spot: MISSION_SPOTS[0],
    region: 'Montarg',
    briefing: [
      {
        speaker: 'King',
        text:
          'Joe, we have little time, so I will be brief. The war has reached our last province — it still stands only thanks to you.',
      },
      {
        speaker: 'King',
        text:
          'Your home and your fortress are part of an ancient defence system. Every province we win back will work for you, Joe — so your tower grows stronger. So that WE can win.',
      },
    ],
    goal: 'Destroy all enemy forces.',
  },
  {
    spot: MISSION_SPOTS[1],
    region: 'Montarg',
    briefing: [
      {
        speaker: 'Fargo',
        text:
          'Well, Joe... We have a little problem. Enemy scouts have run into us. There is just a handful of them, but soon the hordes will follow.',
      },
      {
        speaker: 'Fargo',
        text:
          'Destroy everything that can be destroyed. Oh, yes! If you do well, you will be generously rewarded by the company.',
      },
      { speaker: 'Joe', text: 'How generously?' },
      { speaker: 'Fargo', text: 'One hundred Gold.' },
      { speaker: 'Joe', text: "I'll do my best." },
    ],
    goal: 'Destroy all enemy forces. (Bonus: 100 gold)',
    // GDD "Mission 1: Epilogue" — the payout for On Guard's 100-gold promise.
    epilogue: [
      { speaker: 'Fargo', text: "Well, Joe, here's your hard-earned 70 Gold." },
      { speaker: 'Joe', text: 'Actually, we agreed on 100 Gold.' },
      {
        speaker: 'Fargo',
        text: 'Joe, are you a law-abiding citizen? Have you heard about taxes?',
      },
      {
        speaker: 'Joe',
        text: 'Yes, Fargo, I know what taxes are: I work — you screw around, and the treasury grows. Have I got it right?',
      },
      {
        speaker: 'Fargo',
        text: "I bet you haven't heard about the impudence tax yet, my dear old Joe. I've just invented it, by the way.",
      },
      { speaker: 'Joe', text: 'Moron.' },
      { speaker: 'Fargo', text: "You are welcome, Joe. Ok, let's turn to our muttons." },
    ],
  },
  {
    spot: MISSION_SPOTS[2],
    region: 'Montarg',
    briefing: [
      {
        speaker: 'Fargo',
        text:
          'Joe, you may have noticed that I turn to you only with problems. Such is life: I find problems — you solve them.',
      },
      {
        speaker: 'Fargo',
        text:
          'Damned invaders continue their wicked work. This time their target is the Royal gold mine. Do not let them rob me... ahem, rob the King. If everything goes smoothly, I promise to repair your tower.',
      },
      { speaker: 'Joe', text: 'Are you going to deduct the impudence tax again?' },
      { speaker: 'Fargo', text: 'Depends on your behavior, my dear Joe.' },
    ],
    goal: "Defend the Royal gold mine — don't let them steal the gold.",
    // GDD "Mission 2: Epilogue" — the payout for Royal Treasury's repair promise.
    epilogue: [
      { speaker: 'Fargo', text: "Well done, Joe. I've given an order to repair your tower." },
      { speaker: 'Joe', text: 'How many percent will they repair?' },
      { speaker: 'Fargo', text: 'Depends on your deeds, Joe. Depends on your deeds...' },
    ],
  },
];
