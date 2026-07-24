// gen-levels.mjs — generate one campaign level scene per mission.
//
// Scene-per-level: each mission is its own `level-NN.pix3scene` = the shared
// battle skeleton (game-root + inline stage/playfield) with the reusable chrome
// (HUD/shop/result) and castle as prefab INSTANCES, plus `startMission: NN` so
// the level declares which campaign mission it runs. Cargo-quest levels (those
// with a QUEST_LEVELS container) additionally get a visually-placed
// `quest-container` node — the authored source of truth for the landing rect.
//
// Everything is DERIVED FROM SOURCE (no duplicated data):
//   - mission count  ← V15_CAMPAIGN rows (scripts/SdV15.ts)
//   - container rects ← QUEST_LEVELS[...].container (scripts/SdBalance.ts)
//   - scene skeleton  ← level-01.pix3scene (the canonical template)
//
// Run from the sample root:  node scripts/gen-levels.mjs
import fs from 'node:fs';

const SCENES = 'src/assets/scenes';
const TEMPLATE = `${SCENES}/level-01.pix3scene`;
const pad = n => String(n).padStart(2, '0');

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
const template = fs.readFileSync(TEMPLATE, 'utf8').split('\n');
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
      if (!sawStartMission) {
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
