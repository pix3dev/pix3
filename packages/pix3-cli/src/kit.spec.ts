// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import * as runtime from '@pix3/runtime';
import {
  getSceneNodeDiskFormat,
  KNOWN_SCENE_NODE_TYPES,
  resolveSceneDiskKey,
  resolveSceneNodeType,
  type SceneDiskKeyRule,
} from '@pix3/runtime';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CHECK_CODES, checkProject } from './check/check.ts';
import { extractCoreComponents, type RuntimeLike } from './kit/core-components.ts';
import { generateKit, type CoreComponentInfo, type KitManifestFile } from './kit/generate.ts';
import {
  AGENTS_ALT_FILE,
  agentKitStep,
  installKit,
  KIT_PROJECT_MANIFEST,
  PRECEDENCE_SENTENCE,
  readProjectKitManifest,
  withAltAgentsHeader,
} from './kit/install.ts';
import {
  kitMcpErrorCodes,
  kitMcpTools,
  kitSrcDir,
  repoRootOfCheckout,
  type KitSource,
} from './kit/kit-source.ts';
import { createProject } from './new-project.ts';
import { listTemplates } from './templates.ts';
import { ensureRuntimeTypes } from './types/runtime-types.ts';
import { SMOKE_CODES } from './smoke/report.ts';
import { USAGE } from './usage.ts';
import { DIAGNOSTIC_CODES } from './validate/diagnostics.ts';
import { schemaForType } from './validate/level1.ts';
import { validateProject } from './validate/validate.ts';
import { CLI_VERSION } from './version.ts';
import { WORKSPACE_TOOL_NAMES } from './workspace-agent/tools.ts';

/**
 * The agent kit: generated from sources, and held to the code it describes (plan §5 B — "spec-тест
 * ловит дрейф. Иначе через месяц kit врёт").
 *
 * Drift checks run over a kit built into a temp folder from `kit-src/` + the repo sources, with the
 * `core:` table read from the runtime's registry exactly as `scripts/build-kit.mjs` does:
 * - every directive resolved;
 * - every `pix3 <command> [--flag]` the kit shows exists in the CLI's USAGE (with that flag);
 * - every tool name in the live-channel section is one of the 14, and all 14 are there;
 * - no editor-only tool (`AgentToolRegistry`) is named in AGENTS.md / the verify and scripts skills;
 * - `pix3 check --json` `files` entries are documented with the CLI's key (`{ file, sha256 }`);
 * - every diagnostic code named is one `pix3 validate` / `pix3 check` emits;
 * - every node type named in the nodes skill is a type the loader knows;
 * - every property in the nodes skill's tables is a key the loader reads (the disk-format
 *   descriptor, `scene-disk-format.ts`) for that node type;
 * - every `core:` component named exists.
 * Then `pix3 kit` behaviour: fresh project, an AGENTS.md of the project's own, `--update` vs user
 * edits, and a smoke run on a copy of DeepCore (skipped when that checkout is absent).
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-kit-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const coreComponents: CoreComponentInfo[] = extractCoreComponents(
  runtime as unknown as RuntimeLike
);

const buildKit = (outDir: string, kitSrc = kitSrcDir()): KitSource => {
  const manifest: KitManifestFile = generateKit({
    repoRoot: repoRootOfCheckout(),
    kitSrcDir: kitSrc,
    outDir,
    version: CLI_VERSION,
    coreComponents,
    mcpTools: kitMcpTools(),
    mcpErrorCodes: kitMcpErrorCodes(),
  });
  return { dir: outDir, filesDir: join(outDir, 'files'), manifest };
};

let kit: KitSource;
const texts = new Map<string, string>();

beforeAll(() => {
  kit = buildKit(join(scratch, 'kit'));
  for (const file of kit.manifest.files) {
    texts.set(file, readFileSync(join(kit.filesDir, file), 'utf8'));
  }
  // Rebuilds the shipped runtime types when the runtime sources changed since the last build.
  ensureRuntimeTypes();
}, 120_000);

const text = (file: string): string => {
  const value = texts.get(file);
  if (value === undefined) throw new Error(`kit has no ${file}`);
  // A Windows checkout (core.autocrlf) hands the kit sources over with CRLF.
  return value.replace(/\r\n/g, '\n');
};

/** Text outside fenced code blocks, and the fenced lines, separately. */
const splitFences = (source: string): { prose: string; code: string[] } => {
  const prose: string[] = [];
  const code: string[] = [];
  let fenced = false;
  for (const line of source.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    (fenced ? code : prose).push(line);
  }
  return { prose: prose.join('\n'), code };
};

const backticked = (source: string): string[] =>
  [...splitFences(source).prose.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);

/** The text of the `## <prefix>…` section of a Markdown file, up to the next `## `. */
const h2Section = (source: string, prefix: string): string => {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.startsWith(`## ${prefix}`));
  if (start < 0) throw new Error(`no "## ${prefix}" section`);
  let end = start + 1;
  let fenced = false;
  for (; end < lines.length; end++) {
    if (/^\s*(```|~~~)/.test(lines[end])) fenced = !fenced;
    if (!fenced && /^## /.test(lines[end])) break;
  }
  return lines.slice(start, end).join('\n');
};

describe('kit drift', () => {
  it('ships the files the plan lists, with every directive resolved', () => {
    expect(kit.manifest.files).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'CLAUDE.md',
        '.claude/skills/pix3-scene-format/SKILL.md',
        '.claude/skills/pix3-nodes/SKILL.md',
        '.claude/skills/pix3-nodes/reference.md',
        '.claude/skills/pix3-scripts/SKILL.md',
        '.claude/skills/pix3-scripts/reference.md',
        '.claude/skills/pix3-verify/SKILL.md',
      ])
    );
    expect(text('CLAUDE.md')).toBe('@AGENTS.md\n');
    for (const [file, content] of texts) {
      expect(content, file).not.toMatch(/\{\{/);
      if (file !== 'CLAUDE.md') expect(content, file).toContain(CLI_VERSION);
    }
    for (const file of kit.manifest.files.filter(f => f.endsWith('/SKILL.md'))) {
      const front = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(text(file));
      expect(front?.[1], `${file} front matter`).toBe(file.split('/')[2]);
    }
    expect(kit.manifest.sources).toEqual(
      expect.arrayContaining([
        'docs/pix3-specification.md',
        'docs/node-types-reference.md',
        'docs/nodes-and-systems.md',
        'src/services/agent/agent-skills/engine-api-map.md',
        'packages/pix3-cli/README.md',
      ])
    );
  });

  it('names only CLI commands and flags that exist', () => {
    const usageBlock = (command: string): string => {
      const lines = USAGE.split('\n');
      const out: string[] = [];
      let inside = false;
      for (const line of lines) {
        if (/^ {2}pix3 /.test(line)) inside = line.startsWith(`  pix3 ${command}`);
        if (inside) out.push(line);
      }
      return out.join('\n');
    };
    const invocations: string[] = [];
    for (const [, content] of texts) {
      for (const span of backticked(content)) {
        const pinned = /@pix3\/cli@\S+\s+(\S.*)$/.exec(span);
        if (span.startsWith('pix3 ')) invocations.push(span);
        else if (pinned) invocations.push(`pix3 ${pinned[1]}`);
      }
      for (const line of splitFences(content).code) {
        const trimmed = line.trim();
        if (trimmed.startsWith('pix3 ')) invocations.push(trimmed.replace(/\s+#.*$/, ''));
      }
    }
    expect(invocations.length).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const invocation of invocations) {
      const [, command, ...rest] = invocation.split(/\s+/);
      if (command.startsWith('-')) {
        if (!USAGE.includes(`pix3 ${command}`)) problems.push(invocation);
        continue;
      }
      const block = usageBlock(command);
      if (!block) {
        problems.push(`${invocation}: no command "${command}"`);
        continue;
      }
      for (const flag of rest.filter(word => word.startsWith('--'))) {
        const name = flag.replace(/[=].*$/, '').replace(/[^\w-]+$/, '');
        if (name === '--help') continue; // every command takes it
        if (!block.includes(name)) problems.push(`${invocation}: ${command} has no ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the live-channel section names exactly the 14 tools and the documented error codes', () => {
    const section = h2Section(text('.claude/skills/pix3-verify/SKILL.md'), '3. Live channel');
    const snake = new Set(
      backticked(section).flatMap(span => span.match(/^[a-z]+(?:_[a-z0-9]+)+$/) ?? [])
    );
    // Named in the included CLI contract, not tools: the editor-internal calls the barrier makes,
    // and errors the editor itself returns (passed through as written).
    const notTools = new Set(['sync_barrier', 'sync_release', 'unknown_tool', 'agent_disabled']);
    const allowed = new Set([...WORKSPACE_TOOL_NAMES, ...kitMcpErrorCodes(), ...notTools]);
    expect([...snake].filter(token => !allowed.has(token))).toEqual([]);
    expect(WORKSPACE_TOOL_NAMES.filter(tool => !snake.has(tool))).toEqual([]);
    expect(kitMcpErrorCodes().filter(code => !snake.has(code))).toEqual([]);
    expect(WORKSPACE_TOOL_NAMES).toHaveLength(14);
  });

  it('names no editor-only tool as if the live channel had it', () => {
    // The in-editor agent has ~100 tools (`AgentToolRegistry`); the workspace channel exposes 14.
    // A kit that tells an external agent to call `game_trace` / `game_controls` / `node_inspect`
    // sends it after a tool it does not have. (The scene-format skill's recipe table and the
    // included spec name in-editor tools on purpose: they translate them into file edits.)
    const registry = readFileSync(
      join(repoRootOfCheckout(), 'src/services/agent/AgentToolRegistry.ts'),
      'utf8'
    );
    const editorTools = new Set(
      [...registry.matchAll(/^\s+name: '([a-z]+(?:_[a-z0-9]+)+)',$/gm)].map(m => m[1])
    );
    expect(editorTools.size).toBeGreaterThan(WORKSPACE_TOOL_NAMES.length);
    const files = [
      'AGENTS.md',
      '.claude/skills/pix3-verify/SKILL.md',
      '.claude/skills/pix3-scripts/SKILL.md',
    ];
    const problems: string[] = [];
    for (const file of files) {
      for (const match of text(file).matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g)) {
        const name = match[1];
        if (editorTools.has(name) && !WORKSPACE_TOOL_NAMES.includes(name)) {
          problems.push(`${file}: ${name}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("documents `pix3 check --json` files entries with the CLI's own key", () => {
    // `CheckReport.files` is `{ file, sha256 }[]`; round 2 of the trial found the kit saying
    // `{ path, sha256 }`. The runtime shape is asserted in the type-check test below.
    // Only the kit's own prose: the included spec documents other `{ path, sha256 }` shapes
    // (`.pix3/ack.json`) that are right as written.
    const problems: string[] = [];
    for (const file of ['AGENTS.md', '.claude/skills/pix3-verify/SKILL.md']) {
      const content = text(file);
      for (const match of content.matchAll(/\{\s*"?(\w+)"?\s*(?::[^,}]*)?,\s*"?sha256"?\b/g)) {
        if (match[1] !== 'file') problems.push(`${file}: ${match[0]}`);
      }
      if (/path \+ sha256/.test(content)) problems.push(`${file}: "path + sha256"`);
    }
    expect(problems).toEqual([]);
  });

  it('names only diagnostic codes that validate / check emit', () => {
    const known = [
      ...Object.keys(DIAGNOSTIC_CODES),
      ...Object.keys(CHECK_CODES),
      ...Object.keys(SMOKE_CODES),
    ];
    const problems: string[] = [];
    for (const [file, content] of texts) {
      for (const match of content.matchAll(/\b([EW]_[A-Z0-9_]+\*?)/g)) {
        const code = match[1];
        const ok = code.endsWith('*')
          ? known.some(k => k.startsWith(code.slice(0, -1)))
          : known.includes(code);
        if (!ok) problems.push(`${file}: ${code}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('names only core: components that exist', () => {
    const ids = new Set(coreComponents.map(c => c.id));
    const problems: string[] = [];
    for (const [file, content] of texts) {
      for (const match of content.matchAll(/\bcore:([A-Z][A-Za-z0-9]+)/g)) {
        if (!ids.has(`core:${match[1]}`)) problems.push(`${file}: core:${match[1]}`);
      }
    }
    expect(problems).toEqual([]);
    expect(coreComponents.length).toBeGreaterThan(20);
    expect(text('.claude/skills/pix3-scripts/reference.md')).toContain('### `core:PopIn`');
  });

  const NODES_FILES = [
    '.claude/skills/pix3-nodes/SKILL.md',
    '.claude/skills/pix3-nodes/reference.md',
  ];

  it('names only node types the loader knows', () => {
    // Words shaped like a node type (`…2D`, `…3D`, `…Node`, `…Light`, `…Mesh`, `…Player`) that
    // the nodes skill uses for something else: base classes and engine classes.
    const notNodeTypes = new Set(['UIControl2D', 'AnimationPlayer', 'InstancedMesh']);
    const nodeShaped = /^[A-Z][A-Za-z0-9]*(?:2D|3D|Node|Light|Mesh|Player|Instance)$/;
    const problems: string[] = [];
    for (const file of NODES_FILES) {
      for (const span of backticked(text(file))) {
        if (!nodeShaped.test(span) || notNodeTypes.has(span)) continue;
        if (resolveSceneNodeType(span) === null) problems.push(`${file}: ${span}`);
      }
      for (const match of text(file).matchAll(/^#{2,4} ([A-Z][A-Za-z0-9]*(?:2D|3D|Node))\b/gm)) {
        if (!KNOWN_SCENE_NODE_TYPES.includes(match[1]))
          problems.push(`${file}: heading ${match[1]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every property in the nodes skill tables is a key the loader reads', () => {
    const expand = (token: string): string[] => {
      const [first, ...rest] = token.split('/');
      const out = [first];
      for (const part of rest) {
        if (first.includes('.')) out.push(`${first.slice(0, first.lastIndexOf('.') + 1)}${part}`);
        else {
          const tail = /[A-Z][a-z0-9]*$/.exec(first);
          out.push(tail ? `${first.slice(0, tail.index)}${part}` : part);
        }
      }
      return out;
    };
    const names = (cell: string, backtickedOnly: boolean): string[] => {
      const spans = [...cell.matchAll(/`([^`]+)`/g)].map(m => m[1]);
      const raw = spans.length > 0 ? spans : backtickedOnly ? [] : cell.split(',');
      return raw
        .map(part =>
          part
            .replace(/\\/g, '')
            .replace(/\(.*?\)/g, '')
            .trim()
        )
        .filter(part => /^[A-Za-z][A-Za-z0-9.]*(?:\/[A-Za-z0-9]+)*\*?$/.test(part))
        .flatMap(expand);
    };
    const accepted = (type: string, name: string, row: string): string | null => {
      const format = getSceneNodeDiskFormat(type);
      if (!format) return `${type} has no disk format`;
      const schema = schemaForType(format);
      if (name.endsWith('*')) {
        const prefix = name.slice(0, -1);
        return schema.some(p => p.name.startsWith(prefix)) ||
          Object.keys(format.extras).some(k => k.startsWith(prefix))
          ? null
          : `nothing starts with ${prefix}`;
      }
      if (name.includes('.')) {
        const [block, key] = name.split('.');
        const rule: SceneDiskKeyRule | undefined = format.extras[block];
        return rule?.nested?.[key] ? null : `${block}.${key} is not read`;
      }
      const resolution = resolveSceneDiskKey(format, schema, name);
      // A schema property the file never stores may be listed if the row says so.
      if (resolution.kind === 'not-stored' && /not saved/i.test(row)) return null;
      return resolution.kind === 'schema' ||
        resolution.kind === 'extra' ||
        resolution.kind === 'write-only'
        ? null
        : `${name}: ${resolution.kind}${'diskPath' in resolution ? ` (belongs at ${resolution.diskPath})` : ''}`;
    };
    const problems: string[] = [];
    let checked = 0;
    for (const file of NODES_FILES) {
      let type: string | null = null;
      let quickReference = false;
      let tableHeader: string | null = null;
      let fenced = false;
      for (const line of text(file).split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        if (fenced) continue;
        const heading = /^#{2,4} (.+)$/.exec(line);
        if (heading) {
          const word = /^`?([A-Za-z0-9]+)/.exec(heading[1])?.[1] ?? '';
          type = resolveSceneNodeType(word);
          quickReference = /quick reference/i.test(heading[1]);
          continue;
        }
        if (!line.startsWith('|')) {
          tableHeader = null;
          continue;
        }
        if (/^\|\s*-/.test(line)) continue;
        const cells = line
          .split(/(?<!\\)\|/)
          .slice(1, -1)
          .map(c => c.trim());
        if (tableHeader === null) {
          // Only property tables: `| Key |` / `| Property |` (per type), `| Node Type |` (summary).
          tableHeader = cells[0].replace(/`/g, '').toLowerCase();
          continue;
        }
        if (!['key', 'property', 'node type'].includes(tableHeader)) continue;
        if (quickReference) {
          const rowType = resolveSceneNodeType(cells[0]);
          if (!rowType) continue; // NodeBase: not a scene type
          for (const name of names(cells[1] ?? '', false)) {
            checked += 1;
            const problem = accepted(rowType, name, line);
            if (problem) problems.push(`${file} quick reference ${rowType}: ${problem}`);
          }
          continue;
        }
        if (!type) continue;
        for (const name of names(cells[0], true)) {
          checked += 1;
          const problem = accepted(type, name, line);
          if (problem) problems.push(`${file} ${type}: ${problem}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect(problems).toEqual([]);
  });
});

// --- pix3 kit behaviour ------------------------------------------------------------------------

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

let counter = 0;
const freshRecipe = (withKit: boolean): string => {
  const template = listTemplates().find(t => t.id === 'recipe-tapper-2d');
  if (!template) throw new Error('recipe-tapper-2d missing');
  const dir = join(scratch, `p${++counter}`);
  createProject({
    template,
    dir,
    postCreateSteps: withKit ? [agentKitStep(kit, ensureRuntimeTypes(), { devMcp: false })] : [],
  });
  return dir;
};

describe('pix3 kit', () => {
  it('installs everything into a fresh project', () => {
    const root = freshRecipe(true);
    for (const file of kit.manifest.files) {
      expect(readFileSync(join(root, file), 'utf8')).toBe(text(file));
    }
    expect(readFileSync(join(root, 'tsconfig.json'), 'utf8')).toBe(
      '{ "extends": "./.pix3/tsconfig.check.json" }\n'
    );
    expect(existsSync(join(root, '.pix3/types/@pix3/runtime/index.d.ts'))).toBe(true);
    expect(existsSync(join(root, '.pix3/types/@types/three/index.d.ts'))).toBe(true);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^\.pix3\/$/m);
    expect(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        pix3: { command: 'npx', args: ['-y', `@pix3/cli@${CLI_VERSION}`, 'mcp', '--workspace'] },
      },
    });
    const manifest = parse(readFileSync(join(root, 'pix3project.yaml'), 'utf8')) as {
      metadata: { agentKit: { version: string; files: string[] }; templateId: string };
    };
    expect(manifest.metadata.templateId).toBe('recipe-tapper-2d');
    expect(manifest.metadata.agentKit.version).toBe(CLI_VERSION);
    expect(manifest.metadata.agentKit.files).toEqual(
      expect.arrayContaining(['AGENTS.md', 'CLAUDE.md', '.mcp.json', 'tsconfig.json'])
    );
    const owned = readProjectKitManifest(root);
    expect(owned?.files['AGENTS.md']).toBe(sha256(join(root, 'AGENTS.md')));
  });

  it("keeps a project's own AGENTS.md and CLAUDE.md, and says what to link", () => {
    const root = freshRecipe(false);
    writeFileSync(join(root, 'AGENTS.md'), '# Our rules\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# Claude notes\n');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    const report = installKit(root, kit, { runtimeTypes: ensureRuntimeTypes(), devMcp: false });
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# Our rules\n');
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Claude notes\n');
    const alt = readFileSync(join(root, AGENTS_ALT_FILE), 'utf8');
    expect(alt).toBe(withAltAgentsHeader(text('AGENTS.md')));
    // The TODO survives in the file itself, not only in the one-time report.
    expect(alt.split('\n')[0]).toBe(text('AGENTS.md').split('\n')[0]);
    expect(alt).toContain(PRECEDENCE_SENTENCE);
    expect(alt).toContain('See AGENTS.pix3.md for the Pix3 engine rules.');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(
      /^node_modules\/\n[\s\S]*^\.pix3\/$/m
    );
    expect(report.instructions.join('\n')).toContain('AGENTS.pix3.md');
    expect(report.instructions.join('\n')).toContain('@AGENTS.pix3.md');
    expect(report.instructions.join('\n')).toContain(PRECEDENCE_SENTENCE);

    // Repeated on every run until the project's AGENTS.md links ours, then quiet.
    const again = installKit(root, kit, { runtimeTypes: ensureRuntimeTypes(), devMcp: false });
    expect(again.instructions.join('\n')).toContain(PRECEDENCE_SENTENCE);
    expect(again.files.find(f => f.path === AGENTS_ALT_FILE)?.action).toBe('unchanged');
    writeFileSync(
      join(root, 'AGENTS.md'),
      '# Our rules\n\nSee AGENTS.pix3.md for the Pix3 engine rules.\n'
    );
    const linked = installKit(root, kit, { runtimeTypes: ensureRuntimeTypes(), devMcp: false });
    expect(linked.instructions.join('\n')).not.toContain(PRECEDENCE_SENTENCE);
    writeFileSync(join(root, 'AGENTS.md'), '# Our rules\n');

    // Without a CLAUDE.md of its own, ours imports both.
    rmSync(join(root, 'CLAUDE.md'));
    installKit(root, kit, { runtimeTypes: ensureRuntimeTypes(), devMcp: false });
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n@AGENTS.pix3.md\n');
  });

  it('--update replaces kit files the user did not touch and skips the ones they edited', () => {
    const root = freshRecipe(true);
    const edited = '.claude/skills/pix3-nodes/SKILL.md';
    writeFileSync(join(root, edited), `${text(edited)}\nOur own note.\n`);

    // A newer kit: every template gains a line.
    const src = join(scratch, `kit-src-${++counter}`);
    cpSync(kitSrcDir(), src, { recursive: true });
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
      );
    for (const file of walk(src)) writeFileSync(file, `${readFileSync(file, 'utf8')}\nNEW LINE\n`);
    const newer = buildKit(join(scratch, `kit-${counter}`), src);

    const plain = installKit(root, newer, { runtimeTypes: ensureRuntimeTypes(), devMcp: false });
    expect(plain.files.find(f => f.path === 'AGENTS.md')?.action).toBe('outdated');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(text('AGENTS.md'));

    const update = installKit(root, newer, {
      update: true,
      runtimeTypes: ensureRuntimeTypes(),
      devMcp: false,
    });
    const action = (path: string) => update.files.find(f => f.path === path)?.action;
    expect(action('AGENTS.md')).toBe('updated');
    expect(action('.claude/skills/pix3-verify/SKILL.md')).toBe('updated');
    expect(action(edited)).toBe('skipped-edited');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('NEW LINE');
    expect(readFileSync(join(root, edited), 'utf8')).toContain('Our own note.');
    expect(readFileSync(join(root, edited), 'utf8')).not.toContain('NEW LINE');
    // The edited file keeps its old ownership hash, so it stays "edited" on the next update too.
    const owned = readProjectKitManifest(root);
    expect(owned?.files[edited]).not.toBe(sha256(join(root, edited)));
    expect(existsSync(join(root, KIT_PROJECT_MANIFEST))).toBe(true);
  });

  it('the TypeScript examples in the kit type-check against the shipped runtime types', async () => {
    const root = freshRecipe(true);
    const blocks: { file: string; code: string }[] = [];
    for (const file of ['AGENTS.md', '.claude/skills/pix3-scripts/SKILL.md']) {
      for (const match of text(file).matchAll(/^```ts\n([\s\S]*?)^```/gm)) {
        if (/^import /m.test(match[1])) blocks.push({ file, code: match[1] });
      }
    }
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    blocks.forEach((block, index) => {
      // Each example is a module of its own; rename its class so two examples do not collide.
      const name = /export class (\w+)/.exec(block.code)?.[1] ?? 'Example';
      const code = block.code.replace(new RegExp(`\\b${name}\\b`, 'g'), `${name}Example${index}`);
      writeFileSync(join(root, 'scripts', `KitExample${index}.ts`), code);
    });
    const report = await checkProject(root, {
      hydrate: false,
      offline: false,
      validate: options => validateProject(options),
    });
    expect(report.diagnostics.filter(d => d.code === 'E_TYPE')).toEqual([]);
    expect(report.typecheck.files).toBeGreaterThan(blocks.length);
    // The `files` entry shape the verify skill documents (`{ file, sha256 }`).
    expect(report.files.length).toBeGreaterThan(0);
    expect(Object.keys(report.files[0]).sort()).toEqual(['file', 'sha256']);
  }, 60_000);

  const deepCore = join(repoRootOfCheckout(), '..', 'DeepCore');
  it.skipIf(!existsSync(join(deepCore, 'pix3project.yaml')))(
    'DeepCore copy: kit leaves its AGENTS.md and tsconfig.json alone, then check runs its tsconfig',
    async () => {
      const copy = join(scratch, 'DeepCore');
      cpSync(deepCore, copy, {
        recursive: true,
        filter: source => {
          const rel = relative(deepCore, source).split(sep)[0];
          return rel !== '.git' && rel !== 'node_modules';
        },
      });
      const agentsBefore = sha256(join(copy, 'AGENTS.md'));
      const tsconfigBefore = sha256(join(copy, 'tsconfig.json'));
      const report = installKit(copy, kit, { devMcp: false });
      expect(report.types).toBe('own-tsconfig');
      expect(sha256(join(copy, 'AGENTS.md'))).toBe(agentsBefore);
      expect(sha256(join(copy, 'tsconfig.json'))).toBe(tsconfigBefore);
      expect(existsSync(join(copy, AGENTS_ALT_FILE))).toBe(true);
      expect(existsSync(join(copy, '.pix3', 'types'))).toBe(false);
      const manifest = parse(readFileSync(join(copy, 'pix3project.yaml'), 'utf8')) as {
        metadata: Record<string, unknown>;
      };
      expect(manifest.metadata.pix3Hybrid).toBeDefined(); // kept
      expect((manifest.metadata.agentKit as { version: string }).version).toBe(CLI_VERSION);

      const checked = await checkProject(copy, {
        hydrate: false,
        offline: true,
        validate: options => validateProject(options),
      });
      expect(checked.typecheck.mode).toBe('project');
      expect(checked.typecheck.tsconfig).toBe('tsconfig.json');
      // The copy has no node_modules: one E_DEPENDENCIES_MISSING instead of a tsc cascade of
      // "Cannot find module" errors (the trial run saw ~250 of them).
      expect(checked.typecheck.typescript).toBeNull();
      expect(checked.typecheck.skipped).toContain('npm install');
      const errors = checked.diagnostics.filter(d => d.severity === 'error');
      expect(errors.filter(d => d.code === 'E_TYPE')).toEqual([]);
      expect(errors.filter(d => d.code === 'E_DEPENDENCIES_MISSING')).toHaveLength(1);
      expect(checked.kit.upToDate).toBe(true);
    },
    120_000
  );
});
