import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const packageJsonPath = resolve(projectRoot, 'package.json');
const publicVersionPath = resolve(projectRoot, 'public/version.json');
const sourceVersionPath = resolve(projectRoot, 'src/version.ts');

function createDisplayVersion(version, build) {
  return `v${version} (build ${build})`;
}

export async function readJsonFile(path, fallback) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export function buildVersionManifest(version, build, publishedAt) {
  const manifest = {
    version,
    build,
    displayVersion: createDisplayVersion(version, build),
  };

  if (publishedAt) {
    manifest.publishedAt = publishedAt;
  }

  return manifest;
}

/**
 * Emit a TS string literal in the repo's Prettier style (singleQuote). JSON.stringify would
 * hand back double quotes, so every version bump used to churn against the next format pass.
 */
function tsString(value) {
  const json = JSON.stringify(String(value));
  const inner = json.slice(1, -1);
  return inner.includes("'") || inner.includes('\\') ? json : `'${inner}'`;
}

export function buildVersionModule(manifest) {
  const publishedAtLine = manifest.publishedAt
    ? `  publishedAt: ${tsString(manifest.publishedAt)},\n`
    : '';

  return `export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: ${tsString(manifest.version)},
  build: ${manifest.build},
  displayVersion: ${tsString(manifest.displayVersion)},
${publishedAtLine}};
`;
}

export async function updateVersionArtifacts(options = {}) {
  const paths = {
    packageJsonPath,
    publicVersionPath,
    sourceVersionPath,
    ...options.paths,
  };
  const packageJson = await readJsonFile(paths.packageJsonPath);
  const currentManifest = await readJsonFile(paths.publicVersionPath, null);
  const currentBuild =
    currentManifest && typeof currentManifest.build === 'number' ? currentManifest.build : -1;
  const nextBuild = currentBuild + 1;
  const publishedAt = options.publishedAt ?? new Date().toISOString();
  const manifest = buildVersionManifest(packageJson.version, nextBuild, publishedAt);

  await writeFile(paths.publicVersionPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(paths.sourceVersionPath, buildVersionModule(manifest), 'utf8');

  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await updateVersionArtifacts();
  console.log(`[version] Updated to ${manifest.displayVersion}`);
}
