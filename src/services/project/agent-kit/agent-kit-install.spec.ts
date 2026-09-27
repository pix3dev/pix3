// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { installKit } from '../../../../packages/pix3-cli/src/kit/install.ts';
import { ensureKit, type KitSource } from '../../../../packages/pix3-cli/src/kit/kit-source.ts';
import { CLI_VERSION } from '../../../../packages/pix3-cli/src/version.ts';
import * as cliInstall from '../../../../packages/pix3-cli/src/kit/install.ts';
import * as cliTypes from '../../../../packages/pix3-cli/src/types/project-types.ts';
import * as cliMcp from '../../../../packages/pix3-cli/src/mcp-config.ts';
import type { RuntimeTypesManifest } from '../../../../packages/pix3-cli/src/types/runtime-types.ts';
import {
  AGENTS_ALT_FILE,
  AGENTS_FILE,
  AGENTS_LINK_LINE,
  CLAUDE_FILE,
  KIT_PROJECT_MANIFEST,
  MCP_CONFIG_FILE,
  PRECEDENCE_SENTENCE,
  ROOT_TSCONFIG,
  ROOT_TSCONFIG_CONTENT,
  installAgentKit,
  renderMcpConfig,
  withAltAgentsHeader,
  type AgentKitFileSystem,
  type BundledAgentKit,
} from './agent-kit-install';
import { loadBundledAgentKit } from './bundled-kit';

/**
 * The editor's kit install is a port of the CLI's (`packages/pix3-cli/src/kit/install.ts`, which
 * needs Node). This spec runs both on identical projects and demands the same bytes on disk, the
 * same outcome per file and the same `metadata.agentKit` — so "every kit file the CLI would write,
 * the editor writes too" holds by construction, and a rule changed on one side fails here.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-editor-kit-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const freshDir = (label: string): string => {
  const dir = join(scratch, `${label}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A stand-in for the shipped runtime declarations (the editor never writes `.pix3/types/`). */
const fakeTypesDir = freshDir('types');
for (const scope of ['@pix3', '@types']) {
  mkdirSync(join(fakeTypesDir, scope), { recursive: true });
  writeFileSync(join(fakeTypesDir, scope, 'index.d.ts'), 'export {};\n');
}
const fakeTypes: { dir: string; manifest: RuntimeTypesManifest } = {
  dir: fakeTypesDir,
  manifest: {
    format: 1,
    cliVersion: CLI_VERSION,
    runtimeVersion: CLI_VERSION,
    threeTypesVersion: '0.0.0',
    sourceStamp: 'spec',
    builtAt: '2026-01-01T00:00:00.000Z',
  },
};

const nodeFs = (root: string): AgentKitFileSystem => ({
  read: async path => {
    const full = join(root, path);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
  },
  write: async (path, contents) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  },
});

const walk = (root: string, dir = root): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, full));
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out.sort();
};

/** Everything but what only the CLI writes (the types) and the manifest (compared parsed). */
const tree = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const path of walk(root)) {
    if (path.startsWith('.pix3/types/') || path === '.pix3/tsconfig.check.json') continue;
    if (path === 'pix3project.yaml') continue;
    out[path] = readFileSync(join(root, path), 'utf8');
  }
  return out;
};

const MANIFEST = 'version: 1\nmetadata:\n  projectName: Spec\n';

const setupProject = (root: string, extra: Record<string, string> = {}): void => {
  writeFileSync(join(root, 'pix3project.yaml'), MANIFEST);
  for (const [path, contents] of Object.entries(extra)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
};

const cliKit: KitSource = await ensureKit();
const editorKit = loadBundledAgentKit();

/** A copy of the kit with one file changed and another version — "the next release". */
const newerKits = (): { cli: KitSource; editor: BundledAgentKit } => {
  const dir = freshDir('newer-kit');
  cpSync(cliKit.dir, dir, { recursive: true });
  const target = cliKit.manifest.files.find(file => file.includes('pix3-verify/SKILL.md'))!;
  const filesDir = join(dir, 'files');
  const changed = `${readFileSync(join(filesDir, target), 'utf8')}\nNewer kit line.\n`;
  writeFileSync(join(filesDir, target), changed);
  const manifest = { ...cliKit.manifest, version: '99.0.0' };
  writeFileSync(join(dir, 'kit.json'), JSON.stringify(manifest));
  const files = new Map(editorKit.files);
  files.set(target, changed);
  return { cli: { dir, filesDir, manifest }, editor: { version: '99.0.0', files } };
};

interface Run {
  readonly update?: boolean;
  readonly cli?: KitSource;
  readonly editor?: BundledAgentKit;
}

/** Run CLI and editor on two copies of the same project; returns both roots. */
const runBoth = async (
  label: string,
  setup: (root: string) => void,
  runs: readonly Run[],
  between?: (root: string, index: number) => void
) => {
  const cliRoot = freshDir(`${label}-cli`);
  const editorRoot = freshDir(`${label}-editor`);
  setup(cliRoot);
  setup(editorRoot);
  let last: {
    cli: ReturnType<typeof installKit>;
    editor: Awaited<ReturnType<typeof installAgentKit>>;
  } | null = null;
  for (const [index, run] of runs.entries()) {
    if (between && index > 0) {
      between(cliRoot, index);
      between(editorRoot, index);
    }
    const cli = installKit(cliRoot, run.cli ?? cliKit, {
      update: run.update,
      runtimeTypes: fakeTypes,
      devMcp: false,
    });
    const editor = await installAgentKit(nodeFs(editorRoot), run.editor ?? editorKit, {
      update: run.update,
      mcpCliVersion: CLI_VERSION,
    });
    last = { cli, editor };
  }
  const result = last!;
  expect(tree(editorRoot)).toEqual(tree(cliRoot));
  expect(result.editor.files).toEqual(result.cli.files);
  expect(result.editor.instructions).toEqual(result.cli.instructions);
  expect(result.editor.notes).toEqual(result.cli.notes);
  expect(result.editor.version).toEqual(result.cli.version);
  const cliMeta = (
    parse(readFileSync(join(cliRoot, 'pix3project.yaml'), 'utf8')) as {
      metadata: { agentKit: unknown };
    }
  ).metadata.agentKit;
  expect(result.editor.agentKitMetadata).toEqual(cliMeta);
  return { cliRoot, editorRoot, ...result };
};

describe('editor agent kit install = pix3 kit', () => {
  it('shares the CLI constants and renderers', () => {
    expect(PRECEDENCE_SENTENCE).toBe(cliInstall.PRECEDENCE_SENTENCE);
    expect(AGENTS_LINK_LINE).toBe(cliInstall.AGENTS_LINK_LINE);
    expect(KIT_PROJECT_MANIFEST).toBe(cliInstall.KIT_PROJECT_MANIFEST);
    expect([AGENTS_FILE, AGENTS_ALT_FILE, CLAUDE_FILE]).toEqual([
      cliInstall.AGENTS_FILE,
      cliInstall.AGENTS_ALT_FILE,
      cliInstall.CLAUDE_FILE,
    ]);
    expect(MCP_CONFIG_FILE).toBe(cliMcp.MCP_CONFIG_FILE);
    expect([ROOT_TSCONFIG, ROOT_TSCONFIG_CONTENT]).toEqual([
      cliTypes.ROOT_TSCONFIG,
      cliTypes.ROOT_TSCONFIG_CONTENT,
    ]);
    const sample = '<!-- v -->\n# Title\nbody\n';
    expect(withAltAgentsHeader(sample)).toBe(cliInstall.withAltAgentsHeader(sample));
    const existing = '{"mcpServers":{"other":{"command":"x"}},"extra":1}';
    expect(renderMcpConfig(CLI_VERSION, existing)).toBe(
      cliMcp.renderMcpConfig(cliMcp.mcpLaunch({ dev: false }), existing)
    );
  });

  it('bundles exactly the kit the CLI installs from', () => {
    expect(editorKit.version).toBe(cliKit.manifest.version);
    expect([...editorKit.files.keys()]).toEqual(cliKit.manifest.files);
    for (const file of cliKit.manifest.files) {
      expect(editorKit.files.get(file), file).toBe(
        readFileSync(join(cliKit.filesDir, file), 'utf8')
      );
    }
  });

  it('a fresh project (the editor overlay .gitignore present) gets every kit file', async () => {
    const { editor } = await runBoth(
      'fresh',
      root => setupProject(root, { '.gitignore': 'node_modules/\n' }),
      [{}]
    );
    const written = editor.files.filter(f => f.action === 'written').map(f => f.path);
    for (const file of cliKit.manifest.files) expect(written).toContain(file);
    expect(written).toContain(MCP_CONFIG_FILE);
    expect(written).toContain(ROOT_TSCONFIG);
  });

  it("a project's own AGENTS.md / CLAUDE.md / tsconfig / .mcp.json are kept", async () => {
    await runBoth(
      'own',
      root =>
        setupProject(root, {
          'AGENTS.md': '# Our rules\n',
          'CLAUDE.md': '# Ours\n',
          'tsconfig.json': '{ "compilerOptions": {} }\n',
          '.mcp.json': '{"mcpServers":{"other":{"command":"x"}}}\n',
        }),
      [{}]
    );
  });

  it('a re-run is idempotent, and --update replaces only unedited kit files', async () => {
    const newer = newerKits();
    const { editor } = await runBoth(
      'update',
      root => setupProject(root),
      [{}, { update: true, cli: newer.cli, editor: newer.editor }],
      root => {
        // The user edits one skill file between the runs.
        const edited = cliKit.manifest.files.find(file => file.includes('pix3-nodes/SKILL.md'))!;
        writeFileSync(join(root, edited), 'my notes\n');
      }
    );
    expect(editor.files.some(f => f.action === 'updated')).toBe(true);
    expect(editor.files.some(f => f.action === 'skipped-edited')).toBe(true);
  });

  it('without --update a newer kit leaves files outdated and keeps the old version', async () => {
    const newer = newerKits();
    const { editor } = await runBoth('outdated', root => setupProject(root), [
      {},
      { cli: newer.cli, editor: newer.editor },
    ]);
    expect(editor.files.some(f => f.action === 'outdated')).toBe(true);
    expect(editor.version).toBe(cliKit.manifest.version);
  });

  it('leaves .mcp.json out when no published CLI version could be confirmed', async () => {
    const root = freshDir('no-mcp');
    setupProject(root);
    const report = await installAgentKit(nodeFs(root), editorKit, { mcpCliVersion: null });
    expect(existsSync(join(root, MCP_CONFIG_FILE))).toBe(false);
    expect(report.mcpCliVersion).toBeNull();
    expect(report.agentKitMetadata.files).not.toContain(MCP_CONFIG_FILE);
    for (const file of cliKit.manifest.files) expect(existsSync(join(root, file))).toBe(true);
  });
});
