// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildKitFromCheckout } from '../kit/kit-source.ts';
import type { KitSource } from '../kit/kit-source.ts';
import { agentKitStep } from '../kit/install.ts';
import { createProject } from '../new-project.ts';
import { listTemplates } from '../templates.ts';
import { ensureRuntimeTypes } from '../types/runtime-types.ts';
import { validateProject } from '../validate/validate.ts';
import { CLI_VERSION } from '../version.ts';
import {
  CHECK_CODES,
  checkProject,
  describeMergeLogEntry,
  formatCheckHuman,
  runCheck,
  type CheckReport,
  type ValidateFn,
} from './check.ts';
import { PINNED_TYPESCRIPT_VERSION, resolveTypeScript } from './typescript.ts';

/**
 * `pix3 check`: validate + tsc + merge-log + versions. The validator runs from source here (the
 * CLI runs its bundle — same function). TypeScript comes from the monorepo (the CLI's sibling
 * install) unless a test says otherwise. `covers every check code` fails when a code is added to
 * `CHECK_CODES` without a test that produces it.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-check-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const validate: ValidateFn = options => validateProject(options);
const covered = new Set<string>();
const note = (report: CheckReport): CheckReport => {
  for (const d of report.diagnostics) covered.add(d.code);
  return report;
};

let kit: KitSource;
let counter = 0;

beforeAll(async () => {
  const outDir = join(scratch, 'kit');
  const manifest = await buildKitFromCheckout({ outDir, coreComponents: [] });
  kit = { dir: outDir, filesDir: join(outDir, 'files'), manifest };
  ensureRuntimeTypes(); // rebuilt here (not in a test's time budget) when the runtime changed
}, 120_000);

const newRecipe = (id = 'recipe-tapper-2d'): string => {
  const template = listTemplates().find(t => t.id === id);
  if (!template) throw new Error(`${id} missing`);
  const dir = join(scratch, `p${++counter}`);
  createProject({
    template,
    dir,
    postCreateSteps: [agentKitStep(kit, ensureRuntimeTypes(), { devMcp: false })],
  });
  return dir;
};

const check = async (root: string, hydrate = true): Promise<CheckReport> =>
  note(await checkProject(root, { hydrate, offline: false, validate }));

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

describe('pix3 check on a fresh recipe (no node_modules anywhere)', () => {
  it('type-checks the scripts against .pix3/types and reports byte hashes', async () => {
    const root = newRecipe();
    const report = await check(root);
    expect(report.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.typecheck).toMatchObject({
      ok: true,
      errors: 0,
      mode: 'pix3-types',
      tsconfig: '.pix3/tsconfig.check.json',
    });
    expect(report.typecheck.files).toBeGreaterThan(3);
    const script = report.files.find(f => f.file === 'scripts/GameRules.ts');
    expect(script?.sha256).toBe(sha256(join(root, 'scripts/GameRules.ts')));
    const scene = report.files.find(f => f.file === 'scenes/main.pix3scene');
    expect(scene?.sha256).toBe(sha256(join(root, 'scenes/main.pix3scene')));
    expect(report.kit).toEqual({ version: CLI_VERSION, cliVersion: CLI_VERSION, upToDate: true });
    expect(report.mergeLog).toEqual([]);
  }, 60_000);

  it('turns a tsc error into E_TYPE with file and line, and exits 1', async () => {
    const root = newRecipe();
    writeFileSync(
      join(root, 'scripts', 'Broken.ts'),
      "import { Script } from '@pix3/runtime';\n\nexport class Broken extends Script {\n  onStart(): void {\n    this.node?.position = 3;\n  }\n}\n"
    );
    const report = await check(root, false);
    const typeErrors = report.diagnostics.filter(d => d.code === 'E_TYPE');
    expect(typeErrors.length).toBeGreaterThan(0);
    expect(typeErrors[0]).toMatchObject({ severity: 'error', file: 'scripts/Broken.ts', line: 5 });
    expect(typeErrors[0].message).toMatch(/^TS\d+: /);
    expect(report.typecheck.ok).toBe(false);

    let out = '';
    const code = await runCheck(['--no-hydrate', '--json', '--project', root], {
      cwd: scratch,
      stdout: text => (out += text),
      stderr: () => {},
      validate,
    });
    expect(code).toBe(1);
    const json = JSON.parse(out) as CheckReport;
    expect(json.typecheck.errors).toBe(typeErrors.length);
  }, 60_000);

  it('re-installs .pix3/types when they are missing (a project the editor created)', async () => {
    const root = newRecipe();
    rmSync(join(root, '.pix3', 'types'), { recursive: true, force: true });
    rmSync(join(root, '.pix3', 'tsconfig.check.json'));
    const report = await check(root, false);
    expect(report.ok).toBe(true);
    expect(existsSync(join(root, '.pix3/types/@pix3/runtime/index.d.ts'))).toBe(true);
    expect(report.notes.join('\n')).toMatch(/Wrote the @pix3\/runtime .* types/);
  }, 60_000);

  it('W_KIT_OUTDATED when the kit was written by another CLI version', async () => {
    const root = newRecipe();
    const manifestPath = join(root, 'pix3project.yaml');
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8').replace(
        `version: ${CLI_VERSION}\n    files:`,
        'version: 0.0.1\n    files:'
      )
    );
    const report = await check(root, false);
    expect(report.kit).toEqual({ version: '0.0.1', cliVersion: CLI_VERSION, upToDate: false });
    expect(report.diagnostics.find(d => d.code === 'W_KIT_OUTDATED')).toMatchObject({
      severity: 'warning',
      fix: expect.stringContaining('pix3 kit --update'),
    });
    expect(report.ok).toBe(true);
  }, 60_000);
});

describe('merge log', () => {
  it('reports the newest 10 lines and says when the editor kept a human value', async () => {
    const root = newRecipe();
    const lines: string[] = [];
    for (let i = 0; i < 11; i++) {
      lines.push(
        JSON.stringify({
          at: new Date(Date.now() - 60_000).toISOString(),
          file: 'scenes/main.pix3scene',
          event: 'reload',
          hash: `h${i}`,
          reason: 'no-protected-edits',
        })
      );
    }
    lines.push(
      JSON.stringify({
        at: new Date().toISOString(),
        file: 'scenes/main.pix3scene',
        event: 'merge',
        status: 'conflicts',
        decisions: [
          { nodeId: 'hud', path: ['properties', 'labelColor'], label: 'x', kept: 'human' },
        ],
        conflicts: [{ id: 'c1', kind: 'property', message: 'kept' }],
        mergedHash: null,
        protected: [],
      }),
      '{"torn'
    );
    writeFileSync(join(root, '.pix3', 'merge-log.jsonl'), `${lines.join('\n')}\n`);
    const report = await check(root, false);
    expect(report.mergeLog).toHaveLength(10);
    expect(report.mergeLog.at(-1)).toMatchObject({ event: 'merge', status: 'conflicts' });
    const human = formatCheckHuman(report, new Date());
    expect(human).toContain('the editor KEPT 1 human value(s) over yours');
    expect(human).toContain('pix3 read scenes/main.pix3scene');
  }, 60_000);

  it('prints an ignored read confirmation as a note, not as a merge-log line', async () => {
    const root = newRecipe();
    const current = sha256(join(root, 'scenes', 'main.pix3scene'));
    writeFileSync(
      join(root, '.pix3', 'merge-log.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), file: 'scenes/main.pix3scene', event: 'ack-unknown', hash: current })}\n`
    );
    const human = formatCheckHuman(await check(root, false), new Date());
    expect(human).toMatch(
      /^note: .*scenes\/main\.pix3scene {2}read confirmation for a version the editor has not recorded — ignored \(harmless/m
    );
    expect(human).not.toContain('merge-log (newest');
    expect(human).not.toContain('never saw');
  }, 60_000);

  it('drops an ignored read confirmation about a version the file no longer holds', async () => {
    // Measured on a real project: the same 17-hour-old note on every run, about bytes long gone.
    const root = newRecipe();
    writeFileSync(
      join(root, '.pix3', 'merge-log.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), file: 'scenes/main.pix3scene', event: 'ack-unknown', hash: 'abc' })}\n`
    );
    const report = await check(root, false);
    const human = formatCheckHuman(report, new Date());
    expect(human).not.toContain('read confirmation');
    // The JSON tail is the raw log: still there for whoever wants the history.
    expect(report.mergeLog).toHaveLength(1);
  }, 60_000);

  it('describes a rejected version', () => {
    expect(
      describeMergeLogEntry(
        {
          at: '2026-09-26T10:00:00.000Z',
          file: 'a.pix3scene',
          event: 'merge',
          status: 'rejected',
          problems: ['bad yaml'],
        },
        new Date('2026-09-26T10:00:30.000Z')
      )
    ).toBe(
      '30s ago  a.pix3scene  REJECTED your version (bad yaml); the editor kept its own. Fix the file and write it again.'
    );
  });
});

describe('a project with its own tsconfig.json', () => {
  /** `runtimeVersion`: a version = that @pix3/runtime installed; null = node_modules without it;
   * undefined = no node_modules at all. */
  const ownProject = (runtimeVersion?: string | null): string => {
    const root = join(scratch, `own${++counter}`);
    mkdirSync(join(root, 'src', 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'pix3project.yaml'),
      'version: 1.0.0\nprojectType: 2d\nmetadata:\n  projectName: Own\n'
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          module: 'ESNext',
          moduleResolution: 'bundler',
          target: 'ES2022',
        },
        include: ['src'],
      })
    );
    writeFileSync(join(root, 'src', 'scripts', 'plain.ts'), 'export const answer: number = 42;\n');
    if (runtimeVersion !== undefined) mkdirSync(join(root, 'node_modules'), { recursive: true });
    if (runtimeVersion) {
      const pkg = join(root, 'node_modules', '@pix3', 'runtime');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({ name: '@pix3/runtime', version: runtimeVersion })
      );
    }
    return root;
  };

  it('runs that tsconfig, writes no .pix3/types, and warns on a runtime version mismatch', async () => {
    const root = ownProject('1.2.0');
    const report = await check(root, false);
    expect(report.typecheck).toMatchObject({
      mode: 'project',
      tsconfig: 'tsconfig.json',
      ok: true,
    });
    expect(existsSync(join(root, '.pix3', 'types'))).toBe(false);
    expect(
      report.diagnostics.find(d => d.code === 'W_RUNTIME_VERSION_MISMATCH')?.message
    ).toContain('1.2.0');
    expect(report.ok).toBe(true);
    expect(report.kit.version).toBeNull();
  }, 60_000);

  it('W_RUNTIME_NOT_INSTALLED with node_modules but without @pix3/runtime', async () => {
    const report = await check(ownProject(null), false);
    const codes = report.diagnostics.map(d => d.code);
    expect(codes).toContain('W_RUNTIME_NOT_INSTALLED');
    expect(codes).not.toContain('E_DEPENDENCIES_MISSING');
  }, 60_000);

  it('one E_DEPENDENCIES_MISSING (fix: npm install) and no tsc cascade without node_modules', async () => {
    const root = ownProject();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'own', private: true }));
    // Every one of these imports would be its own "Cannot find module" E_TYPE if tsc ran.
    writeFileSync(
      join(root, 'src', 'scripts', 'Uses.ts'),
      "import { Script } from '@pix3/runtime';\nimport { Vector3 } from 'three';\nimport { x } from 'lodash-es';\nexport class Uses extends Script {}\nexport const v = new Vector3(x, 0, 0);\n"
    );
    mkdirSync(join(root, 'src', 'assets', 'scenes'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'assets', 'scenes', 'main.pix3scene'),
      'version: 1.0.0\nroot:\n  - id: root\n    type: Group2D\n    name: Root\n'
    );
    const report = await check(root, false);
    const errors = report.diagnostics.filter(d => d.severity === 'error');
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'E_DEPENDENCIES_MISSING',
        file: 'package.json',
        fix: 'npm install',
      }),
    ]);
    expect(report.diagnostics.some(d => d.code === 'E_TYPE')).toBe(false);
    expect(report.diagnostics.some(d => d.code === 'W_RUNTIME_NOT_INSTALLED')).toBe(false);
    expect(report.typecheck).toMatchObject({ ok: false, errors: 1, typescript: null });
    expect(report.typecheck.skipped).toContain('npm install');
    // validate still ran
    expect(report.files.map(f => f.file)).toContain('src/assets/scenes/main.pix3scene');
    expect(formatCheckHuman(report, new Date())).toContain(
      'typecheck skipped: dependencies not installed'
    );
  }, 60_000);
});

describe('where TypeScript comes from', () => {
  const env = process.env.PIX3_TYPESCRIPT;
  beforeAll(() => {
    delete process.env.PIX3_TYPESCRIPT;
  });
  afterAll(() => {
    if (env !== undefined) process.env.PIX3_TYPESCRIPT = env;
  });
  const monorepoTypescript = join(dirname(fileURLToPath(import.meta.resolve('typescript'))), '..');

  it('--offline with nothing installed fails with the command to run (E_TYPECHECK_UNAVAILABLE)', async () => {
    const root = newRecipe();
    const cacheRoot = join(scratch, `cache${++counter}`);
    const report = note(
      await checkProject(root, {
        hydrate: false,
        offline: true,
        validate,
        typescript: { cacheRoot, skipCliSibling: true },
      })
    );
    const failure = report.diagnostics.find(d => d.code === 'E_TYPECHECK_UNAVAILABLE');
    expect(failure?.fix).toContain(`npm install --prefix`);
    expect(failure?.fix).toContain(`typescript@${PINNED_TYPESCRIPT_VERSION}`);
    expect(report.ok).toBe(false);
    expect(report.typecheck.typescript).toBeNull();
  }, 60_000);

  it('installs the pinned version once into the cache, printing what it runs, then reuses it', async () => {
    const root = newRecipe();
    const cacheRoot = join(scratch, `cache${++counter}`);
    const logged: string[] = [];
    let installs = 0;
    const install = (prefix: string): string | null => {
      installs += 1;
      mkdirSync(join(prefix, 'node_modules'), { recursive: true });
      symlinkSync(monorepoTypescript, join(prefix, 'node_modules', 'typescript'), 'dir');
      return null;
    };
    const first = await resolveTypeScript({
      projectRoot: root,
      cacheRoot,
      install,
      log: l => logged.push(l),
      skipCliSibling: true,
    });
    expect(first.source).toBe('installed');
    expect(logged.join('\n')).toContain(`npm install --prefix`);
    const second = await resolveTypeScript({
      projectRoot: root,
      cacheRoot,
      install,
      skipCliSibling: true,
    });
    expect(second.source).toBe('cache');
    expect(installs).toBe(1);
  });

  it("prefers the project's own node_modules/typescript", async () => {
    const root = newRecipe();
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    cpSync(
      join(monorepoTypescript, 'package.json'),
      join(root, 'node_modules', 'typescript', 'package.json')
    );
    symlinkSync(
      join(monorepoTypescript, 'lib'),
      join(root, 'node_modules', 'typescript', 'lib'),
      'dir'
    );
    const resolved = await resolveTypeScript({ projectRoot: root });
    expect(resolved.source).toBe('project');
  });
});

describe('exit codes and coverage', () => {
  it('exit 2 outside a project', async () => {
    let err = '';
    const code = await runCheck([], {
      cwd: scratch,
      stdout: () => {},
      stderr: t => (err += t),
      validate,
    });
    expect(code).toBe(2);
    expect(err).toContain('no pix3project.yaml');
  });

  it('covers every check code', () => {
    expect([...Object.keys(CHECK_CODES)].filter(code => !covered.has(code))).toEqual([]);
  });
});
