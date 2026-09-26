// Copies the editor's project templates into `<package>/templates/` for the published tarball
// (plan §5 A, risk #7: templates stay in `src/templates/projects/`, one source; the package gets a
// build-time copy). Only what `pix3 new` reads is copied — `template.yaml` and `files/` — never the
// wizard's `cover.png` or the editor specs that sit beside them. The output is gitignored.
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(packageRoot, '../../src/templates/projects');
const target = join(packageRoot, 'templates');

if (!existsSync(source)) {
  console.error(`copy-templates: ${source} not found (run from the pix3 repo).`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
if (process.argv.includes('--clean')) {
  console.log(`copy-templates: removed ${target}`);
  process.exit(0);
}
let count = 0;
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const from = join(source, entry.name);
  if (!existsSync(join(from, 'template.yaml')) || !existsSync(join(from, 'files'))) continue;
  cpSync(join(from, 'template.yaml'), join(target, entry.name, 'template.yaml'));
  cpSync(join(from, 'files'), join(target, entry.name, 'files'), { recursive: true });
  count += 1;
}
console.log(`copy-templates: ${count} templates -> ${target}`);
