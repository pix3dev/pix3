// gen-levels.mjs — regenerate the v15 unit registry, then one campaign level
// scene per mission.
//
// Scene-per-level: each mission is its own `level-NN.pix3scene` = the shared
// battle skeleton (game-root + inline stage/playfield) with the reusable chrome
// (HUD/shop/result) and castle as prefab INSTANCES, plus `startMission: NN` so
// the level declares which campaign mission it runs. Cargo-quest levels (those
// with a QUEST_LEVELS container) additionally get a visually-placed
// `quest-container` node — the authored source of truth for the landing rect.
//
// Everything is DERIVED FROM SOURCE (no duplicated data):
//   - unit registry   ← conf.xml <Mob> rows + the FN_addMob switch (see below)
//   - mission count   ← V15_CAMPAIGN rows (scripts/SdV15.ts)
//   - container rects ← QUEST_LEVELS[...].container (scripts/SdBalance.ts)
//   - scene skeleton  ← level-01.pix3scene (the canonical template)
//
// Run from the sample root:  node scripts/gen-levels.mjs
import fs from 'node:fs';

const SCENES = 'src/assets/scenes';
const TEMPLATE = `${SCENES}/level-01.pix3scene`;
const CONF = 'design/original-data/release-v15/conf.xml';
const V15_FILE = 'scripts/SdV15.ts';
const pad = n => String(n).padStart(2, '0');

// ── 0) V15_UNITS: conf.xml stats × the FN_addMob id→class switch ─────────────
//
// `FN_addMob` (com.MainTimeline) is a TWO-STAGE switch and the second stage is
// what decides the ART. Stage 1 (MT lines 4919-5236) turns the spawn id into a
// 0-based class index: it is `id - 1` only up to 48. There is **no `case 49`**;
// from id 50 upward every id maps to `id - 2` (verbatim P-code: `case 50:
// §§push(48)`, `case 53: §§push(51)`, … `case 84: §§push(82)`), and anything
// unlisted falls to `push(83)`, which has no constructor. Stage 2 (MT lines
// 5238-5811) is the constructor list below, in switch order.
//
// Three independent confirmations that the ground band is ids 50-63 (not 49-62):
//   1. `if(param1 >= 50 && param1 <= 63) { _loc6_.y = 380; }` — the deck height
//      is forced for exactly that id range.
//   2. `if(param1 == 64 || … 68 || 75)` sets the NPC aim points, and only
//      `Boss3`/`Boss5` declare `aim_y1` — ids 79/81 under this mapping.
//   3. Every `G*.kill()` passes a `CorsetCar` wreck slot (1..14, alphabetical);
//      slots 9 fatima / 10 garbag / 13 siege are passed by nobody — exactly the
//      three constructor-less cases below.
//
// Stats are NOT shifted: the tail of `FN_addMob` reads them with
// `_loc8_ = param1 - 1`, so the `conf.xml` `<Mob id=N>` row still belongs to
// spawn id N. Only the class/art column moves.

/** Stage 1: spawn id → 0-based class index (null = stage-1 `default`, throws). */
const classIndex = id => (id <= 48 ? id - 1 : id >= 50 ? id - 2 : null);

/** Stage 2: the constructor list, in switch order. `null` = case with no `new`. */
const CONSTRUCTORS = [
  /*  0 */ 'Lucky_1', 'Lucky_2', 'Slevin_1', 'Slevin_2',
  /*  4 */ 'Avalon1_1', 'Avalon1_2', 'Avalon1_3', 'Avalon1_4',
  /*  8 */ 'Avalon2_1', 'Avalon2_2', 'Avalon2_3', 'Avalon2_4',
  /* 12 */ 'Lavalon1_1', 'Lavalon1_2', 'Lavalon1_3', 'Lavalon1_4',
  /* 16 */ 'Lavalon2_1', 'Lavalon2_2', 'Lavalon2_3', 'Lavalon2_4',
  /* 20 */ 'NZ_1', 'NZ_2', 'NZ_3', 'NZ_4', 'NZ_5',
  /* 25 */ 'SUC_1', 'SUC_2', 'SUC_3', 'SUC_4',
  /* 29 */ 'S_Fatty', 'S_Fish', 'S_Splash', 'S_SS', 'S_Nut',
  /* 34 */ 'Unik_1', 'Unik_2', 'Unik_3', 'Unik_4', 'Unik_5', 'Unik_6', 'Unik_7', 'Unik_8',
  /* 42 */ 'Urik_1', 'Urik_2', 'Urik_3', 'Urik_4', 'Urik_5', 'Urik_6',
  /* 48 */ 'GAtabus', 'GAtaban', 'GBaka', 'GBaron', 'GBB', 'GBus', 'GDream', 'GDreamer',
  /* 56 */ null, null, 'GMedic', 'GRracer', null, 'GWarchild',
  /* 62 */ 'MTurik', 'MFargo', 'MWife', 'MBob', 'MEngin', 'MLucky',
  /* 68 */ 'MZombee', 'MSheep', 'MGold', 'MLuckyGold', 'MPolicek', 'MFargoWar',
  /* 74 */ 'Boss1', 'Boss2a', 'Boss2b', 'Boss3', 'S_Xenon', 'Boss5', 'Boss4', 'Bear', 'Boss6',
];

/**
 * The three constructor-less ground cases are CUT content: `-dumpAS3` over all
 * 576 scripts finds no `GFatima`/`GGarbag`/`GSiege`, only their `CorsetCar_B_*_d`
 * wreck bitmaps, and the campaign spawns their ids zero times. Labelled by the
 * wreck livery whose `CorsetCar` slot nobody claims.
 */
const CUT_LABEL = { 56: '(cut: fatima)', 57: '(cut: garbag)', 60: '(cut: siege)' };

/**
 * Seven of the fourteen `Unik`/`Urik` classes are NOT rope-hung compounds: their
 * `init()` builds a single `B_unik_nd` (56x23) / `B_urik_nd` (72x24) airframe and
 * never touches `B_*_s` / `B_*_ropes` / `B_*_body`, and the `M_Unik`/`M_Urik`
 * clips those bitmaps live in render as a fighter and a biplane bomber. They are
 * plain single-body riders, so they belong to `air` (EnemyBalloon), not to
 * `compound` (CompoundBalloon, which takes gasbags/ropes/carriage apart).
 */
const PLANES = new Set(['Unik_5', 'Unik_6', 'Unik_7', 'Unik_8', 'Urik_4', 'Urik_5', 'Urik_6']);

/** Class index band → V15Category (`cut` = no constructor, spawning throws). */
const categoryOf = idx =>
  idx === null ? 'cut'
  : CONSTRUCTORS[idx] === null ? 'cut'
  : idx <= 33 ? 'air'
  : idx <= 47 ? (PLANES.has(CONSTRUCTORS[idx]) ? 'air' : 'compound')
  : idx <= 61 ? 'ground'
  : idx <= 73 ? 'npc'
  : 'boss';

/** conf.xml `<Mob id=N>` → { hp, speed, dmg, score }, keyed by spawn id. */
function readMobStats() {
  const xml = fs.readFileSync(CONF, 'utf8');
  const stats = {};
  const row = /<Mob id="(\d+)">([\s\S]*?)<\/Mob>/g;
  for (let m; (m = row.exec(xml)); ) {
    const field = name => {
      const f = m[2].match(new RegExp(`<${name}>([^<]*)</${name}>`));
      if (!f) throw new Error(`conf.xml <Mob id="${m[1]}"> has no <${name}>`);
      return Number(f[1]);
    };
    stats[Number(m[1])] = { hp: field('hp'), speed: field('speed'), dmg: field('dmg'), score: field('score') };
  }
  if (!Object.keys(stats).length) throw new Error('no <Mob> rows in conf.xml');
  return stats;
}

/** Rewrite the `V15_UNITS` object literal in scripts/SdV15.ts in place. */
function regenV15Units() {
  const stats = readMobStats();
  const ids = Object.keys(stats).map(Number).sort((a, b) => a - b);
  const rows = ids.map(id => {
    const idx = classIndex(id);
    const cls =
      idx === null ? '(unmapped)'
      : (CONSTRUCTORS[idx] ?? CUT_LABEL[idx] ?? '(cut)');
    const s = stats[id];
    const line = `  ${id}: { cls: '${cls}', cat: '${categoryOf(idx)}', hp: ${s.hp}, speed: ${s.speed}, dmg: ${s.dmg}, score: ${s.score} },`;
    // Cut ids get their reason inline — they are the ones a reader trips over.
    if (idx === null) return `${line} // no stage-1 case → idx 83 → null → TypeError`;
    if (CONSTRUCTORS[idx] === null) return `${line} // stage-2 case ${idx} sets \`tip\` on a null local`;
    return line;
  });

  const src = fs.readFileSync(V15_FILE, 'utf8');
  const head = 'export const V15_UNITS: Record<number, V15Unit> = {\n';
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`could not find V15_UNITS in ${V15_FILE}`);
  const end = src.indexOf('\n};\n', start);
  if (end < 0) throw new Error(`unterminated V15_UNITS literal in ${V15_FILE}`);
  const next = src.slice(0, start + head.length) + rows.join('\n') + src.slice(end);
  if (next !== src) fs.writeFileSync(V15_FILE, next);
  return { ids: ids.length, changed: next !== src };
}

const units = regenV15Units();
console.log(
  `V15_UNITS: ${units.ids} ids ${units.changed ? 'rewritten' : 'already up to date'} → ${V15_FILE}`
);

// 1) mission count = number of V15_CAMPAIGN rows
const v15 = fs.readFileSync('scripts/SdV15.ts', 'utf8');
const campStart = v15.indexOf('V15_CAMPAIGN');
const campEnd = v15.indexOf('export const', campStart + 10);
const campBlock = v15.slice(campStart, campEnd < 0 ? undefined : campEnd);
const MISSIONS = (campBlock.match(/\/\* Lvl /g) || []).length;
if (!MISSIONS) throw new Error('could not count V15_CAMPAIGN missions');

// 2) container rects from QUEST_LEVELS (line scan: track the current level key)
const containers = {}; // level -> {x,y,w,h}
{
  let inQL = false;
  let level = null;
  for (const line of fs.readFileSync('scripts/SdBalance.ts', 'utf8').split('\n')) {
    if (/export const QUEST_LEVELS/.test(line)) inQL = true;
    if (!inQL) continue;
    const key = line.match(/^\s{2}(\d+):\s*\{/);
    if (key) level = Number(key[1]);
    const c = line.match(/container:\s*\{\s*x:\s*(-?\d+),\s*y:\s*(-?\d+),\s*w:\s*(-?\d+),\s*h:\s*(-?\d+)/);
    if (c && level != null) containers[level] = { x: +c[1], y: +c[2], w: +c[3], h: +c[4] };
    if (line.startsWith('};')) break; // end of the QUEST_LEVELS object literal
  }
}

// 3) emit level-NN.pix3scene from the template
// Split on \r?\n: a CRLF working copy (git autocrlf on Windows) would otherwise
// leave a trailing \r on every line, and the exact-match anchor below
// (`- id: effects`) would silently never fire — dropping the quest containers.
const template = fs.readFileSync(TEMPLATE, 'utf8').split(/\r?\n/);
// The template (level-01) already carries a `startMission` once it has been
// generated at least once — insert one after `countdownSeconds` ONLY when it
// does not, or every re-run appends a duplicate key.
const templateHasStartMission = template.some(l => /^          startMission:/.test(l));
const containerNode = r => [
  '          - id: quest-container',
  '            name: Quest Container',
  '            instance: res://src/assets/prefabs/quest-container.pix3scene',
  '            properties:',
  `              width: ${r.w}`,
  `              height: ${r.h}`,
  '              transform:',
  `                position: [${r.x}, ${r.y}]`,
  '                scale: [1, 1]',
  '                rotation: 0',
];

for (let n = 1; n <= MISSIONS; n++) {
  const rect = containers[n];
  let sawStartMission = false;
  const out = [];
  for (const line of template) {
    if (/^  description:/.test(line)) {
      out.push(`  description: "Level ${pad(n)}${rect ? ' — cargo quest (placed container)' : ''}"`);
      continue;
    }
    // Idempotent: overwrite an existing startMission, else insert after countdown.
    if (/^          startMission:/.test(line)) {
      out.push(`          startMission: ${n}`);
      sawStartMission = true;
      continue;
    }
    if (/^          countdownSeconds: /.test(line)) {
      out.push(line);
      if (!templateHasStartMission && !sawStartMission) {
        out.push(`          startMission: ${n}`);
        sawStartMission = true;
      }
      continue;
    }
    if (line === '          - id: effects' && rect) {
      out.push(...containerNode(rect), line);
      continue;
    }
    out.push(line);
  }
  fs.writeFileSync(`${SCENES}/level-${pad(n)}.pix3scene`, out.join('\n'));
}

console.log(`generated ${MISSIONS} level scenes → ${SCENES}/level-01..${pad(MISSIONS)}.pix3scene`);
console.log(`containers placed on levels: ${Object.keys(containers).join(', ')}`);

// ── 4) Air-unit prefabs: ONE PREFAB PER CLASS (ids 5-24, 26-29, 35-48) ───────
//
// Each air FAMILY used to ship a single prefab that reproduced only its `_1`
// variant's rig, so every other class in the family rendered the wrong load-out
// (see .plans/enemy-fidelity-audit.md §1 verdict C). The original has 48
// distinct rigs — mine racks, stone racks, sniper barrels, torpedoes, burning
// hulls — and ids 39-42 / 46-48 are AIRPLANES (`M_Unik`/`M_Urik` render as a
// fighter and a biplane bomber), not rope-hung balloons at all.
//
// The rig table below is transcribed from the decompiled `com.enemy.*.init()`
// (session export of design/noAds.swf). It is the single source for ~40
// near-identical prefabs, which is why they are GENERATED rather than
// hand-copied; the emitted files are ordinary `.pix3scene` YAML the editor
// instantiates like any other prefab, and they are laid out for review on the
// generated dev scene `src/assets/scenes/dev/air-gallery.pix3scene`.
//
// EXCLUDED from generation on purpose:
//   ids 1-4  (Lucky_1/2, Slevin_1/2) — the audit's §4 per-level diff lists no
//            rig drift for them; their hand-authored prefabs stay as they are.
//   id 25    (NZ_5) — `units/nz-fire.pix3scene` was hand-authored in P0 against
//            the user's reference frame; regenerating it would redo that work.
//   ids 30-34 (support bodies) — verified unchanged by the audit.
//
// ── COORDINATE CONVERSION ────────────────────────────────────────────────────
// `init()` offsets are Flash, **y-DOWN**, relative to the UNIT ORIGIN, and
// bitmaps are placed by their TOP-LEFT, then centred (`x -= w>>1`). Balloon
// bodies sit at `y -= (h>>1) + K` (K = 5, or 7 for NZ_1/2 and SUC_1/2), i.e.
// their centre is Flash (0, -K); plane bodies are placed by explicit top-left
// coords. Every prefab's ROOT is the body sprite, so each child is rebased onto
// the body centre `c` and flipped to pix3 y-up:
//
//     pix3 = ( fx - c.x ,  -(fy - c.y) )
//
// Compound (Unik_1-4 / Urik_1-3) prefabs root a `Group2D` at the unit origin
// instead, so there `c = (0, 0)`.
//
// ── GUN MOUNTS (`TypGunMob`) ─────────────────────────────────────────────────
// A `TypGunMob` is an empty container placed at `_tpg.(x,y)`; the barrel bitmap
// `mobTG` sits inside it at (20, -4.5) for `B_TypGun` (23x9) or (30, -4) for
// `B_TypSnp` (55x10) with `scaleX = -1`, and `MainTimeline.moveTGMob` sets the
// CONTAINER's `rotation` every frame from `grad`:
//
//     grad 0  -> live tracking of the player's gun: mousex = 30 - etYa.x,
//                mousey = 300 - etYa.y, angle = atan(mousey/mousex)/kPI
//                (+180 when mousex < 0), clamped to [95, 175] degrees
//     grad 1  -> fixed 160 deg      grad >= 2 -> fixed 180 deg
//     grad 12 -> 195 deg            grad 13   -> 190 deg
//
// so `grad` is an aim-MODE index (it also selects the `FN_MobStrike` shell
// branch), not an elevation in degrees. `mobTG.scaleX = -1` is what makes the
// barrel point along +x INSIDE the mount, and the container's rotation then
// swings it left/down onto the target — the flip is part of the aim frame, not
// of the art (the raw `typical_gun.png` / `big_gun1.png` already point LEFT,
// narrow ringed muzzle on the left, highlight along the top).
//
// Our mounts are static, so each barrel is authored in the 180-degree pose
// (the fixed `grad >= 2` aim, and the nearest sensible rest pose for the
// tracking `grad 0` mounts): container-local Flash centre `(bx - w/2, by + h/2)`
// negated by the 180-degree rotation, drawn UNFLIPPED (`scale: [1, 1]`) so the
// muzzle points left and the highlight stays on top.
//
//     B_TypGun -> barrel at pix3 (-8.5, 0),  muzzle x -20
//     B_TypSnp -> barrel at pix3 (-2.5, 1),  muzzle x -30
//
// `FxMg1`/`FxMg2` (the muzzle flashes) are MovieClips whose registration point
// FFDec cannot recover — their literal (-23, 15) is meaningless without it, so
// the flash node is placed at the barrel's muzzle instead. Same caveat for
// `BigGun` (a clip, not a bitmap): its internal barrel offset is unrecoverable
// and the layout below keeps the one `avalon1.pix3scene` already shipped.
//
// ── DRAW ORDER ───────────────────────────────────────────────────────────────
// Paint order here is hierarchy DFS (2D materials are `depthTest: false`), and
// the ROOT always paints under its own children — so where the original added
// the body bitmap LAST (over its bomb racks and some of its flames), our racks
// paint over the body instead. The overlap is the top 1-3 px of a bomb's
// hanger straps, so it is left as-is rather than restructuring every prefab
// around a non-root body; it is called out per prefab where a flame is
// affected.

const TEX = 'res://src/assets/textures';
const ENEMY = `${TEX}/enemy`;

/** Weapon/decor art: [path, w, h]. Sizes are the SWF bitmap's native size. */
const ART_W = {
  typgun: [`${ENEMY}/weapons/typical_gun.png`, 23, 9],
  // `weapons/big_gun1.png` is PIXEL-IDENTICAL to the SWF `325_B_TypSnp.png`
  // (55x10) — the sniper barrel is already in the project under the BigGun
  // clip's frame name, so nothing new had to be imported for it.
  typsnp: [`${ENEMY}/weapons/big_gun1.png`, 55, 10],
  biggun: [`${ENEMY}/weapons/big_gun1.png`, 55, 10],
  mine: [`${ENEMY}/weapons/mine.png`, 19, 21],
  // `B_Mine` (917) is pixel-identical to `B_minec` (125) = `weapons/mine_free.png`.
  bmine: [`${ENEMY}/weapons/mine_free.png`, 19, 18],
  // `Stoneb` (13x25) is the ball WITH its two hanging straps drawn into the
  // bitmap; `weapons/stone.png` is the same ball cropped to 13x13.
  stoneb: [`${ENEMY}/weapons/stoneb.png`, 13, 25],
  littlebg: [`${ENEMY}/weapons/littlebg.png`, 23, 23],
  korzina: [`${ENEMY}/air/gondola/korzina.png`, 20, 13],
  torpedo: [`${ENEMY}/weapons/torpedo.png`, 72, 12],
  ltorpedo: [`${ENEMY}/weapons/ltorpedo.png`, 48, 8],
  flash: [`${TEX}/sfx/blowglow.png`, 16, 16],
};

/** Barrel pose inside a static mount (see the TypGunMob note above). */
const GUN_POSE = {
  typgun: { art: 'typgun', x: -8.5, y: 0, muzzle: -20 },
  typsnp: { art: 'typsnp', x: -2.5, y: 1, muzzle: -30 },
  biggun: { art: 'biggun', x: -27, y: 0, muzzle: -54 },
};

/**
 * Flame sizes. `Burn1` measures 35x65 and `Burn2` 100x170 at 1x (FFDec exports
 * both clips at 4x: 140x260 / 400x680). P0's `nz-fire.pix3scene` authored its
 * `Burn1` at 20x34 against the user's reference frame, so that reduction
 * (~0.55x) is carried through here to keep the fire rigs consistent.
 */
const BURN = { burn1: [20, 34], burn2: [57, 89] };
const FIRE_ANIM = `${TEX}/sfx/fire/fire.pix3anim`;

/** Balloon bodies: [path, w, h]; `k` (5 or 7) is the class's `y -= (h>>1)+k`. */
const BODY = {
  avalon1: [`${ENEMY}/air/avalon1/avalon1.png`, 167, 46],
  avalon2: [`${ENEMY}/air/avalon2/avalon2.png`, 167, 46],
  lavalon1: [`${ENEMY}/air/lavalon1/lavalon1.png`, 107, 30],
  lavalon2: [`${ENEMY}/air/lavalon2/lavalon2.png`, 107, 30],
  nz: [`${ENEMY}/air/typical_bloon/Nazi_typical.png`, 66, 38],
  suc: [`${ENEMY}/air/typical_bloon/SU_typical.png`, 66, 38],
  unik_nd: [`${ENEMY}/air/unik/unik_nd.png`, 56, 23],
  urik_nd: [`${ENEMY}/air/urik/urik_nd.png`, 72, 24],
  urik_blur: [`${ENEMY}/air/urik/urik_blure.png`, 112, 24],
  unik_s: [`${ENEMY}/air/unik/unik_s.png`, 54, 37],
  unik_ropes: [`${ENEMY}/air/unik/unik_ropes.png`, 52, 33],
  unik_body: [`${ENEMY}/air/unik/unik_body.png`, 61, 33],
  urik_s: [`${ENEMY}/air/urik/urik_s.png`, 54, 37],
  urik_ropes: [`${ENEMY}/air/urik/urik_ropes.png`, 52, 33],
  urik_body: [`${ENEMY}/air/urik/urik_body.png`, 72, 24],
};
const OVERLAY = {
  avalon: `${ENEMY}/air/gondola/avalon_gondola.png`,
  lavalon: `${ENEMY}/air/gondola/lavalon_gondola.png`,
};

// Part shorthands. All coordinates are FLASH, y-down, relative to the unit
// origin, and always the part's CENTRE (top-left values from `init()` are
// converted to centres in the table itself, with the arithmetic shown).
const basket = (x, y) => ({ k: 'basket', x, y });
const gun = (slot, kind, x, y) => ({ k: 'gun', slot, kind, x, y });
const mine = (x, y, primary) => ({ k: 'bomb', art: 'mine', x, y, primary });
const bmine = (x, y, primary) => ({ k: 'bomb', art: 'bmine', x, y, primary });
const stone = (x, y, primary) => ({ k: 'bomb', art: 'stoneb', x, y, primary });
const torp = (x, y, heavy, primary) => ({
  k: 'bomb', art: heavy ? 'torpedo' : 'ltorpedo', x, y, primary, torpedo: true,
});
const glow = (x, y) => ({ k: 'glow', x, y });
const burn = (kind, x, y, scale) => ({ k: 'burn', kind, x, y, scale });
/** `Stoneb` + `Littlebg` + `Burn1` — the release's "fire bomb" (see §C). */
const fireBomb = (x, y, primary) => [stone(x, y, primary), glow(x, y + 5), burn('burn1', x + 16, y + 5)];

/**
 * id -> rig. `file` keeps an existing prefab's name where one already covers
 * that class; everything else is a new per-class file. `body.c` is the body
 * centre in Flash unit coords (the rebase origin), `logic` picks the script.
 */
const AIR_RIGS = [
  // ── Avalon 1 (167x46 hull, hidden `B_AvalonC` damage overlay) ─────────────
  {
    id: 5, cls: 'Avalon1_1', file: 'avalon1', name: 'Avalon 1', body: 'avalon1', k: 5,
    overlay: 'avalon', gunType: 'heavy',
    blurb: 'heavy gunship, nose `BigGun`',
    src: ['_mobGun = new BigGun();  x -= 67;  y += 4;  scaleX *= -1;',
          'B_AvalonC: x -= w>>1;  y -= (h>>1)+5;  visible = false;',
          'B_Avalon1: x -= w>>1;  y -= (h>>1)+5;      -> centre (0, -5)'],
    parts: [gun('Nose Gun', 'biggun', -67, 4)],
  },
  {
    id: 6, cls: 'Avalon1_2', file: 'avalon1-2', name: 'Avalon 1 Torpedo', body: 'avalon1', k: 5,
    overlay: 'avalon', gunType: '',
    blurb: 'heavy `B_Torpedo` (72x12) slung under the hull on a `TorpedoGun`',
    src: ['B_Torpedo: x -= (w>>1)+6;  y -= (h>>1)-22;  -> centre (-6, +22)',
          'TorpedoGun (clip, no remaster art): x -= 6;  y += 22;'],
    parts: [torp(-6, 22, true, true)],
  },
  {
    id: 7, cls: 'Avalon1_3', file: 'avalon1-3', name: 'Avalon 1 Mines', body: 'avalon1', k: 5,
    overlay: 'avalon', gunType: '',
    blurb: 'three-`Mine` rack, no gun',
    src: ['Mine  : x -= (w>>1)+45;  y -= (h>>1)-20;  -> centre (-45, +20)',
          'Mine a: x -= (w>>1)+8;   y -= (h>>1)-24;  -> centre (-8, +24)',
          'Mine b: x -= (w>>1)-29;  y -= (h>>1)-20;  -> centre (+29, +20)'],
    parts: [mine(-45, 20), mine(-8, 24, true), mine(29, 20)],
  },
  {
    id: 8, cls: 'Avalon1_4', file: 'avalon1-4', name: 'Avalon 1 Fire', body: 'avalon1', k: 5,
    overlay: 'avalon', gunType: '',
    blurb: 'three BURNING stone bombs (`Stoneb` + `Burn1` + `Littlebg`)',
    src: ['Stoneb  /Littlebg/Burn1: centres (-45,+21) / (-45,+26) / origin (-29,+26)',
          'Stoneb a/Littlebg/Burn1: centres (-8, +25) / (-8, +30) / origin (+8, +30)',
          'Stoneb b/Littlebg/Burn1: centres (+29,+21) / (+29,+26) / origin (+45,+26)',
          '(each Burn1 is `y += 26|30; x = bomb + 16; rotation = 90`)'],
    parts: [...fireBomb(-45, 21), ...fireBomb(-8, 25, true), ...fireBomb(29, 21)],
  },

  // ── Avalon 2 (167x46 hull) ────────────────────────────────────────────────
  {
    id: 9, cls: 'Avalon2_1', file: 'avalon2', name: 'Avalon 2', body: 'avalon2', k: 5,
    overlay: 'avalon', gunType: 'typical',
    blurb: 'twin gun-baskets (`B_Korzina` + `TypGunMob`/`B_TypGun`)',
    src: ['TypGunMob: x = -51; y = 18; tip = 0      TypGunMob: x = -9; y = 24; tip = 1',
          'B_Korzina a: x -= (w>>1)+8;   y -= (h>>1)-20;  -> centre (-8, +20)',
          'B_Korzina b: x -= (w>>1)+50;  y -= (h>>1)-14;  -> centre (-50, +14)'],
    parts: [basket(-50, 14), basket(-8, 20), gun('Mount A', 'typgun', -51, 18), gun('Mount B', 'typgun', -9, 24)],
  },
  {
    id: 10, cls: 'Avalon2_2', file: 'avalon2-2', name: 'Avalon 2 Stones', body: 'avalon2', k: 5,
    overlay: 'avalon', gunType: '',
    blurb: 'four-`Stoneb` rack, no gun',
    src: ['Stoneb  : x -= (w>>1)+61;  y -= (h>>1)-16;  -> centre (-61, +16)',
          'Stoneb a: x -= (w>>1)+28;  y -= (h>>1)-25;  -> centre (-28, +25)',
          'Stoneb b: x -= (w>>1)-13;  y -= (h>>1)-25;  -> centre (+13, +25)',
          'Stoneb c: x -= (w>>1)-46;  y -= (h>>1)-16;  -> centre (+46, +16)'],
    parts: [stone(-61, 16), stone(-28, 25, true), stone(13, 25), stone(46, 16)],
  },
  {
    id: 11, cls: 'Avalon2_3', file: 'avalon2-3', name: 'Avalon 2 Torpedoes', body: 'avalon2', k: 5,
    overlay: 'avalon', gunType: '',
    blurb: 'two light `B_LTorpedo` (48x8) on `TorpedoGun2` launchers',
    src: ['B_LTorpedo : x -= (w>>1)+8;  y -= (h>>1)-21;  -> centre (-8, +21)',
          'B_LTorpedo b: x -= (w>>1)+8;  y -= (h>>1)-27;  -> centre (-8, +27)',
          'TorpedoGun2 x2 (clips, no remaster art) at the same two points'],
    parts: [torp(-8, 21, false, true), torp(-8, 27, false)],
  },
  {
    id: 12, cls: 'Avalon2_4', file: 'avalon2-4', name: 'Avalon 2 Mines', body: 'avalon2', k: 5,
    overlay: 'avalon', gunType: '',
    blurb: 'five-`Mine` rack, no gun',
    src: ['Mine  : centre (-67, +5)   Mine a: centre (-43, +11)',
          'Mine b: centre (-15, +16)  Mine c: centre (+16, +13)',
          'Mine d: centre (  ?, +5)  <- APPROXIMATED, see the note below'],
    approx: ['the FIFTH mine\'s x is the one offset the decompiler lost (`x -= ((w>>1) - ?)`);',
             'it is placed at +44 to continue the rack\'s arc (-67, -43, -15, +16, +44 with',
             'y +5, +11, +16, +13, +5), which is symmetric with the first mine\'s height.'],
    parts: [mine(-67, 5), mine(-43, 11), mine(-15, 16, true), mine(16, 13), mine(44, 5)],
  },

  // ── Lavalon 1 (107x30 hull) ───────────────────────────────────────────────
  {
    id: 13, cls: 'Lavalon1_1', file: 'lavalon1', name: 'Lavalon 1', body: 'lavalon1', k: 5,
    overlay: 'lavalon', gunType: 'typical',
    blurb: 'single gun-basket (`B_Korzina` + `TypGunMob`/`B_TypGun`)',
    src: ['TypGunMob: x = -6;  y = 14;  tip = 2',
          'B_Korzina: x -= (w>>1)+5;  y -= (h>>1)-11;  -> centre (-5, +11)'],
    parts: [basket(-5, 11), gun('Mount A', 'typgun', -6, 14)],
  },
  {
    id: 14, cls: 'Lavalon1_2', file: 'lavalon1-2', name: 'Lavalon 1 Torpedo', body: 'lavalon1', k: 5,
    overlay: 'lavalon', gunType: '',
    blurb: 'one light `B_LTorpedo` on a `TorpedoGun2`',
    src: ['B_LTorpedo: x -= (w>>1)+2;  y -= (h>>1)-12;  -> centre (-2, +12)',
          'TorpedoGun2 (clip, no remaster art): x -= 2;  y += 12;'],
    parts: [torp(-2, 12, false, true)],
  },
  {
    id: 15, cls: 'Lavalon1_3', file: 'lavalon1-3', name: 'Lavalon 1 Mines', body: 'lavalon1', k: 5,
    overlay: 'lavalon', gunType: '',
    blurb: 'two-`Mine` rack, no gun',
    src: ['Mine  : x -= (w>>1)+21;  y -= (h>>1)-15;  -> centre (-21, +15)',
          'Mine a: x -= (w>>1)-12;  y -= (h>>1)-15;  -> centre (+12, +15)'],
    parts: [mine(-21, 15, true), mine(12, 15)],
  },
  {
    id: 16, cls: 'Lavalon1_4', file: 'lavalon1-4', name: 'Lavalon 1 Fire', body: 'lavalon1', k: 5,
    overlay: 'lavalon', gunType: '',
    blurb: 'one BURNING stone bomb in a `d1` Sprite at (+40, -4)',
    src: ['d1 Sprite: x += 40;  y -= 4;',
          '  Burn1  : y += 26;  x -= 29;  rotation = 90  -> unit origin (+11, +22)',
          '  Stoneb : x -= (w>>1)+45;  y -= (h>>1)-21;   -> unit centre (-4.5, +17.5)',
          '  Littlebg: x -= (w>>1)+45;  y -= (h>>1)-26;  -> unit centre (-4.5, +22.5)'],
    parts: [...fireBomb(-4.5, 17.5, true)],
  },

  // ── Lavalon 2 (107x30 hull) ───────────────────────────────────────────────
  {
    id: 17, cls: 'Lavalon2_1', file: 'lavalon2', name: 'Lavalon 2', body: 'lavalon2', k: 5,
    overlay: 'lavalon', gunType: 'typical',
    blurb: 'single gun-basket (`B_Korzina` + `TypGunMob`/`B_TypGun`)',
    src: ['TypGunMob: x = -6;  y = 14;  tip = 2',
          'B_Korzina: x -= (w>>1)+5;  y -= (h>>1)-11;  -> centre (-5, +11)'],
    parts: [basket(-5, 11), gun('Mount A', 'typgun', -6, 14)],
  },
  {
    id: 18, cls: 'Lavalon2_2', file: 'lavalon2-2', name: 'Lavalon 2 Bomber', body: 'lavalon2', k: 5,
    overlay: 'lavalon', gunType: '',
    blurb: 'two-`Stoneb` bomb rack — the LEVEL-1 "Bomber" (t = 37)',
    src: ['Stoneb  : x -= (w>>1)+29;  y -= (h>>1)-15;  -> centre (-29, +15)',
          'Stoneb a: x -= (w>>1)-21;  y -= (h>>1)-15;  -> centre (+21, +15)'],
    parts: [stone(-29, 15, true), stone(21, 15)],
  },
  {
    id: 19, cls: 'Lavalon2_3', file: 'lavalon2-3', name: 'Lavalon 2 Burning', body: 'lavalon2', k: 5,
    overlay: 'lavalon', gunType: '',
    blurb: 'a BURNING hull — two `Burn1` + one `Burn2`, no weapon at all',
    src: ['Burn1: x += 55;  y -= 12;  rotation = 90',
          'Burn1: x += 30;  y -= 4;   rotation = 90',
          'Burn2: x = -30;  y = -7;   rotation = 90;  scaleX = scaleY = 0.7'],
    approx: ['the first `Burn1` is added BEFORE the hull bitmap in `init()`, so the original',
             'draws it behind the hull; here the body is the prefab ROOT and always paints',
             'under its children, so all three flames paint over it.'],
    parts: [burn('burn1', 55, -12), burn('burn1', 30, -4), burn('burn2', -30, -7, 0.7)],
  },
  {
    id: 20, cls: 'Lavalon2_4', file: 'lavalon2-4', name: 'Lavalon 2 Mines', body: 'lavalon2', k: 5,
    overlay: 'lavalon', gunType: '',
    blurb: 'two-`Mine` rack, no gun',
    src: ['Mine b: x -= (w>>1)+6;   y -= (h>>1)-7;  -> centre (-6, +7)',
          'Mine c: x -= (w>>1)-25;  y -= (h>>1)-2;  -> centre (+25, +2)'],
    parts: [mine(-6, 7, true), mine(25, 2)],
  },

  // ── NZ (66x38 `B_NZ` asterisk gasbag) ─────────────────────────────────────
  {
    id: 21, cls: 'NZ_1', file: 'nz', name: 'NZ Raider', body: 'nz', k: 7,
    gunType: 'typical',
    blurb: 'gun-basket zeppelin (`B_Korzina` + `TypGunMob`/`B_TypGun`)',
    src: ['TypGunMob: x = 0;  y = 17;  tip = 3   (grad 0 = tracks the player gun)',
          'B_Korzina: x -= w>>1;  y -= (h>>1)-14;  -> centre (0, +14)',
          'B_NZ     : x -= w>>1;  y -= (h>>1)+7;   -> centre (0, -7)'],
    parts: [basket(0, 14), gun('Mount A', 'typgun', 0, 17)],
  },
  {
    id: 22, cls: 'NZ_2', file: 'nz-2', name: 'NZ Sniper', body: 'nz', k: 7,
    gunType: 'heavy',
    blurb: 'SNIPER zeppelin: the 55x10 `B_TypSnp` barrel, `rld_max 70`',
    src: ['B_Korzina: x -= w>>1;  y -= (h>>1)-14;  -> centre (0, +14)',
          'TypGunMob: x = -12;  y = 21;  tip = 3;  grad = 1;  rld_max = 70',
          '  B_TypSnp: x = 30;  y = -4;  scaleX = -1',
          'B_NZ     : x -= w>>1;  y -= (h>>1)+7;   -> centre (0, -7)'],
    parts: [basket(0, 14), gun('Mount A', 'typsnp', -12, 21)],
  },
  {
    id: 23, cls: 'NZ_3', file: 'nz-3', name: 'NZ Mines', body: 'nz', k: 5,
    gunType: '',
    blurb: 'three-`Mine` rack under the gasbag, no basket and no gun',
    src: ['Mine  : x -= (w>>1)+18;  y -= (h>>1)-17;  -> centre (-18, +17)',
          'Mine a: x -= (w>>1)+0;   y -= (h>>1)-21;  -> centre (  0, +21)',
          'Mine b: x -= (w>>1)-18;  y -= (h>>1)-17;  -> centre (+18, +17)',
          'B_NZ  : x -= w>>1;  y -= (h>>1)+5;        -> centre (0, -5)'],
    parts: [mine(-18, 17), mine(0, 21, true), mine(18, 17)],
  },
  {
    id: 24, cls: 'NZ_4', file: 'nz-4', name: 'NZ Burning', body: 'nz', k: 5,
    gunType: '',
    blurb: 'a burning wreck-in-flight — three `Burn2`, no weapon',
    src: ['Burn2: x = -6;   y = -7;  rotation = 90',
          'B_NZ : x -= w>>1;  y -= (h>>1)+5;  -> centre (0, -5)',
          'Burn2: x = 2;    y = -7;  rotation = 90',
          'Burn2: x = -15;  y = -4;  rotation = 90'],
    approx: ['the first `Burn2` is added BEFORE the gasbag in `init()` (behind it); the body',
             'is this prefab\'s ROOT and always paints under its children, so all three',
             'flames paint over the gasbag here.'],
    parts: [burn('burn2', -6, -7), burn('burn2', 2, -7), burn('burn2', -15, -4)],
  },

  // ── SUC (66x38 `B_SUC` gasbag, the Soviet livery) ─────────────────────────
  {
    id: 26, cls: 'SUC_1', file: 'suc', name: 'SUC Raider', body: 'suc', k: 7,
    gunType: 'typical',
    blurb: 'gun-basket zeppelin (`B_Korzina` + `TypGunMob`/`B_TypGun`)',
    src: ['TypGunMob: x = 0;  y = 17;  tip = 3   (grad 0 = tracks the player gun)',
          'B_Korzina: x -= w>>1;  y -= (h>>1)-14;  -> centre (0, +14)',
          'B_SUC    : x -= w>>1;  y -= (h>>1)+7;   -> centre (0, -7)'],
    parts: [basket(0, 14), gun('Mount A', 'typgun', 0, 17)],
  },
  {
    id: 27, cls: 'SUC_2', file: 'suc-2', name: 'SUC Twin Sniper', body: 'suc', k: 7,
    gunType: 'heavy',
    blurb: 'TWO 55x10 `B_TypSnp` barrels — one in the basket, one on the flank',
    src: ['B_Korzina: x -= w>>1;  y -= (h>>1)-14;  -> centre (0, +14)',
          'TypGunMob: x = -12;  y = 21;  tip = 3;  grad = 1;  rld_max = 70  (+ B_TypSnp)',
          'TypGunMob: x = -35;  y = -4;  tip = 3;  grad = 2               (+ B_TypSnp)',
          'B_SUC    : x -= w>>1;  y -= (h>>1)+7;   -> centre (0, -7)'],
    parts: [basket(0, 14), gun('Mount A', 'typsnp', -12, 21), gun('Mount B', 'typsnp', -35, -4)],
  },
  {
    id: 28, cls: 'SUC_3', file: 'suc-3', name: 'SUC Mines', body: 'suc', k: 5,
    gunType: '',
    blurb: 'two-`Mine` rack hugging the gasbag, no basket and no gun',
    src: ['Mine b: x = -22;  y = -2   (TOP-LEFT) -> centre (-22+9.5, -2+10.5) = (-12.5, +8.5)',
          'Mine c: x =   4;  y = -2   (TOP-LEFT) -> centre (  4+9.5, -2+10.5) = (+13.5, +8.5)',
          'B_SUC : x -= w>>1;  y -= (h>>1)+5;     -> centre (0, -5)'],
    parts: [mine(-12.5, 8.5, true), mine(13.5, 8.5)],
  },
  {
    id: 29, cls: 'SUC_4', file: 'suc-4', name: 'SUC Stones', body: 'suc', k: 5,
    gunType: '',
    blurb: 'two-`Stoneb` rack, no basket and no gun',
    src: ['Stoneb  : x = -24;  y = 2  (TOP-LEFT) -> centre (-24+6.5, 2+12.5) = (-17.5, +14.5)',
          'Stoneb a: x =  11;  y = 2  (TOP-LEFT) -> centre ( 11+6.5, 2+12.5) = (+17.5, +14.5)',
          'B_SUC   : x -= w>>1;  y -= (h>>1)+5;   -> centre (0, -5)'],
    parts: [stone(-17.5, 14.5, true), stone(17.5, 14.5)],
  },

  // ── Unik 1-4: the two-rope compound aerostat (gasbags + ropes + carriage) ──
  {
    id: 35, cls: 'Unik_1', file: 'unik-1', name: 'Unik Sniper', compound: 'unik',
    gunType: 'heavy',
    blurb: 'carriage with the 55x10 `B_TypSnp` sniper barrel, `rld_max 70`',
    src: ['B_unik_ropes: x = -25;  y = -13  -> centre (  +1, +3.5)',
          'B_unik_s    : x = -25;  y = -36  -> centre (  +2, -17.5)',
          'B_unik_body : x = -32;  y =   6  -> centre (-1.5, +22.5)',
          'TypGunMob   : x = -16;  y =  28;  tip = 4;  grad = 2;  rld_max = 70',
          '  B_TypSnp  : x =  30;  y =  -4;  scaleX = -1'],
    parts: [gun('Unik Gun', 'typsnp', -16, 28)],
  },
  {
    id: 36, cls: 'Unik_2', file: 'unik-2', name: 'Unik Torpedo', compound: 'unik',
    gunType: '',
    blurb: 'carriage with a light `B_LTorpedo` on a `TorpedoGun2`',
    src: ['B_LTorpedo : x -= (w>>1)+0;  y -= (h>>1)-34;  -> centre (0, +34)',
          'TorpedoGun2 (clip, no remaster art): x -= 0;  y += 34;',
          'ropes/gasbags/carriage as Unik_1'],
    parts: [torp(0, 34, false, true)],
  },
  {
    id: 37, cls: 'Unik_3', file: 'unik-3', name: 'Unik Stone', compound: 'unik',
    gunType: '',
    blurb: 'carriage with one `Stoneb` slung under it, no gun',
    src: ['Stoneb: x = -17;  y = 25  (TOP-LEFT) -> centre (-17+6.5, 25+12.5) = (-10.5, +37.5)',
          'ropes/gasbags/carriage as Unik_1'],
    parts: [stone(-10.5, 37.5, true)],
  },
  {
    id: 38, cls: 'Unik_4', file: 'unik-4', name: 'Unik Fire', compound: 'unik',
    gunType: '',
    blurb: 'carriage with a BURNING stone bomb in a Sprite at (+34, +15)',
    src: ['d1 Sprite: x = 34;  y = 15;',
          '  Burn1   : y += 26;  x -= 29;  rotation = 90  -> unit origin (+5, +41)',
          '  Stoneb  : x -= (w>>1)+45;  y -= (h>>1)-21;   -> unit centre (-10.5, +36.5)',
          '  Littlebg: x -= (w>>1)+45;  y -= (h>>1)-26;   -> unit centre (-10.5, +41.5)'],
    parts: [...fireBomb(-10.5, 36.5, true)],
  },

  // ── Unik 5-8: PLANES (`B_unik_nd` 56x23; the `M_Unik` clip is a fighter) ───
  {
    id: 39, cls: 'Unik_5', file: 'unik-5', name: 'Unik Plane Sniper', body: 'unik_nd',
    plane: [-28, -13], gunType: 'heavy',
    blurb: 'a PLANE, not a balloon: fighter airframe + 55x10 `B_TypSnp`, `rld_max 25`',
    src: ['B_unik_nd: x = -28;  y = -13  (TOP-LEFT, 56x23) -> centre (0, -1.5)',
          'TypGunMob: x = -16;  y =  11;  tip = 4;  grad = 3;  rld_max = 25',
          '  B_TypSnp: x = 30;  y = -4;  scaleX = -1',
          '(no B_unik_s / B_unik_ropes / B_unik_body anywhere in init())'],
    parts: [gun('Mount A', 'typsnp', -16, 11)],
  },
  {
    id: 40, cls: 'Unik_6', file: 'unik-6', name: 'Unik Plane Gun', body: 'unik_nd',
    plane: [-28, -13], gunType: 'typical',
    blurb: 'a PLANE with a `B_TypGun`, `rld_max 20` — the LEVEL-1 "ATS" (t = 37)',
    src: ['TypGunMob: x = -13;  y = 10;  tip = 3;  grad = 4;  rld_max = 20',
          '  B_TypGun: x = 20;  y = -4.5;  scaleX = -1',
          'B_unik_nd: x = -28;  y = -13  (TOP-LEFT, 56x23) -> centre (0, -1.5)'],
    parts: [gun('Mount A', 'typgun', -13, 10)],
  },
  {
    id: 41, cls: 'Unik_7', file: 'unik-7', name: 'Unik Plane Torpedo', body: 'unik_nd',
    plane: [-28, -13], gunType: '',
    blurb: 'a PLANE carrying a light `B_LTorpedo` on a `TorpedoGun2`',
    src: ['B_LTorpedo : x = -28;  y = 8  (TOP-LEFT, 48x8) -> centre (-4, +12)',
          'TorpedoGun2 (clip, no remaster art): x = -28;  y = 8',
          'B_unik_nd  : x = -28;  y = -13 -> centre (0, -1.5)'],
    parts: [torp(-4, 12, false, true)],
  },
  {
    id: 42, cls: 'Unik_8', file: 'unik-8', name: 'Unik Plane Burning', body: 'unik_nd',
    plane: [-28, -13], gunType: '',
    blurb: 'a BURNING plane — two `Burn2` + one `Burn1`, no weapon',
    src: ['Burn2: x = -18;  y = 0;  rotation = 90',
          'B_unik_nd: x = -28;  y = -13 -> centre (0, -1.5)',
          'Burn2: x =   0;  y = 0;  rotation = 90',
          'Burn1: x = -15;  y = 1;  rotation = 90'],
    approx: ['the first `Burn2` is added BEFORE the airframe (behind it); the body is this',
             'prefab\'s ROOT and always paints under its children, so all three flames',
             'paint over the airframe here.'],
    parts: [burn('burn2', -18, 0), burn('burn2', 0, 0), burn('burn1', -15, 1)],
  },

  // ── Urik 1-3: the heavy compound aerostat ─────────────────────────────────
  {
    id: 43, cls: 'Urik_1', file: 'urik-1', name: 'Urik Torpedo', compound: 'urik',
    gunType: '',
    blurb: 'carriage with the HEAVY 72x12 `B_Torpedo` (not the light `ltorpedo`)',
    src: ['B_Torpedo    : x = -36;  y =  20  (TOP-LEFT, 72x12) -> centre (0, +26)',
          'B_urik_ropes : x = -21;  y = -13  -> centre (+5, +3.5)',
          'B_urik_s     : x = -25;  y = -36  -> centre (+2, -17.5)',
          'B_urik_body  : x = -36;  y =   3  (72x24)           -> centre (0, +15)'],
    parts: [torp(0, 26, true, true)],
  },
  {
    id: 44, cls: 'Urik_2', file: 'urik-2', name: 'Urik Mines', compound: 'urik',
    gunType: '',
    blurb: 'carriage with a three-`Mine` rack, no gun',
    src: ['Mine  : x = -30;  y = 21  (TOP-LEFT) -> centre (-20.5, +31.5)',
          'Mine a: x = -11;  y = 19  (TOP-LEFT) -> centre ( -1.5, +29.5)',
          'Mine b: x =   9;  y = 16  (TOP-LEFT) -> centre (+18.5, +26.5)'],
    parts: [mine(-20.5, 31.5), mine(-1.5, 29.5, true), mine(18.5, 26.5)],
  },
  {
    id: 45, cls: 'Urik_3', file: 'urik-3', name: 'Urik Big Gun', compound: 'urik',
    gunType: 'heavy',
    blurb: 'carriage with the `BigGun` (the 55x10 heavy barrel), mirrored',
    src: ['B_urik_ropes/B_urik_s/B_urik_body as Urik_1',
          '_mobGun = new BigGun();  x = -21;  y = 26;  scaleX *= -1;'],
    parts: [gun('Unik Gun', 'biggun', -21, 26)],
  },

  // ── Urik 4-6: PLANES (`B_urik_nd` 72x24; `M_Urik` is a biplane bomber) ─────
  {
    id: 46, cls: 'Urik_4', file: 'urik-4', name: 'Urik Plane Gun', body: 'urik_nd',
    plane: [-28, -13], gunType: 'typical',
    blurb: 'a PLANE, not a balloon: biplane airframe + `B_TypGun`, `rld_max 20`',
    src: ['B_urik_nd: x = -28;  y = -13  (TOP-LEFT, 72x24) -> centre (+8, -1)',
          'TypGunMob: x =   4;  y =   9;  tip = 3;  grad = 5;  rld_max = 20',
          '  B_TypGun: x = 20;  y = -4.5;  scaleX = -1',
          '(no B_urik_s / B_urik_ropes / B_urik_body anywhere in init())'],
    parts: [gun('Mount A', 'typgun', 4, 9)],
  },
  {
    id: 47, cls: 'Urik_5', file: 'urik-5', name: 'Urik Plane Mine', body: 'urik_nd',
    plane: [-28, -13], gunType: '',
    blurb: 'a PLANE carrying one free-floating `B_Mine` (19x18), no gun',
    src: ['B_urik_nd: x = -28;  y = -13  (TOP-LEFT, 72x24) -> centre (+8, -1)',
          'B_Mine   : x = -37;  y =  -8  (TOP-LEFT, 19x18) -> centre (-27.5, +1)'],
    parts: [bmine(-27.5, 1, true)],
  },
  {
    id: 48, cls: 'Urik_6', file: 'urik-6', name: 'Urik Plane Burning', body: 'urik_nd',
    plane: [-31, -13], gunType: '',
    blurb: 'a BURNING plane trailing the 112x24 `B_urik_b` motion blur',
    src: ['Burn1    : x = -11.5;  y = -2;  rotation = 90',
          'Burn1    : x =  -3.5;  y =  5;  rotation = 90',
          'B_urik_nd: x = -31;  y = -13  (TOP-LEFT, 72x24) -> centre (+5, -1)',
          'B_urik_b : x = -16;  y = -13  (TOP-LEFT, 112x24) -> centre (+40, -1)',
          'Burn1    : x =   3.5;  y =  ?;  rotation = 90  <- y APPROXIMATED'],
    approx: ['the THIRD `Burn1`\'s y is the one offset the decompiler lost; it is placed at',
             '+5, matching the second flame, so the pair straddles the fuselage evenly.',
             'The first two flames are added BEFORE the airframe in `init()` (behind it);',
             'the body is this prefab\'s ROOT, so they paint over it here.'],
    blur: [-16, -13],
    parts: [burn('burn1', -11.5, -2), burn('burn1', -3.5, 5), burn('burn1', 3.5, 5)],
  },
];

/** Campaign levels each id appears on, for the editorOnly dev labels. */
function campaignLevelsById() {
  const byId = {};
  const rows = campBlock.split('/* Lvl ');
  for (let i = 1; i < rows.length; i++) {
    const lvl = Number(rows[i].slice(0, rows[i].indexOf(' ')));
    for (const m of rows[i].matchAll(/\[\s*-?\d+\s*,\s*(\d+)\s*,/g)) {
      (byId[Number(m[1])] ??= new Set()).add(lvl);
    }
  }
  return byId;
}

const num = n => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));
const vec = (x, y) => `[${num(x)}, ${num(y)}]`;
const texProp = p => `{ type: 'texture', url: '${p}' }`;

/** Emit a `transform:` block at the given indent. */
const xform = (pad, x, y, rot = 0, sx = 1, sy = 1) => [
  `${pad}transform:`,
  `${pad}  position: ${vec(x, y)}`,
  `${pad}  scale: ${vec(sx, sy)}`,
  `${pad}  rotation: ${num(rot)}`,
];

/** Emit a `core:Hitbox2D` component block at the given indent. */
const hitbox = (pad, id, w, h, ox = 0, oy = 0) => [
  `${pad}- id: ${id}`,
  `${pad}  type: core:Hitbox2D`,
  `${pad}  enabled: true`,
  `${pad}  config:`,
  `${pad}    shape: rect`,
  `${pad}    width: ${num(w)}`,
  `${pad}    height: ${num(h)}`,
  `${pad}    offsetX: ${num(ox)}`,
  `${pad}    offsetY: ${num(oy)}`,
  `${pad}    group: enemy`,
  `${pad}    debugDraw: false`,
];

/** Emit a `Sprite2D` child. `art` is an ART_W/BODY key or an explicit triple. */
function spriteNode(pad, id, name, art, x, y, extra = {}) {
  const [path, w, h] = Array.isArray(art) ? art : ART_W[art];
  const out = [
    `${pad}- id: ${id}`,
    `${pad}  type: Sprite2D`,
    `${pad}  name: ${name}`,
    `${pad}  properties:`,
    `${pad}    texture: ${texProp(path)}`,
    `${pad}    width: ${num(w)}`,
    `${pad}    height: ${num(h)}`,
  ];
  if (extra.opacity !== undefined) out.push(`${pad}    opacity: ${num(extra.opacity)}`);
  if (extra.hidden) out.push(`${pad}    visible: false`, `${pad}    initiallyVisible: false`);
  out.push(...xform(`${pad}    `, x, y));
  if (extra.hit) {
    out.push(`${pad}  components:`);
    out.push(...hitbox(`${pad}    `, `${id}-hitbox`, ...extra.hit));
  }
  if (extra.children && extra.children.length) {
    out.push(`${pad}  children:`);
    out.push(...extra.children);
  } else {
    out.push(`${pad}  children: []`);
  }
  return out;
}

/** Emit a `Burn1`/`Burn2` flame as the shared fire AnimatedSprite2D. */
function flameNode(pad, id, name, kind, x, y, scale = 1) {
  const [w, h] = BURN[kind];
  return [
    `${pad}- id: ${id}`,
    `${pad}  type: AnimatedSprite2D`,
    `${pad}  name: ${name}`,
    `${pad}  properties:`,
    `${pad}    animationResourcePath: ${FIRE_ANIM}`,
    `${pad}    currentClip: burn`,
    `${pad}    isPlaying: true`,
    `${pad}    freeOnFinish: false`,
    `${pad}    width: ${num(w * scale)}`,
    `${pad}    height: ${num(h * scale)}`,
    `${pad}    opacity: 1`,
    // Flash `rotation = 90` is clockwise; pix3 degrees are y-up, so -90.
    ...xform(`${pad}    `, x, y, -90),
    `${pad}  children: []`,
  ];
}

/** Emit a gun mount: a Group2D pivot holding the barrel + its muzzle flash. */
function gunNode(pad, slot, kind, x, y) {
  const pose = GUN_POSE[kind];
  const [, gw, gh] = ART_W[pose.art];
  const slug = slot.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return [
    `${pad}- id: ${slug}`,
    `${pad}  type: Group2D`,
    `${pad}  name: ${slot}`,
    `${pad}  properties:`,
    `${pad}    width: ${num(gw)}`,
    `${pad}    height: ${num(gh)}`,
    ...xform(`${pad}    `, x, y),
    `${pad}  children:`,
    ...spriteNode(`${pad}    `, `${slug}-barrel`, 'Gun', pose.art, pose.x, pose.y),
    ...spriteNode(`${pad}    `, `${slug}-flash`, 'Muzzle Flash', 'flash', pose.muzzle, pose.y, {
      opacity: 0,
    }),
  ];
}

/** Carriage position (pix3) of each compound family — the nest point for its weapon. */
const GONDOLA_PIX3 = { unik: [-1.5, -22.5], urik: [0, -15] };

/**
 * Emit one air-class prefab; returns the file's text.
 *
 * Node naming is what the game scripts bind to, not decoration: `EnemyBalloon`
 * snaps the link named `Weapon Mount`, detonates/drops the bomb named
 * `Carried Mine`, and recoils the first visible mount out of `Nose Gun` /
 * `Mount A` / `Mount B`; `CompoundBalloon` takes the unit apart by
 * `Unik Ropes` / `Unik Body` / `Unik Gondola` and fires `Unik Gun` or `Torpedo`
 * nested under the gondola. Only nodes something LISTENS to carry a
 * `core:Hitbox2D` — a hitbox on a node with no `damaged` handler silently eats
 * the player's shot — so a rack's extra bombs are visual siblings and only its
 * primary bomb is wired as `Carried Mine`.
 */
function emitAirPrefab(rig, levels) {
  const compound = !!rig.compound;
  const [bodyTex, bw, bh] = compound ? [null, 0, 0] : BODY[rig.body];
  // Rebase origin = the body centre in Flash unit coords. Compounds root a
  // Group2D at the unit origin instead, so nothing is rebased there.
  const c = compound ? { x: 0, y: 0 }
    : rig.plane ? { x: rig.plane[0] + bw / 2, y: rig.plane[1] + bh / 2 }
    : { x: 0, y: -rig.k };
  const P = (x, y) => [x - c.x, -(y - c.y)];
  const [gxp, gyp] = compound ? GONDOLA_PIX3[rig.compound] : [0, 0];

  const head = [];
  head.push(`# ${rig.name} — enemy air unit, id ${rig.id} (\`${rig.cls}\`): ${rig.blurb}.`);
  head.push(`# Rig transcribed verbatim from the decompiled \`com.enemy.${rig.cls}.init()\``);
  head.push('# (session export of design/noAds.swf):');
  head.push('#');
  for (const line of rig.src) head.push(`#   ${line}`);
  head.push('#');
  head.push('# Offsets are Flash (y-DOWN) relative to the UNIT ORIGIN; bitmaps are placed by');
  head.push('# their TOP-LEFT and then centred, so the lines above resolve each to a CENTRE.');
  if (compound) {
    head.push("# This prefab's ROOT is a Group2D at the unit origin, so every child is just");
    head.push('# flipped to pix3 y-up:  pix3 = (fx, -fy).  The carriage weapon is nested');
    head.push(`# under \`Unik Gondola\` and so is additionally offset by ${vec(-gxp, -gyp)}.`);
  } else {
    // Render the rebase as arithmetic a reader can redo by hand, e.g. a body
    // centred at Flash (0, -7) prints `pix3 = (fx, -(fy + 7))`.
    const term = (v, sym) => (v === 0 ? sym : v < 0 ? `${sym} + ${num(-v)}` : `${sym} - ${num(v)}`);
    head.push(`# This prefab's ROOT is the body sprite (Flash centre (${num(c.x)}, ${num(c.y)})), so every`);
    head.push('# child below is rebased onto that centre and flipped to pix3 y-up:');
    head.push(`#   pix3 = (${term(c.x, 'fx')}, -(${term(c.y, 'fy')}))`);
  }
  if (rig.parts.some(p => p.k === 'gun')) {
    head.push('# The barrel is drawn UNFLIPPED (`scale: [1, 1]`) in the 180-degree aim pose —');
    head.push('# see the `TypGunMob` note in scripts/gen-levels.mjs for why `mobTG.scaleX = -1`');
    head.push('# belongs to the aim frame and not to the art.');
  }
  if (rig.approx) {
    head.push('#');
    head.push('# APPROXIMATION:');
    for (const line of rig.approx) head.push(`#   ${line}`);
  }
  head.push('#');
  head.push('# Per-id stats (hp/speed/score/attack) are applied by WaveSpawner from SdBalance.');
  head.push('# GENERATED by scripts/gen-levels.mjs — edit the rig table there, not this file.');

  const out = [...head];
  out.push('version: 1.0.0');
  out.push('metadata:');
  out.push('  author: Sky Defender Remaster');
  out.push(`  description: "${rig.name} (unit prefab, ${rig.cls})"`);
  out.push('root:');

  const label = `${rig.name} · ${levels.length ? `L${levels.join(',')}` : 'unused in campaign'}`;
  const devLabel = [
    '      - id: dev-label',
    '        type: Label2D',
    '        name: Dev Label',
    '        properties:',
    '          editorOnly: true',
    `          label: "${label}"`,
    '          labelFontSize: 12',
    '          labelColor: "#ffd75e"',
    '          labelAlign: center',
    ...xform('          ', 0, compound ? 56 : bh / 2 + 16),
    '        children: []',
  ];

  // ── root node ─────────────────────────────────────────────────────────────
  out.push('  - id: unit');
  if (compound) {
    const carriage = BODY[`${rig.compound}_body`];
    out.push('    type: Group2D');
    out.push(`    name: ${rig.name}`);
    out.push('    properties:');
    out.push('      width: 70');
    out.push('      height: 92');
    out.push(...xform('      ', 0, 0));
    out.push('    components:');
    out.push('      - id: unit-logic');
    out.push('        type: user:CompoundBalloon');
    out.push('        enabled: true');
    out.push('        config:');
    out.push('          bodyHp: 100');
    out.push('          ropesHp: 30');
    out.push('          gondolaHp: 60');
    out.push('          speed: 40');
    out.push('          stopX: 0');
    out.push('          score: 20');
    out.push('          gondolaScore: 8');
    out.push('          castleDamage: 90');
    out.push(`          wreckBodyTex: '${carriage[0]}'`);
    out.push(`          wreckGondolaTex: '${carriage[0]}'`);
  } else {
    out.push('    type: Sprite2D');
    out.push(`    name: ${rig.name}`);
    out.push('    properties:');
    out.push(`      texture: ${texProp(bodyTex)}`);
    out.push(`      width: ${num(bw)}`);
    out.push(`      height: ${num(bh)}`);
    out.push(...xform('      ', 0, 0));
    out.push('    components:');
    out.push(...hitbox('      ', 'unit-hitbox', bw - 6, bh - 4));
    out.push('      - id: unit-logic');
    out.push('        type: user:EnemyBalloon');
    out.push('        enabled: true');
    out.push('        config:');
    out.push('          hp: 100');
    out.push('          speed: 50');
    out.push('          score: 8');
    out.push('          castleDamage: 0');
    out.push('          stopX: 0');
    out.push('          linkHp: 25');
    out.push('          mineHp: 25');
    out.push('          bomber: false');
    out.push(`          gunType: '${rig.gunType}'`);
    out.push(`          spritePath: '${bodyTex}'`);
  }
  out.push('    children:');
  out.push(...devLabel);
  if (rig.overlay) {
    out.push('      # Hidden damage overlay (`B_AvalonC`/`B_LavalonC`): `init()` builds it with');
    out.push('      # `visible = false` and swaps it in when the hull is wrecked.');
    out.push(...spriteNode('      ', 'gondola-overlay', 'Gondola',
      [OVERLAY[rig.overlay], bw, bh], 0, 0, { hidden: true }));
  }

  // ── rig parts (tree order = paint order, matching the `addChild` sequence) ─
  const pad = '      ';
  let baskets = 0, bombs = 0, glows = 0, flames = 0;
  const gondolaKids = [];
  for (const p of rig.parts) {
    const [x, y] = P(p.x, p.y);
    if (p.k === 'basket') {
      baskets++;
      const first = baskets === 1;
      out.push(...spriteNode(pad, first ? 'weapon-mount' : `basket-${baskets}`,
        first ? 'Weapon Mount' : `Basket ${baskets}`, 'korzina', x, y,
        first ? { hit: [20, 14] } : {}));
    } else if (p.k === 'gun') {
      const lines = compound
        ? gunNode('          ', p.slot, p.kind, x - gxp, y - gyp)
        : gunNode(pad, p.slot, p.kind, x, y);
      if (compound) gondolaKids.push(...lines);
      else out.push(...lines);
    } else if (p.k === 'bomb') {
      bombs++;
      const [, w, h] = ART_W[p.art];
      // `Stoneb` is 13x25 because its upper 12 px are the two hanging straps
      // drawn into the bitmap; only the lower ball is worth a hitbox.
      const hit = p.art === 'stoneb' ? [13, 13, 0, -6.5] : [w, h];
      if (compound && p.torpedo) {
        gondolaKids.push(...spriteNode('          ', 'torpedo', 'Torpedo', p.art,
          x - gxp, y - gyp, {}));
      } else {
        const name = p.primary ? 'Carried Mine' : p.torpedo ? `Torpedo ${bombs}` : `Bomb ${bombs}`;
        const id = p.primary ? 'carried-mine' : p.torpedo ? `torpedo-${bombs}` : `bomb-${bombs}`;
        out.push(...spriteNode(pad, id, name, p.art, x, y, p.primary ? { hit } : {}));
      }
    } else if (p.k === 'glow') {
      glows++;
      out.push(...spriteNode(pad, `bomb-glow-${glows}`, `Bomb Glow ${glows}`, 'littlebg', x, y));
    } else if (p.k === 'burn') {
      flames++;
      out.push(...flameNode(pad, `flame-${flames}`, `Flame ${flames}`, p.kind, x, y, p.scale ?? 1));
    }
  }
  if (rig.blur) {
    const [, blw, blh] = BODY.urik_blur;
    const [x, y] = P(rig.blur[0] + blw / 2, rig.blur[1] + blh / 2);
    out.push(...spriteNode(pad, 'motion-blur', 'Motion Blur', BODY.urik_blur, x, y));
  }

  // ── compound structure: ropes behind -> gasbags -> carriage (+ its weapon) ─
  if (compound) {
    const f = rig.compound;
    const parts = [
      ['unik-ropes', 'Unik Ropes', BODY[`${f}_ropes`], f === 'unik' ? 1 : 5, -3.5],
      ['unik-body', 'Unik Body', BODY[`${f}_s`], 2, 17.5],
      ['unik-gondola', 'Unik Gondola', BODY[`${f}_body`], gxp, gyp],
    ];
    for (const [id, name, art, x, y] of parts) {
      out.push(...spriteNode(pad, id, name, art, x, y, {
        hit: [art[1] - 5, art[2] - 5],
        children: id === 'unik-gondola' ? gondolaKids : null,
      }));
    }
  }
  return out.join('\n') + '\n';
}

const PREFAB_DIR = 'src/assets/prefabs/units';
const airLevels = campaignLevelsById();
for (const rig of AIR_RIGS) {
  const levels = [...(airLevels[rig.id] ?? new Set())].sort((a, b) => a - b);
  fs.writeFileSync(`${PREFAB_DIR}/${rig.file}.pix3scene`, emitAirPrefab(rig, levels));
}
console.log(`air prefabs: ${AIR_RIGS.length} per-class rigs → ${PREFAB_DIR}/`);

// ── 5) air-gallery.pix3scene — every generated air class on one dev scene ────
{
  const COLS = 5;
  const [CELL_X, CELL_Y] = [280, 180];
  const rows = [
    '# Air Unit Gallery — DEV scene, GENERATED by scripts/gen-levels.mjs.',
    '# One instance of every per-class air prefab (ids 5-24, 26-29, 35-48) laid out',
    '# in a grid for visual review in the editor: this is the review surface for the',
    '# per-family rig corrections in .plans/enemy-fidelity-audit.md §3. Labels inside',
    '# the prefabs are editorOnly nodes (stripped from play clones and exports).',
    '# The hand-authored air units (ids 1-4 bombers, 25 NZ_5, 30-34 supports) and the',
    '# ground/quest/boss bands stay on src/assets/scenes/dev/unit-gallery.pix3scene.',
    'version: 1.0.0',
    'metadata:',
    '  author: Sky Defender Remaster',
    '  description: "DEV: every per-class air unit prefab on one scene"',
    'root:',
    '  - id: gallery',
    '    type: Group2D',
    '    name: Air Unit Gallery',
    '    properties:',
    '      width: 1400',
    '      height: 1000',
    ...xform('      ', 0, 0),
    '    children:',
  ];
  AIR_RIGS.forEach((rig, i) => {
    rows.push(
      `      - id: gal-${rig.file}`,
      `        instance: res://src/assets/prefabs/units/${rig.file}.pix3scene`,
      `        name: "${rig.id} ${rig.cls}"`,
      '        properties:',
      ...xform('          ',
        (i % COLS) * CELL_X - ((COLS - 1) * CELL_X) / 2,
        400 - Math.floor(i / COLS) * CELL_Y),
    );
  });
  fs.writeFileSync('src/assets/scenes/dev/air-gallery.pix3scene', rows.join('\n') + '\n');
  console.log('air gallery: src/assets/scenes/dev/air-gallery.pix3scene');
}
