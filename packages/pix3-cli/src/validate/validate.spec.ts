// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runValidate } from './command.ts';
import { DIAGNOSTIC_CODES, type Diagnostic } from './diagnostics.ts';
import { scanExportNames } from './user-scripts.ts';
import { validateProject, type ValidateOptions, type ValidateReport } from './validate.ts';

/**
 * One fixture per diagnostic code. Each fixture is a tiny project written to a temp folder, and
 * each test asserts the code fires where it should (and, for the easily-confused ones, that a
 * near-miss does NOT fire it). `covers every code` at the end fails when a code is added to
 * `DIAGNOSTIC_CODES` without a fixture here.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-validate-fixtures-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const covered = new Set<string>();

const MANIFEST =
  'version: 1.0.0\nprojectType: 2d\ntargetPlatform: mobile\nmetadata:\n  projectName: Fixture\n';
const PNG = 'not really a png';

/** A scene with the given root-node YAML (already indented as list items under `root:`). */
const scene = (rootItems: string, header = 'version: 1.0.0\n'): string =>
  `${header}root:\n${rootItems}`;

const SCRIPT_SPINNER = `import { Script } from '@pix3/runtime';

export class Spinner extends Script {
  speed = 1;
  static getPropertySchema() {
    return {
      nodeType: 'Spinner',
      properties: [
        {
          name: 'speed',
          type: 'number' as const,
          getValue: (c: unknown) => (c as Spinner).speed,
          setValue: (c: unknown, v: unknown) => {
            (c as Spinner).speed = Number(v);
          },
        },
      ],
    };
  }
}
`;

const makeProject = (files: Record<string, string>): string => {
  const root = join(scratch, `p${counter++}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'pix3project.yaml'), MANIFEST);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
};

const run = async (
  files: Record<string, string>,
  options: Omit<ValidateOptions, 'projectRoot'> = {}
): Promise<ValidateReport> => validateProject({ projectRoot: makeProject(files), ...options });

/** Diagnostics with `code`, recorded as covered. */
const find = (report: ValidateReport, code: string): Diagnostic[] => {
  covered.add(code.startsWith('W_RENDERABILITY_') ? 'W_RENDERABILITY' : code);
  return report.diagnostics.filter(d => d.code === code);
};

const codesOf = (report: ValidateReport): string[] => report.diagnostics.map(d => d.code);

describe('level 1: structure', () => {
  it('E_YAML: the file does not parse', async () => {
    const report = await run({ 'scenes/a.pix3scene': 'root: [\n' });
    expect(find(report, 'E_YAML')).toHaveLength(1);
    expect(report.errorCount).toBe(1);
  });

  it('E_SHAPE: the shapes the loader accepts silently or crashes on', async () => {
    const report = await run({
      'scenes/object-root.pix3scene': 'version: 1.0.0\nroot: { a: 1 }\n',
      'scenes/scalar.pix3scene': 'hello\n',
      'scenes/no-root.pix3scene': 'version: 1.0.0\n',
      'scenes/nodes.pix3scene': scene(
        [
          '  - type: Node2D', // no id
          '  - id: b',
          '    type: Node2D',
          '    properties: abc',
          '  - id: c',
          '    type: Node2D',
          '    children: { x: 1 }',
          '  - id: d',
          '    type: Node2D',
          '    position: [1, 2]', // a property written at node level
          '    components:',
          '      - config: { speed: 1 }', // component without type
        ].join('\n') + '\n'
      ),
    });
    const shape = find(report, 'E_SHAPE');
    const byFile = (file: string) => shape.filter(d => d.file === file);
    expect(byFile('scenes/object-root.pix3scene')[0]?.message).toMatch(/root: must be a list/);
    expect(byFile('scenes/scalar.pix3scene')).toHaveLength(1);
    expect(byFile('scenes/no-root.pix3scene')[0]?.message).toMatch(/no root/);
    const nodes = byFile('scenes/nodes.pix3scene').map(d => d.path);
    expect(nodes).toEqual(
      expect.arrayContaining([
        'root[0]',
        'root[1].properties',
        'root[2].children',
        'root[3].position',
        'root[3].components[0]',
      ])
    );
    // Line numbers point at the offending key.
    expect(byFile('scenes/nodes.pix3scene').find(d => d.path === 'root[3].position')?.line).toBe(
      12
    );
  });

  it('E_SHAPE: children/components on an instance node are ignored by the loader', async () => {
    const report = await run({
      'scenes/prefab.pix3scene': scene('  - id: p\n    type: Node2D\n'),
      'scenes/main.pix3scene': scene(
        '  - id: i\n    instance: res://scenes/prefab.pix3scene\n    children:\n      - id: k\n        type: Node2D\n'
      ),
    });
    expect(find(report, 'E_SHAPE').map(d => d.path)).toEqual(['root[0].children']);
  });

  it('E_DUPLICATE_ID', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene(
        '  - id: a\n    type: Node2D\n    children:\n      - id: a\n        type: Group2D\n'
      ),
    });
    expect(find(report, 'E_DUPLICATE_ID')).toMatchObject([
      { nodeId: 'a', path: 'root[0].children[0].id' },
    ]);
  });

  it('W_LEGACY_VERSION: missing or non-current version', async () => {
    const report = await run({
      'scenes/old.pix3scene': scene('  - id: a\n    type: Node2D\n', 'version: 0.9.0\n'),
      'scenes/none.pix3scene': scene('  - id: a\n    type: Node2D\n', ''),
      'scenes/ok.pix3scene': scene('  - id: a\n    type: Node2D\n'),
    });
    expect(find(report, 'W_LEGACY_VERSION').map(d => d.file)).toEqual([
      'scenes/none.pix3scene',
      'scenes/old.pix3scene',
    ]);
    expect(report.errorCount).toBe(0);
  });
});

describe('level 1: node types and properties', () => {
  it('E_UNKNOWN_NODE_TYPE with the nearest name, and Layout2D', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene('  - id: a\n    type: Sprit2D\n  - id: b\n    type: Layout2D\n'),
    });
    const [typo, layout] = find(report, 'E_UNKNOWN_NODE_TYPE');
    expect(typo).toMatchObject({ nodeId: 'a', fix: 'type: Sprite2D' });
    expect(typo.message).toContain('Did you mean "Sprite2D"?');
    expect(layout.message).toMatch(/Layout2D is no longer supported/);
  });

  it('W_TYPE_CASE: a case variant or alias loads but is not canonical', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene(
        '  - id: a\n    type: sprite2d\n  - id: b\n    type: Node3D\n    children:\n      - id: c\n        type: DirectionalLight\n'
      ),
    });
    expect(find(report, 'W_TYPE_CASE').map(d => d.fix)).toEqual([
      'type: Sprite2D',
      'type: DirectionalLightNode',
    ]);
    expect(report.errorCount).toBe(0);
  });

  it('E_UNKNOWN_PROPERTY: unknown, relocated, node-level and nested keys', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene(
        [
          '  - id: rect',
          '    type: ColorRect2D',
          '    properties:',
          '      widht: 10', // typo
          '      name: Oops', // node-level key under properties
          '      horizontalAlign: center', // lives at layout.horizontalAlign
          '      transform:',
          '        positon: [1, 2]', // nested typo
          '  - id: mesh',
          '    type: GeometryMesh',
          '    properties:',
          '      color: "#ff0000"', // lives at material.color
          '      material:',
          '        color: "#00ff00"', // correct
        ].join('\n') + '\n'
      ),
    });
    const unknown = find(report, 'E_UNKNOWN_PROPERTY');
    expect(unknown.map(d => d.path)).toEqual([
      'root[0].properties.widht',
      'root[0].properties.name',
      'root[0].properties.horizontalAlign',
      'root[0].properties.transform.positon',
      'root[1].properties.color',
    ]);
    expect(unknown[0].fix).toBe('did you mean width?');
    expect(unknown[2].fix).toBe('move it to properties.layout.horizontalAlign');
    expect(unknown[3].fix).toBe('did you mean transform.position?');
    expect(unknown[4].fix).toBe('move it to properties.material.color');
  });

  it('W_WRITE_ONLY_PROPERTY: saved by the editor, not read back (Label2D.texturePath)', async () => {
    const report = await run({
      'sprites/skin.png': PNG,
      'scenes/a.pix3scene': scene(
        '  - id: l\n    type: Label2D\n    properties:\n      label: Hi\n      texturePath: res://sprites/skin.png\n'
      ),
    });
    expect(find(report, 'W_WRITE_ONLY_PROPERTY')).toMatchObject([{ nodeId: 'l' }]);
    expect(report.errorCount).toBe(0);
  });

  it('W_LEGACY_KEY: read-compat spellings', async () => {
    const report = await run({
      'sprites/a.png': PNG,
      'scenes/a.pix3scene': scene(
        [
          '  - id: s',
          '    type: Sprite2D',
          '    properties:',
          '      texturePath: res://sprites/a.png',
          '  - id: n',
          '    type: Node3D',
          '    properties:',
          '      transform:',
          '        translate: [1, 2, 3]',
        ].join('\n') + '\n'
      ),
    });
    expect(find(report, 'W_LEGACY_KEY').map(d => d.fix)).toEqual([
      'rename to texture',
      'rename to transform.position',
    ]);
    expect(report.errorCount).toBe(0);
  });

  it('E_PROPERTY_TYPE: wrong value types, disk form included', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene(
        [
          '  - id: r',
          '    type: ColorRect2D',
          '    properties:',
          '      width: wide',
          '      color: 123',
          '      transform:',
          '        position: [1]',
          '      layout:',
          '        enabled: "yes"',
        ].join('\n') + '\n'
      ),
    });
    expect(find(report, 'E_PROPERTY_TYPE').map(d => d.path)).toEqual([
      'root[0].properties.width',
      'root[0].properties.color',
      'root[0].properties.transform.position',
      'root[0].properties.layout.enabled',
    ]);
  });

  it('E_PROPERTY_RANGE: the schema validation rule; W_PROPERTY_RANGE: outside the inspector range', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene(
        [
          '  - id: cam',
          '    type: Camera3D',
          '    properties:',
          '      fov: -5',
          '  - id: title',
          '    type: Label2D',
          '    properties:',
          '      label: Title',
          '      labelFontSize: 96',
        ].join('\n') + '\n'
      ),
    });
    expect(find(report, 'E_PROPERTY_RANGE')).toMatchObject([{ nodeId: 'cam' }]);
    expect(find(report, 'W_PROPERTY_RANGE')).toMatchObject([{ nodeId: 'title' }]);
  });

  it('E_PROPERTY_ENUM', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene(
        '  - id: r\n    type: ColorRect2D\n    properties:\n      layout:\n        enabled: true\n        horizontalAlign: Right\n'
      ),
    });
    expect(find(report, 'E_PROPERTY_ENUM')).toMatchObject([
      {
        path: 'root[0].properties.layout.horizontalAlign',
        fix: 'write layout.horizontalAlign: right',
      },
    ]);
  });

  it('E_EMOJI_AS_ART: only emoji-only text; an emoji in a sentence is fine', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene(
        '  - id: coin\n    type: Button2D\n    properties:\n      label: "🪙"\n  - id: score\n    type: Label2D\n    properties:\n      label: "Score: 10 🪙"\n'
      ),
    });
    expect(find(report, 'E_EMOJI_AS_ART')).toMatchObject([{ nodeId: 'coin' }]);
  });
});

describe('level 1: components', () => {
  it('E_UNKNOWN_COMPONENT: typo in core:, missing namespace', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene(
        '  - id: a\n    type: Node3D\n    components:\n      - type: core:Rotat\n      - type: Rotate\n'
      ),
    });
    expect(find(report, 'E_UNKNOWN_COMPONENT').map(d => d.fix)).toEqual([
      'type: core:Rotate',
      'type: core:Rotate',
    ]);
  });

  it('E_UNKNOWN_CONFIG_KEY: core: config against the registry schema', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene(
        '  - id: a\n    type: Node3D\n    components:\n      - type: core:Rotate\n        config: { rotationSpeed: 2, bogus: 1 }\n'
      ),
    });
    expect(find(report, 'E_UNKNOWN_CONFIG_KEY')).toMatchObject([
      { path: 'root[0].components[0].config.bogus' },
    ]);
  });

  it('E_USER_SCRIPT_NOT_FOUND: the id is the export name of an `extends Script` file', async () => {
    const report = await run(
      {
        'scripts/Spinner.ts': SCRIPT_SPINNER,
        'scenes/a.pix3scene': scene(
          '  - id: a\n    type: Node2D\n    components:\n      - type: user:Spinner\n      - type: user:Spiner\n'
        ),
      },
      { hydrate: false }
    );
    expect(find(report, 'E_USER_SCRIPT_NOT_FOUND')).toMatchObject([{ fix: 'type: user:Spinner' }]);
    expect(report.notes.join(' ')).toContain('(user: component properties not checked)');
  });

  it('scans export names the way the editor registers them', () => {
    const { names, hasStar } = scanExportNames(
      [
        'export class A extends Script {}',
        '// export class Commented extends Script {}',
        'class B extends Script {}',
        'export { B as Renamed, type T }',
        'export default class extends Script {}',
        'export * from "./base";',
      ].join('\n')
    );
    expect(names.sort()).toEqual(['A', 'Renamed', 'default']);
    expect(hasStar).toBe(true);
  });
});

describe('level 1: references and prefabs', () => {
  it('E_MISSING_RESOURCE: res:// anywhere, bare resource paths, case mismatch', async () => {
    const report = await run({
      'sprites/Coin.png': PNG,
      'scenes/a.pix3scene': scene(
        [
          '  - id: s',
          '    type: Sprite2D',
          '    properties:',
          '      texture: { type: texture, url: res://sprites/nope.png }',
          '  - id: t',
          '    type: Sprite2D',
          '    properties:',
          '      texture: res://sprites/coin.png',
          '    components:',
          '      - type: core:PlaySound',
          '        config: { audioTrack: res://audio/missing.ogg }',
        ].join('\n') + '\n'
      ),
    });
    const missing = find(report, 'E_MISSING_RESOURCE');
    expect(missing.map(d => d.path)).toEqual([
      'root[0].properties.texture.url',
      'root[1].properties.texture',
      'root[1].components[0].config.audioTrack',
    ]);
    expect(missing[1].fix).toBe('the file is res://sprites/Coin.png (case differs)');
  });

  it('E_MISSING_PREFAB', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene('  - id: i\n    instance: res://scenes/nope.pix3scene\n'),
    });
    expect(find(report, 'E_MISSING_PREFAB')).toMatchObject([{ nodeId: 'i' }]);
  });

  it('E_PREFAB_CYCLE', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene('  - id: x\n    instance: res://scenes/b.pix3scene\n'),
      'scenes/b.pix3scene': scene('  - id: y\n    instance: res://scenes/a.pix3scene\n'),
    });
    const cycles = find(report, 'E_PREFAB_CYCLE');
    expect(cycles.map(d => d.file)).toEqual(['scenes/a.pix3scene', 'scenes/b.pix3scene']);
    expect(cycles[0].message).toContain(
      'scenes/a.pix3scene -> scenes/b.pix3scene -> scenes/a.pix3scene'
    );
  });

  it('E_PREFAB_ROOT: an instanced prefab needs exactly one root', async () => {
    const report = await run({
      'scenes/two.pix3scene': scene('  - id: p\n    type: Node2D\n  - id: q\n    type: Node2D\n'),
      'scenes/a.pix3scene': scene('  - id: i\n    instance: res://scenes/two.pix3scene\n'),
    });
    expect(find(report, 'E_PREFAB_ROOT')).toMatchObject([{ file: 'scenes/a.pix3scene' }]);
  });

  it('E_UNKNOWN_OVERRIDE_TARGET, and instance/override property keys against the prefab schema', async () => {
    const report = await run({
      'scenes/prefab.pix3scene': scene(
        '  - id: root\n    type: Group2D\n    children:\n      - id: label\n        type: Label2D\n        properties: { label: A }\n'
      ),
      'scenes/a.pix3scene': scene(
        [
          '  - id: i',
          '    instance: res://scenes/prefab.pix3scene',
          '    properties:',
          '      transform: { position: [5, 5] }',
          '      bogus: 1',
          '    overrides:',
          '      byLocalId:',
          '        label:',
          '          properties: { label: B, labelColr: "#fff" }',
          '        nope:',
          '          properties: { label: C }',
        ].join('\n') + '\n'
      ),
    });
    expect(find(report, 'E_UNKNOWN_OVERRIDE_TARGET')).toMatchObject([
      { path: 'root[0].overrides.byLocalId.nope' },
    ]);
    expect(find(report, 'E_UNKNOWN_PROPERTY').map(d => d.path)).toEqual([
      'root[0].properties.bogus',
      'root[0].overrides.byLocalId.label.properties.labelColr',
    ]);
  });

  it('W_UNUSED_ASSET: whole-project runs only', async () => {
    const files = {
      'sprites/used.png': PNG,
      'sprites/by-script.png': PNG,
      'sprites/unused.png': PNG,
      'scripts/Loader.ts': "export const path = 'res://sprites/by-script.png';\n",
      'scenes/a.pix3scene': scene(
        '  - id: s\n    type: Sprite2D\n    properties:\n      texture: res://sprites/used.png\n'
      ),
    };
    const report = await run(files);
    expect(find(report, 'W_UNUSED_ASSET').map(d => d.file)).toEqual(['sprites/unused.png']);
    const subset = await run(files, { files: ['scenes/a.pix3scene'] });
    expect(codesOf(subset)).not.toContain('W_UNUSED_ASSET');
  });
});

describe('level 2: hydration with compiled user scripts', () => {
  it('E_LOAD: the loader rejects what level 1 lets through', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene('  - id: m\n    type: InstancedMesh3D\n'),
    });
    expect(find(report, 'E_LOAD')[0]?.message).toMatch(/maxInstances/);
    expect(report.level2).toMatchObject({ state: 'ran', filesHydrated: 1 });
  });

  it('E_UNKNOWN_CONFIG_KEY / E_PROPERTY_TYPE on user: config once the script is compiled', async () => {
    const report = await run({
      'scripts/Spinner.ts': SCRIPT_SPINNER,
      'scenes/a.pix3scene': scene(
        '  - id: a\n    type: Node2D\n    components:\n      - type: user:Spinner\n        config: { speed: fast, spped: 2 }\n'
      ),
    });
    expect(find(report, 'E_UNKNOWN_CONFIG_KEY')).toMatchObject([
      { path: 'root[0].components[0].config.spped', fix: 'did you mean speed?' },
    ]);
    expect(find(report, 'E_PROPERTY_TYPE')).toMatchObject([
      { path: 'root[0].components[0].config.speed' },
    ]);
    // The same project with --no-hydrate checks neither, and says so.
    const level1 = await run(
      {
        'scripts/Spinner.ts': SCRIPT_SPINNER,
        'scenes/a.pix3scene': scene(
          '  - id: a\n    type: Node2D\n    components:\n      - type: user:Spinner\n        config: { spped: 2 }\n'
        ),
      },
      { hydrate: false }
    );
    expect(level1.errorCount).toBe(0);
    expect(level1.level2).toEqual({ state: 'disabled' });
  });

  it('E_PENDING_COMPONENT: the export exists in text but is not a Script class', async () => {
    const report = await run({
      'scripts/Fake.ts':
        '// mentions extends Script only in this comment\nconst gate = "extends Script";\nexport class Fake {\n  static getPropertySchema() { return { nodeType: "Fake", properties: [] }; }\n}\nexport { gate };\n',
      'scenes/a.pix3scene': scene(
        '  - id: a\n    type: Node2D\n    components:\n      - type: user:Fake\n'
      ),
    });
    expect(codesOf(report)).not.toContain('E_USER_SCRIPT_NOT_FOUND');
    expect(find(report, 'E_PENDING_COMPONENT')).toMatchObject([{ nodeId: 'a' }]);
  });

  it('E_SCRIPT_COMPILE: a syntax error in the scripts', async () => {
    const report = await run({
      'scripts/Broken.ts':
        "import { Script } from '@pix3/runtime';\nexport class Broken extends Script { oops( }\n",
      'scenes/a.pix3scene': scene(
        '  - id: a\n    type: Node2D\n    components:\n      - type: user:Broken\n'
      ),
    });
    expect(find(report, 'E_SCRIPT_COMPILE')[0]).toMatchObject({
      file: 'scripts/Broken.ts',
      line: 2,
    });
    expect(report.notes.join(' ')).toContain('(user: component properties not checked)');
  });

  it('W_SCRIPT_IMPORT: scripts that throw at import (browser globals at top level)', async () => {
    const report = await run({
      'scripts/Throws.ts':
        "import { Script } from '@pix3/runtime';\nconst width = (globalThis as unknown as { window: { innerWidth: number } }).window.innerWidth;\nexport class Throws extends Script { w = width; }\n",
      'scenes/a.pix3scene': scene(
        '  - id: a\n    type: Node2D\n    components:\n      - type: user:Throws\n'
      ),
    });
    expect(find(report, 'W_SCRIPT_IMPORT')).toHaveLength(1);
    expect(report.errorCount).toBe(0);
  });

  it('W_HYDRATE_SKIPPED: no esbuild → level 2 skips scenes with user: components, says so', async () => {
    const report = await run(
      {
        'scripts/Spinner.ts': SCRIPT_SPINNER,
        'scenes/user.pix3scene': scene(
          '  - id: a\n    type: Node2D\n    components:\n      - type: user:Spinner\n'
        ),
        'scenes/core.pix3scene': scene('  - id: m\n    type: InstancedMesh3D\n'),
      },
      { esbuildSpecifier: 'pix3-esbuild-that-does-not-exist' }
    );
    expect(find(report, 'W_HYDRATE_SKIPPED')).toHaveLength(1);
    // Scenes without user: components are still hydrated.
    expect(find(report, 'E_LOAD').map(d => d.file)).toEqual(['scenes/core.pix3scene']);
    expect(report.level2).toMatchObject({ state: 'ran', filesHydrated: 1, filesSkipped: 1 });
  });

  it('W_RENDERABILITY_*: lit 3D content with no light and no camera', async () => {
    const report = await run({
      'scenes/a.pix3scene': scene('  - id: box\n    type: GeometryMesh\n'),
      // Instanced prefabs are not whole scenes: no renderability lint for them.
      'scenes/prefab.pix3scene': scene('  - id: box2\n    type: GeometryMesh\n'),
      'scenes/b.pix3scene': scene('  - id: i\n    instance: res://scenes/prefab.pix3scene\n'),
    });
    const codes = report.diagnostics.filter(d => d.code.startsWith('W_RENDERABILITY_'));
    covered.add('W_RENDERABILITY');
    expect(codes.filter(d => d.file === 'scenes/a.pix3scene').map(d => d.code)).toEqual(
      expect.arrayContaining(['W_RENDERABILITY_NO_CAMERA_3D'])
    );
    expect(codes.filter(d => d.file === 'scenes/prefab.pix3scene')).toEqual([]);
  });
});

describe('pix3 validate command', () => {
  const capture = () => {
    let stdout = '';
    let stderr = '';
    return {
      io: (cwd: string) => ({
        cwd,
        stdout: (text: string) => void (stdout += text),
        stderr: (text: string) => void (stderr += text),
      }),
      get stdout() {
        return stdout;
      },
      get stderr() {
        return stderr;
      },
    };
  };

  it('--json: diagnostics plus the sha256 of each validated file; exit 1 on error', async () => {
    const root = makeProject({
      'scenes/a.pix3scene': scene('  - id: a\n    type: Sprit2D\n'),
      'scenes/b.pix3scene': scene('  - id: b\n    type: Node2D\n'),
    });
    const out = capture();
    const code = await runValidate(['--json', 'scenes/a.pix3scene'], out.io(root));
    expect(code).toBe(1);
    const report = JSON.parse(out.stdout) as {
      ok: boolean;
      files: Array<{ file: string; sha256: string }>;
      diagnostics: Diagnostic[];
    };
    expect(report.ok).toBe(false);
    expect(report.files).toEqual([
      { file: 'scenes/a.pix3scene', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(report.diagnostics[0]).toMatchObject({
      severity: 'error',
      code: 'E_UNKNOWN_NODE_TYPE',
      file: 'scenes/a.pix3scene',
      nodeId: 'a',
      path: 'root[0].type',
      line: 4,
      fix: 'type: Sprite2D',
    });
  });

  it('human output, exit 0 with only warnings; finds the project from a subfolder', async () => {
    const root = makeProject({ 'scenes/a.pix3scene': scene('  - id: a\n    type: sprite2d\n') });
    const out = capture();
    expect(await runValidate([], out.io(join(root, 'scenes')))).toBe(0);
    expect(out.stdout).toContain('scenes/a.pix3scene:4  warning  W_TYPE_CASE [a]');
    expect(out.stdout).toMatch(/1 file\(s\) checked, 0 error\(s\), 1 warning\(s\)/);
  });

  it('exit 2 outside a project or on a bad argument', async () => {
    const out = capture();
    expect(await runValidate([], out.io(scratch))).toBe(2);
    expect(out.stderr).toContain('no pix3project.yaml');
    const root = makeProject({});
    expect(await runValidate(['--bogus'], capture().io(root))).toBe(2);
    expect(await runValidate(['pix3project.yaml'], capture().io(root))).toBe(2);
  });
});

describe('fixture coverage', () => {
  it('covers every diagnostic code', () => {
    expect(Object.keys(DIAGNOSTIC_CODES).filter(code => !covered.has(code))).toEqual([]);
  });
});
