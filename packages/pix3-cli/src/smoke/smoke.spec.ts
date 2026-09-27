// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  formatSmokeHuman,
  formatSmokeSetHuman,
  runSmoke,
  runSmokeCli,
  runSmokeSet,
  selectScenesFor,
  smokeExitCode,
  smokeSetExitCode,
} from './command.ts';
import { isSmokeFailure, type SmokeOutcome, type SmokeReport, type SmokeRunSet } from './report.ts';

/**
 * `pix3 smoke` against small fixture projects: the real CLI path (smoke bundle built from source,
 * the game run in a worker thread), so what is asserted here is what an agent gets.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-smoke-spec-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const write = (root: string, files: Record<string, string>): void => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

const MANIFEST = `version: 1.0.0
viewportBaseSize:
  width: 1080
  height: 1920
projectType: 2d
targetPlatform: mobile
`;

const scene = (components: string, extraNodes = ''): string => `version: 1.0.0
root:
  - id: game-root
    type: Group2D
    name: Game Root
    properties:
      width: 1080
      height: 1920
    components:
${components}
    children:
      - id: backdrop
        type: ColorRect2D
        name: Backdrop
        properties:
          width: 1080
          height: 1920
          color: "#202838"
${extraNodes}
`;

const script = (
  name: string,
  body: string
): string => `import { Script, type PropertySchema } from '@pix3/runtime';

export class ${name} extends Script {
  private frames = 0;

  static getPropertySchema(): PropertySchema {
    return { nodeType: '${name}', properties: [] };
  }

${body}
}
`;

let counter = 0;
const project = (files: Record<string, string>): string => {
  const root = join(scratch, `p${++counter}`);
  write(root, { 'pix3project.yaml': MANIFEST, ...files });
  return root;
};

const component = (type: string): string => `      - id: ${type.replace(/\W/g, '-').toLowerCase()}
        type: ${type}
        enabled: true
        config: {}`;

const MAIN = 'scenes/main.pix3scene';

const asReport = (outcome: SmokeOutcome): SmokeReport => {
  if (isSmokeFailure(outcome))
    throw new Error(`smoke could not run: ${outcome.code} ${outcome.reason}`);
  return outcome;
};

describe('pix3 smoke', () => {
  it('runs a clean scene: no errors, every frame stepped, node counts and timings', async () => {
    const root = project({
      'scenes/main.pix3scene': scene(component('user:Ticker')),
      'scripts/Ticker.ts': script('Ticker', '  onUpdate(): void {\n    this.frames += 1;\n  }'),
    });
    const report = asReport(await runSmoke({ projectRoot: root, scene: MAIN, frames: 30 }));
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({
      ok: true,
      scene: 'scenes/main.pix3scene',
      frames: 30,
      framesRequested: 30,
      firstFrameOk: true,
      nodes: { start: 2, end: 2 },
      scripts: ['user:Ticker'],
    });
    expect(report.timingsMs.step.max).toBeGreaterThanOrEqual(report.timingsMs.step.mean);
    expect(smokeExitCode(report)).toBe(0);
  });

  it('reports a throw in onStart with the script name, the node and frame 0', async () => {
    const root = project({
      'scenes/main.pix3scene': scene(component('user:StartBoom')),
      'scripts/StartBoom.ts': script(
        'StartBoom',
        "  onStart(): void {\n    throw new Error('start went wrong');\n  }"
      ),
    });
    const report = asReport(await runSmoke({ projectRoot: root, scene: MAIN, frames: 10 }));
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({
      code: 'E_SMOKE_SCRIPT',
      frame: 0,
      script: 'user:StartBoom',
      nodeId: 'game-root',
      nodeName: 'Game Root',
      phase: 'start',
      message: 'Error: start went wrong',
    });
    // Source-mapped: the stack names the project's own file.
    expect(report.errors[0].stack).toMatch(/scripts\/StartBoom\.ts:\d+/);
    expect(report.firstFrameOk).toBe(false);
    expect(smokeExitCode(report)).toBe(1);
    const human = formatSmokeHuman(report, root);
    expect(human).toContain(
      'frame 0  E_SMOKE_SCRIPT user:StartBoom on "Game Root" (start): Error: start went wrong'
    );
    // The project root is stripped from stack lines: they name the project's own file.
    expect(human).toMatch(/at StartBoom\.onStart \(scripts\/StartBoom\.ts:\d+:\d+\)/);
  });

  it('reports a throw in onUpdate on the frame it happened (frame 3)', async () => {
    const root = project({
      'scenes/main.pix3scene': scene(component('user:LateBoom')),
      'scripts/LateBoom.ts': script(
        'LateBoom',
        // The pre-roll update of frame 0 runs with dt = 0; stepped frames carry 1/60 s.
        "  onUpdate(dt: number): void {\n    if (dt > 0) this.frames += 1;\n    if (this.frames === 3) throw new Error('third frame');\n  }"
      ),
    });
    const report = asReport(await runSmoke({ projectRoot: root, scene: MAIN, frames: 10 }));
    expect(report.errors).toEqual([
      expect.objectContaining({
        code: 'E_SMOKE_SCRIPT',
        frame: 3,
        script: 'user:LateBoom',
        phase: 'update',
      }),
    ]);
    // The engine disabled the component; the game kept stepping.
    expect(report.frames).toBe(10);
    expect(report.firstFrameOk).toBe(true);
  });

  it('reports a missing res:// file as a warning, not an error', async () => {
    const root = project({
      'scenes/main.pix3scene': scene(
        component('core:Hitbox2D'),
        `      - id: coin
        type: Sprite2D
        name: Coin
        properties:
          width: 64
          height: 64
          texture:
            type: texture
            url: res://sprites/missing-coin.png
`
      ),
    });
    const report = asReport(await runSmoke({ projectRoot: root, scene: MAIN, frames: 5 }));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: 'W_SMOKE_MISSING_RESOURCE',
        message: expect.stringContaining('res://sprites/missing-coin.png'),
      }),
    ]);
    expect(smokeExitCode(report)).toBe(0);
  });

  it('names the missing browser API when a script needs one the shim does not provide', async () => {
    const root = project({
      'scenes/main.pix3scene': scene(component('user:Vibrate')),
      'scripts/Vibrate.ts': script(
        'Vibrate',
        '  onStart(): void {\n    (window as unknown as { webkitRequestFullscreen: () => void }).webkitRequestFullscreen();\n  }'
      ),
    });
    const report = asReport(await runSmoke({ projectRoot: root, scene: MAIN, frames: 3 }));
    expect(report.errors).toEqual([
      expect.objectContaining({
        code: 'E_SMOKE_DOM',
        frame: 0,
        script: 'user:Vibrate',
        domAccess: ['window.webkitRequestFullscreen'],
      }),
    ]);
    expect(report.domMissing).toContain('window.webkitRequestFullscreen');
  });

  it('juice.flash runs headless: the canvas has a parent, so no overlay warning', async () => {
    const root = project({
      'scenes/main.pix3scene': scene(component('user:Flasher')),
      'scripts/Flasher.ts': script(
        'Flasher',
        "  onUpdate(dt: number): void {\n    if (dt > 0) this.frames += 1;\n    if (this.frames === 2) this.scene?.juice.flash({ color: '#ff0000', intensity: 0.5, durationSec: 0.1 });\n  }"
      ),
    });
    const report = asReport(await runSmoke({ projectRoot: root, scene: MAIN, frames: 10 }));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('catches console.error and unhandled rejections from scripts', async () => {
    const root = project({
      'scenes/main.pix3scene': scene(component('user:Noisy')),
      'scripts/Noisy.ts': script(
        'Noisy',
        "  onStart(): void {\n    console.error('state is bad');\n    void Promise.reject(new Error('nobody waits for me'));\n  }"
      ),
    });
    const report = asReport(await runSmoke({ projectRoot: root, scene: MAIN, frames: 3 }));
    expect(report.errors.map(e => [e.code, e.message])).toEqual([
      ['E_SMOKE_CONSOLE_ERROR', 'state is bad'],
      ['E_SMOKE_UNHANDLED', 'Error: nobody waits for me'],
    ]);
  });

  it('reports scripts that do not compile', async () => {
    const root = project({
      'scenes/main.pix3scene': scene(component('user:Broken')),
      'scripts/Broken.ts':
        "import { Script } from '@pix3/runtime';\nexport class Broken extends Script {\n  onStart( {\n}\n",
    });
    const report = asReport(await runSmoke({ projectRoot: root, scene: MAIN }));
    expect(report.errors[0]).toMatchObject({ code: 'E_SMOKE_SCRIPT_COMPILE', frame: 0 });
    expect(report.errors[0].message).toContain('scripts/Broken.ts');
  });

  it('stops a script stuck in an endless loop: exit 2, E_SMOKE_TIMEOUT', async () => {
    const root = project({
      'scenes/main.pix3scene': scene(component('user:Spin')),
      'scripts/Spin.ts': script(
        'Spin',
        '  onUpdate(dt: number): void {\n    while (dt > 0) this.frames += 1;\n  }'
      ),
    });
    const outcome = await runSmoke({ projectRoot: root, scene: MAIN, frames: 5, timeoutSec: 2 });
    expect(outcome).toMatchObject({
      ok: false,
      code: 'E_SMOKE_TIMEOUT',
      scene: 'scenes/main.pix3scene',
    });
    expect(smokeExitCode(outcome)).toBe(2);
  });

  it('exit 2 with a clear reason when the named scene does not exist, or there are no scenes', async () => {
    const root = project({ 'scenes/a.pix3scene': scene('') });
    const missing = await runSmoke({ projectRoot: root, scene: 'scenes/nope.pix3scene' });
    expect(missing).toMatchObject({ ok: false, code: 'E_SMOKE_NO_SCENE' });

    const empty = project({ 'README.md': 'nothing here' });
    expect(await runSmokeSet({ projectRoot: empty })).toMatchObject({
      ok: false,
      code: 'E_SMOKE_NO_SCENE',
      reason: 'the project has no .pix3scene files.',
    });
  });

  describe('no scene argument: which scenes run', () => {
    // A recipe's shape: a menu (the manifest's entry scene) that never leaves itself headless, and
    // the game, whose onStart throws. The old default ran only the menu and smoked green (D1).
    const recipe = (): string =>
      project({
        'pix3project.yaml': `${MANIFEST}defaultExportScenePath: scenes/menu.pix3scene\n`,
        // The menu names the game as its PLAY target: a changeScene, not a dependency.
        'scenes/menu.pix3scene': scene(
          component('user:MenuFlow'),
          `      - id: play
        type: Group2D
        name: Play
        properties:
          target: res://scenes/main.pix3scene
`
        ),
        'scenes/main.pix3scene': scene(
          component('user:GameBoom'),
          `      - id: coin
        instance: res://scenes/prefabs/coin.pix3scene
`
        ),
        'scenes/prefabs/coin.pix3scene': scene(component('user:CoinSpin')),
        'scenes/ui/result.pix3scene': scene(''),
        'scripts/MenuFlow.ts': script(
          'MenuFlow',
          '  onUpdate(): void {\n    this.frames += 1;\n  }'
        ),
        'scripts/CoinSpin.ts': script(
          'CoinSpin',
          '  onUpdate(): void {\n    this.frames += 1;\n  }'
        ),
        'scripts/GameBoom.ts': script(
          'GameBoom',
          "  onStart(): void {\n    throw new Error('game start broke');\n  }"
        ),
        'scripts/util.ts': 'export const two = 2;\n',
        'design/recipe.md': '# notes\n',
      });

    it('without git: every top-level scene, the game first, and the throw in the game fails the run', async () => {
      const root = recipe();
      const set = (await runSmokeSet({
        projectRoot: root,
        frames: 5,
        changedFiles: null,
      })) as SmokeRunSet;
      expect(set).toMatchObject({ ok: false, selection: 'all' });
      expect(set.runs.map(run => run.scene)).toEqual([
        'scenes/main.pix3scene',
        'scenes/menu.pix3scene',
      ]);
      expect(set.runs.map(run => smokeExitCode(run))).toEqual([1, 0]);
      expect(smokeSetExitCode(set)).toBe(1);
      const human = formatSmokeSetHuman(set, root);
      expect(human).toMatch(/scenes\/main\.pix3scene\s+FAILED — 5 frames, 1 error/);
      expect(human).toMatch(/scenes\/menu\.pix3scene\s+ok — 5 frames, 0 errors/);
      expect(human).toContain('Error: game start broke');
    });

    it('changed files pick the scenes they reach: a script, a prefab, the scene itself', () => {
      const root = recipe();
      const pick = (changedFiles: string[] | null) =>
        selectScenesFor({ projectRoot: root, changedFiles });
      expect(pick(['scripts/GameBoom.ts'])).toMatchObject({
        mode: 'changed',
        scenes: ['scenes/main.pix3scene'],
      });
      expect(pick(['scenes/prefabs/coin.pix3scene'])).toMatchObject({
        scenes: ['scenes/main.pix3scene'],
      });
      expect(pick(['scripts/CoinSpin.ts'])).toMatchObject({ scenes: ['scenes/main.pix3scene'] });
      expect(pick(['scripts/MenuFlow.ts'])).toMatchObject({
        mode: 'changed',
        scenes: ['scenes/menu.pix3scene'],
      });
      expect(pick(['scenes/menu.pix3scene', 'scripts/GameBoom.ts'])).toMatchObject({
        scenes: ['scenes/main.pix3scene', 'scenes/menu.pix3scene'],
      });
      // Nothing to narrow it down with, or a change that reaches no scene: everything, never a guess.
      expect(pick([])).toMatchObject({ mode: 'all' });
      expect(pick(['design/recipe.md'])).toMatchObject({ mode: 'all' });
      expect(pick(['scripts/util.ts', 'scripts/MenuFlow.ts'])).toMatchObject({
        mode: 'all',
        reason: expect.stringContaining('scripts/util.ts'),
      });
      expect(pick(['pix3project.yaml', 'scripts/MenuFlow.ts'])).toMatchObject({ mode: 'all' });
      expect(
        selectScenesFor({ projectRoot: root, changedFiles: ['scripts/MenuFlow.ts'], all: true })
      ).toMatchObject({
        mode: 'all',
      });
      expect(
        selectScenesFor({ projectRoot: root, changedFiles: null, changedOnly: true })
      ).toMatchObject({
        code: 'E_SMOKE_NO_SCENE',
      });
      expect(
        selectScenesFor({ projectRoot: root, changedFiles: [], changedOnly: true })
      ).toMatchObject({
        code: 'E_SMOKE_NO_SCENE',
      });
    });

    it('asks git: an uncommitted edit to a game script smokes the game, not the menu', () => {
      const root = recipe();
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
          stdio: 'ignore',
        });
      try {
        git('init', '-q');
      } catch {
        return; // no git on this machine: the fallback is covered above
      }
      git('add', '-A');
      git('commit', '-q', '-m', 'baseline');
      expect(selectScenesFor({ projectRoot: root })).toMatchObject({
        mode: 'all',
        reason: expect.stringContaining('nothing changed'),
      });
      write(root, { 'scripts/GameBoom.ts': script('GameBoom', '  onStart(): void {}') });
      expect(selectScenesFor({ projectRoot: root })).toMatchObject({
        mode: 'changed',
        scenes: ['scenes/main.pix3scene'],
        changed: ['scripts/GameBoom.ts'],
      });
      write(root, { 'scripts/Extra.ts': 'export const x = 1;\n' });
      expect(selectScenesFor({ projectRoot: root })).toMatchObject({ mode: 'all' });
    });

    it('prefabs and scenes/ui are never run on their own', async () => {
      const root = project({
        'levels/start.pix3scene': scene(''),
        'scenes/prefabs/coin.pix3scene': scene(''),
        'scenes/ui/result.pix3scene': scene(''),
      });
      const set = (await runSmokeSet({
        projectRoot: root,
        frames: 1,
        changedFiles: null,
      })) as SmokeRunSet;
      expect(set.runs.map(run => run.scene)).toEqual(['levels/start.pix3scene']);
      expect(set.ok).toBe(true);
    });
  });

  it('CLI: --json output, exit codes, usage errors', async () => {
    const root = project({
      'scenes/main.pix3scene': scene(component('user:StartBoom')),
      'scripts/StartBoom.ts': script(
        'StartBoom',
        "  onStart(): void {\n    throw new Error('nope');\n  }"
      ),
    });
    let out = '';
    const io = { cwd: root, stdout: (text: string) => void (out += text), stderr: () => {} };
    expect(await runSmokeCli(['scenes/main.pix3scene', '--json', '--frames', '2'], io)).toBe(1);
    const json = JSON.parse(out) as SmokeReport;
    expect(json).toMatchObject({
      ok: false,
      frames: 2,
      errors: [{ frame: 0, script: 'user:StartBoom' }],
    });
    expect(json.errors[0].stack).not.toContain(root);

    out = '';
    expect(await runSmokeCli(['--all', '--json', '--frames', '2'], io)).toBe(1);
    const set = JSON.parse(out) as SmokeRunSet;
    expect(set).toMatchObject({ ok: false, selection: 'all', runs: [{ scene: MAIN, frames: 2 }] });

    expect(await runSmokeCli(['--frames', 'lots'], io)).toBe(2);
    expect(await runSmokeCli(['--all', '--changed'], io)).toBe(2);
    expect(await runSmokeCli(['scenes/main.pix3scene', '--all'], io)).toBe(2);
  });
});
