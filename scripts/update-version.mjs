import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const packageJsonPath = resolve(projectRoot, 'package.json');
const publicVersionPath = resolve(projectRoot, 'public/version.json');
const sourceVersionPath = resolve(projectRoot, 'src/version.ts');

/**
 * Workspace packages that ride the editor's version, so `@pix3/runtime@X.Y.Z` is the engine that
 * shipped with editor X.Y.Z and nothing has to be cross-referenced to find out.
 *
 * The tradeoff is deliberate: a lockstep version is a *product* version, so the runtime's number
 * no longer promises anything about API compatibility — read the change log, not the minor digit.
 *
 * `tools/pix3-agent-bridge` is absent on purpose. It is not a workspace, ships on its own cadence
 * behind its own `bridge-v*` tag, and is useful against editors it was not built beside.
 */
const workspacePackageJsonPaths = [
  resolve(projectRoot, 'packages/pix3-runtime/package.json'),
  resolve(projectRoot, 'packages/pix3-collab-server/package.json'),
];

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

/**
 * Stamp `version` into each workspace package.json, in place.
 *
 * Edits the raw text instead of re-serialising the object: these files are checked out with CRLF
 * on Windows (core.autocrlf), so a `JSON.stringify` round-trip would rewrite every line and turn a
 * one-field bump into a whole-file diff. Files already on the target version are left untouched, so
 * calling this from `prebuild` costs nothing and never dirties the tree needlessly.
 *
 * @returns The packages that actually changed, for logging.
 */
export async function syncWorkspaceVersions(version, paths = workspacePackageJsonPaths) {
  const changed = [];

  for (const path of paths) {
    const raw = await readJsonFile(path, null);
    if (!raw || raw.version === version) {
      continue;
    }

    const text = await readFile(path, 'utf8');
    // First `"version":` in a package.json is the top-level one — dependency entries are
    // `"name": "range"`, never `"version":`.
    const match = /^(\s*"version"\s*:\s*")([^"]*)(")/m.exec(text);
    if (!match) {
      throw new Error(`No top-level "version" field found in ${path}`);
    }

    const previous = match[2];
    const start = match.index + match[1].length;
    const next = `${text.slice(0, start)}${version}${text.slice(start + previous.length)}`;
    await writeFile(path, next, 'utf8');
    changed.push({ path, previous, version, name: raw.name });
  }

  return changed;
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
  // The workspace stamp lives here rather than inside updateVersionArtifacts() so that function
  // stays confined to the paths it is handed — a spec pointing it at a temp dir must not reach out
  // and rewrite the real packages.
  //
  // `--sync-only` skips the manifest, i.e. propagates the current version without burning a build
  // number. That is what `npm run version:sync` is for.
  const syncOnly = process.argv.includes('--sync-only');

  if (!syncOnly) {
    const manifest = await updateVersionArtifacts();
    console.log(`[version] Updated to ${manifest.displayVersion}`);
  }

  const { version } = await readJsonFile(packageJsonPath);
  const changed = await syncWorkspaceVersions(version);

  for (const entry of changed) {
    console.log(`[version] ${entry.name}: ${entry.previous} -> ${entry.version}`);
  }
  if (changed.length === 0) {
    console.log(`[version] Workspace packages already at ${version}`);
  }
}
