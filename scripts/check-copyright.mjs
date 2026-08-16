// Fails the build while a licence file still carries an unresolved placeholder.
//
// The copyright holder in LICENSE / NOTICE is a public assertion of ownership, so it is left as a
// marker until it has actually been settled. This guard exists so that "we'll fill it in later"
// cannot quietly become "we shipped it with a placeholder" — a release build stops instead.
//
// To clear it: replace every marker with the agreed holder, then this script passes and does
// nothing on every subsequent build.

import { readFileSync, existsSync } from 'node:fs';

const MARKERS = ['__COPYRIGHT_HOLDER_TBD__', '__CONTACT_EMAIL_TBD__'];

const FILES = [
  'LICENSE',
  'NOTICE',
  'packages/pix3-runtime/LICENSE',
  'packages/pix3-collab-server/LICENSE',
];

const findings = [];
for (const file of FILES) {
  if (!existsSync(file)) {
    findings.push({ file, problem: 'missing' });
    continue;
  }
  const text = readFileSync(file, 'utf8');
  for (const marker of MARKERS) {
    if (text.includes(marker)) {
      findings.push({ file, problem: `unresolved ${marker}` });
    }
  }
}

if (findings.length > 0) {
  console.error('\n  Licence files are not release-ready:\n');
  for (const { file, problem } of findings) {
    console.error(`    ${file} — ${problem}`);
  }
  console.error(
    '\n  The copyright holder has not been settled yet (see CONTRIBUTING.md on why this\n' +
      '  matters). Resolve the markers, or run the build with PIX3_ALLOW_TBD_COPYRIGHT=1 to\n' +
      '  bypass this deliberately for a local build.\n'
  );
  if (process.env.PIX3_ALLOW_TBD_COPYRIGHT !== '1') {
    process.exit(1);
  }
  console.error('  PIX3_ALLOW_TBD_COPYRIGHT=1 set — continuing anyway.\n');
}
