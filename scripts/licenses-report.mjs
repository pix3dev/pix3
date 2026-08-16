// Prints the licence of every declared runtime dependency across the workspace, flagging anything
// that is not plainly permissive.
//
// This is a review aid for THIRD-PARTY-NOTICES.md, not a generator: the notices file carries
// hand-written context (why Spine is host-injected, which half of jszip's dual licence we elect,
// why IS-Net's weights are unusable) that no tool can derive. Run this after changing dependencies
// and reconcile the two by hand.

import { readFileSync, existsSync } from 'node:fs';

const PERMISSIVE = /^\(?(MIT|ISC|BSD-[23]-Clause|BSD|Apache-2\.0|0BSD|Zlib|Unlicense|CC0-1\.0)\)?$/;

const read = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const SOURCES = [
  { file: 'package.json', label: 'editor', fields: ['dependencies'] },
  {
    file: 'packages/pix3-runtime/package.json',
    label: 'runtime',
    fields: ['dependencies', 'peerDependencies'],
  },
  { file: 'packages/pix3-collab-server/package.json', label: 'collab-server', fields: ['dependencies'] },
];

const NODE_MODULES = ['node_modules/', 'packages/pix3-collab-server/node_modules/'];

const used = new Map();
for (const { file, label, fields } of SOURCES) {
  const pkg = read(file);
  if (!pkg) {
    console.error(`  ! could not read ${file}`);
    continue;
  }
  for (const field of fields) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      const suffix = field === 'peerDependencies' ? ' (peer)' : '';
      if (!used.has(name)) {
        used.set(name, new Set());
      }
      used.get(name).add(label + suffix);
    }
  }
}

const rows = [];
for (const [name, origins] of used) {
  let version = '?';
  let license = 'UNKNOWN';
  for (const base of NODE_MODULES) {
    if (!existsSync(`${base}${name}/package.json`)) {
      continue;
    }
    const meta = read(`${base}${name}/package.json`);
    if (meta) {
      version = meta.version ?? '?';
      license =
        typeof meta.license === 'string' ? meta.license : JSON.stringify(meta.license ?? 'UNKNOWN');
      break;
    }
  }
  rows.push({ name, version, license, origins: [...origins].sort().join(', ') });
}
rows.sort((a, b) => a.name.localeCompare(b.name));

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n  ${pad('COMPONENT', 42)}${pad('VERSION', 12)}${pad('LICENCE', 30)}USED BY`);
console.log(`  ${'-'.repeat(110)}`);
for (const r of rows) {
  console.log(`  ${pad(r.name, 42)}${pad(r.version, 12)}${pad(r.license, 30)}${r.origins}`);
}

const flagged = rows.filter(r => !PERMISSIVE.test(r.license));
if (flagged.length > 0) {
  console.log(`\n  Needs a human decision — not plainly permissive:\n`);
  for (const r of flagged) {
    console.log(`    ${pad(r.name, 42)}${r.license}`);
  }
  console.log(
    `\n  Each of these must have an explanatory entry in THIRD-PARTY-NOTICES.md saying what\n` +
      `  the terms actually are and, for dual licences, which option we elect.\n`
  );
} else {
  console.log(`\n  All declared dependencies are plainly permissive.\n`);
}
