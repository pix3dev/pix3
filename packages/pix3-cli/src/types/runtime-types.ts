import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { cliPackageRoot } from '../package-root.ts';
import { CLI_VERSION } from '../version.ts';

/**
 * The `.d.ts` of `@pix3/runtime` the CLI ships for its own lockstep version (plan §5 A, "Откуда
 * типы"), so `pix3 check` can type-check the scripts of a project that has no `node_modules`.
 *
 * Layout of `<package>/runtime-types/` (gitignored; built at `prepack` by
 * `scripts/build-runtime-types.mjs`, and on demand in a repo checkout when the runtime sources are
 * newer than the last build):
 *
 * - `@pix3/runtime/**` — `tsc -p packages/pix3-runtime/tsconfig.types.json` (declarations of what
 *   `src/index.ts` reaches; specs, `testing/`, `main.ts` never), plus a `package.json` with the
 *   version;
 * - `@types/three/**` — the runtime's public types extend three.js (`NodeBase extends Object3D`),
 *   so without them every node member is missing. Copied from the monorepo's install, without its
 *   own `node_modules` (webxr / webgpu / meshoptimizer typings are only reached from inside
 *   `@types/three`, which `skipLibCheck` leaves alone).
 * - `manifest.json` — versions and the source stamp the staleness check compares.
 *
 * **Published as one file.** The tree is ~1 100 files (almost all `@types/three`), and npm unpacks
 * a tarball file by file: shipping it as a directory measured +1.2–1.5 s on every cold AND warm
 * `npx` run. So `prepack` also packs it into `dist/runtime-types.json` (`packRuntimeTypes`), the
 * tarball carries only that, and the first command that needs the types expands it once
 * (`ensureRuntimeTypes` → `expandRuntimeTypes`) into `<package>/runtime-types/`, or a temp folder
 * where the package directory is read-only.
 *
 * Deliberately NOT shipped: `lit` (the runtime index re-exports `property`/`state` from
 * `lit/decorators.js`; unresolved inside a `.d.ts` under `skipLibCheck` they are `any`, and no
 * project script uses them), `postprocessing` and `@esotericsoftware/spine-threejs` (only reached
 * through `typeof import(...)` in declaration files, same treatment). Measured: the recipes
 * type-check against exactly this set with no `node_modules` anywhere up the tree.
 */

export const RUNTIME_TYPES_FORMAT = 1;

export interface RuntimeTypesManifest {
  readonly format: number;
  readonly cliVersion: string;
  readonly runtimeVersion: string;
  readonly threeTypesVersion: string;
  /** sha256 over the runtime sources' paths + sizes + mtimes (staleness in a repo checkout). */
  readonly sourceStamp: string;
  readonly builtAt: string;
}

const packageRoot = (): string => cliPackageRoot();

export const runtimeTypesDir = (): string => join(packageRoot(), 'runtime-types');

/** The published, single-file form of `runtime-types/` (see the layout note above). */
export const runtimeTypesArchive = (): string => join(packageRoot(), 'dist', 'runtime-types.json');

interface RuntimeTypesArchive {
  readonly format: number;
  readonly manifest: RuntimeTypesManifest;
  /** `[relative path with '/', utf-8 text]` — every file of the tree is text. */
  readonly files: readonly (readonly [string, string])[];
}

/** `<repo>/packages/pix3-runtime` when this CLI runs from a checkout of the pix3 repo, else null. */
export const repoRuntimePackage = (): string | null => {
  const runtime = join(packageRoot(), '..', 'pix3-runtime');
  return existsSync(join(runtime, 'tsconfig.types.json')) &&
    existsSync(join(packageRoot(), 'scripts', 'build-runtime-types.mjs'))
    ? runtime
    : null;
};

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

export const readRuntimeTypesManifest = (dir = runtimeTypesDir()): RuntimeTypesManifest | null =>
  readJson<RuntimeTypesManifest>(join(dir, 'manifest.json'));

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
};

/** Cheap staleness stamp of the runtime sources that feed the declarations. */
export const runtimeSourceStamp = (runtimePackage: string): string => {
  const hash = createHash('sha256');
  hash.update(`${CLI_VERSION}\n`);
  for (const name of ['tsconfig.json', 'tsconfig.types.json', 'package.json']) {
    hash.update(readFileSync(join(runtimePackage, name)));
  }
  const files = walk(join(runtimePackage, 'src'))
    .filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .sort();
  for (const file of files) {
    const stat = statSync(file);
    hash.update(`${relative(runtimePackage, file)}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`);
  }
  return hash.digest('hex');
};

const typesThreeDir = (runtimePackage: string): string => {
  const require = createRequire(join(runtimePackage, 'package.json'));
  return dirname(require.resolve('@types/three/package.json'));
};

/** Build `runtime-types/` from the repo's runtime sources (needs the repo's TypeScript). */
export const buildRuntimeTypes = (
  options: { readonly outDir?: string; readonly log?: (line: string) => void } = {}
): RuntimeTypesManifest => {
  const runtimePackage = repoRuntimePackage();
  if (!runtimePackage) {
    throw new Error('runtime types can only be built from a checkout of the pix3 repo');
  }
  const outDir = options.outDir ?? runtimeTypesDir();
  const require = createRequire(import.meta.url);
  const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  const staging = mkdtempSync(join(tmpdir(), 'pix3-runtime-types-'));
  try {
    const emitted = join(staging, 'emit');
    const result = spawnSync(
      process.execPath,
      [tsc, '-p', join(runtimePackage, 'tsconfig.types.json'), '--outDir', emitted],
      { encoding: 'utf8' }
    );
    if (result.status !== 0) {
      throw new Error(
        `tsc -p packages/pix3-runtime/tsconfig.types.json failed:\n${result.stdout}${result.stderr}`
      );
    }
    const runtimeVersion =
      readJson<{ version?: string }>(join(runtimePackage, 'package.json'))?.version ?? '0.0.0';
    const threeDir = typesThreeDir(runtimePackage);
    const threeTypesVersion =
      readJson<{ version?: string }>(join(threeDir, 'package.json'))?.version ?? '0.0.0';

    const next = join(staging, 'out');
    const runtimeOut = join(next, '@pix3', 'runtime');
    cpSync(emitted, runtimeOut, { recursive: true });
    writeFileSync(
      join(runtimeOut, 'package.json'),
      `${JSON.stringify({ name: '@pix3/runtime', version: runtimeVersion, types: 'index.d.ts' }, null, 2)}\n`
    );
    const threeOut = join(next, '@types', 'three');
    mkdirSync(threeOut, { recursive: true });
    for (const entry of readdirSync(threeDir)) {
      if (entry === 'node_modules') continue;
      cpSync(join(threeDir, entry), join(threeOut, entry), { recursive: true });
    }
    const manifest: RuntimeTypesManifest = {
      format: RUNTIME_TYPES_FORMAT,
      cliVersion: CLI_VERSION,
      runtimeVersion,
      threeTypesVersion,
      sourceStamp: runtimeSourceStamp(runtimePackage),
      builtAt: new Date().toISOString(),
    };
    writeFileSync(join(next, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(dirname(outDir), { recursive: true });
    cpSync(next, outDir, { recursive: true });
    options.log?.(
      `runtime types ${runtimeVersion} (+ @types/three ${threeTypesVersion}) -> ${outDir}`
    );
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};

/** Pack a built `runtime-types/` tree into the single archive file the tarball ships. */
export const packRuntimeTypes = (
  dir = runtimeTypesDir(),
  archive = runtimeTypesArchive()
): { files: number; bytes: number } => {
  const manifest = readRuntimeTypesManifest(dir);
  if (!manifest) throw new Error(`${dir} has no manifest.json: build the runtime types first`);
  const files = walk(dir)
    .map(file => relative(dir, file).split(sep).join('/'))
    .filter(file => file !== 'manifest.json')
    .sort()
    .map(file => {
      const bytes = readFileSync(join(dir, file));
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) {
        throw new Error(`runtime types: ${file} is not UTF-8 text and cannot be archived`);
      }
      return [file, text] as const;
    });
  const body: RuntimeTypesArchive = { format: RUNTIME_TYPES_FORMAT, manifest, files };
  const json = JSON.stringify(body);
  mkdirSync(dirname(archive), { recursive: true });
  writeFileSync(archive, json);
  return { files: files.length, bytes: Buffer.byteLength(json) };
};

const writeTree = (archive: RuntimeTypesArchive, dir: string): void => {
  const staging = `${dir}.tmp-${process.pid}-${Date.now()}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const [file, text] of archive.files) {
      const target = join(staging, ...file.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(archive.manifest, null, 2)}\n`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    // Another process expanded the same archive first: theirs is as good as ours.
    if (readRuntimeTypesManifest(dir)?.sourceStamp === archive.manifest.sourceStamp) return;
    throw error;
  }
};

/**
 * Expand the published archive (once) and return where the tree now is: `<package>/runtime-types/`,
 * or — when the package directory is not writable (a root-owned global install) — a folder under
 * the OS temp dir keyed by the archive's stamp. Null when there is no archive.
 */
export const expandRuntimeTypes = (
  archiveFile = runtimeTypesArchive(),
  dir = runtimeTypesDir()
): { dir: string; manifest: RuntimeTypesManifest } | null => {
  if (!existsSync(archiveFile)) return null;
  const archive = JSON.parse(readFileSync(archiveFile, 'utf8')) as RuntimeTypesArchive;
  if (archive.format !== RUNTIME_TYPES_FORMAT) {
    throw new Error(
      `${archiveFile}: runtime types archive format ${archive.format}, expected ${RUNTIME_TYPES_FORMAT}`
    );
  }
  const fallback = join(
    tmpdir(),
    `pix3-cli-runtime-types-${archive.manifest.cliVersion}-${archive.manifest.sourceStamp.slice(0, 12)}`
  );
  for (const target of [dir, fallback]) {
    if (readRuntimeTypesManifest(target)?.sourceStamp === archive.manifest.sourceStamp) {
      return { dir: target, manifest: archive.manifest };
    }
    try {
      writeTree(archive, target);
      return { dir: target, manifest: archive.manifest };
    } catch (error) {
      if (target === fallback) throw error;
    }
  }
  return null;
};

/**
 * The directory holding the shipped runtime types, current for this CLI. In a repo checkout it is
 * rebuilt when the runtime sources changed since the last build (a few seconds, printed); a
 * published package carries it as `dist/runtime-types.json` (`prepack`), expanded on first use.
 */
export const ensureRuntimeTypes = (
  options: { readonly log?: (line: string) => void } = {}
): { dir: string; manifest: RuntimeTypesManifest } => {
  const dir = runtimeTypesDir();
  const runtimePackage = repoRuntimePackage();
  const current = readRuntimeTypesManifest(dir);
  if (runtimePackage) {
    if (
      current &&
      current.format === RUNTIME_TYPES_FORMAT &&
      current.sourceStamp === runtimeSourceStamp(runtimePackage)
    ) {
      return { dir, manifest: current };
    }
    options.log?.('Building the @pix3/runtime type declarations from the repo sources…');
    return { dir, manifest: buildRuntimeTypes({ log: options.log }) };
  }
  // Published package: expanded from `dist/runtime-types.json` on first use.
  if (current?.format === RUNTIME_TYPES_FORMAT && current.cliVersion === CLI_VERSION) {
    return { dir, manifest: current };
  }
  const expanded = expandRuntimeTypes();
  if (expanded) return expanded;
  if (!current) {
    throw new Error(
      `${runtimeTypesArchive()} is missing: this @pix3/cli package was published without its runtime types.`
    );
  }
  return { dir, manifest: current };
};
