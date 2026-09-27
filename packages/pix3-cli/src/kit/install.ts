import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';

import { PROJECT_MANIFEST_FILE } from '../manifest.ts';
import { MCP_CONFIG_FILE, mcpLaunch, renderMcpConfig } from '../mcp-config.ts';
import type { CreatedProject, PostCreateStep } from '../new-project.ts';
import {
  hasOwnTsconfig,
  installProjectTypes,
  projectTypesCurrent,
  ROOT_TSCONFIG,
  ROOT_TSCONFIG_CONTENT,
} from '../types/project-types.ts';
import type { RuntimeTypesManifest } from '../types/runtime-types.ts';
import type { KitSource } from './kit-source.ts';

/**
 * `pix3 kit [--update]` — put the agent kit into a project (plan §5 B), and the part of `pix3 new`
 * that does the same for a fresh one.
 *
 * What lands in the project:
 * - the generated kit files: `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), `.claude/skills/pix3-*` —
 *   except that a project which already has an `AGENTS.md` of its own keeps it and gets
 *   `AGENTS.pix3.md` instead (and a `CLAUDE.md` of its own is never touched: the report says which
 *   line to add);
 * - `.mcp.json` with the pinned `pix3 mcp --workspace` entry (other servers kept);
 * - `.pix3/` in `.gitignore` (existing content kept);
 * - without a `tsconfig.json` of the project's own: `.pix3/types/`, `.pix3/tsconfig.check.json`
 *   and a root `tsconfig.json` that extends it (see `types/project-types.ts`);
 * - `metadata.agentKit: { version, files }` in `pix3project.yaml`;
 * - `.pix3/kit-manifest.json` — the sha256 of every file the kit wrote, which is how `--update`
 *   knows a file is still the kit's: unchanged since written → replaced; edited → skipped and
 *   reported. Without `--update`, existing files are never replaced (only missing ones written).
 */

export const KIT_PROJECT_MANIFEST = '.pix3/kit-manifest.json';
export const AGENTS_FILE = 'AGENTS.md';
export const AGENTS_ALT_FILE = 'AGENTS.pix3.md';
export const CLAUDE_FILE = 'CLAUDE.md';
const GITIGNORE = '.gitignore';
const GITIGNORE_ENTRY = '.pix3/';

export interface ProjectKitManifest {
  readonly format: 1;
  readonly version: string;
  /** Project path → sha256 of the bytes the kit wrote there. */
  readonly files: Readonly<Record<string, string>>;
}

export type KitFileAction = 'written' | 'updated' | 'unchanged' | 'skipped-edited' | 'outdated';

export interface KitFileOutcome {
  readonly path: string;
  readonly action: KitFileAction;
}

export interface KitInstallReport {
  readonly version: string;
  readonly files: readonly KitFileOutcome[];
  /** One-line things the human (or agent) should do, e.g. link AGENTS.pix3.md. */
  readonly instructions: readonly string[];
  readonly notes: readonly string[];
  /** `.pix3/types` layout written (false: the project has its own tsconfig.json). */
  readonly types: 'installed' | 'current' | 'own-tsconfig';
}

export interface InstallKitOptions {
  readonly update?: boolean;
  /** Shipped runtime types (`ensureRuntimeTypes()`); required unless the project has a tsconfig. */
  readonly runtimeTypes?: { readonly dir: string; readonly manifest: RuntimeTypesManifest };
  /** `.mcp.json` launch in dev form (repo sources) or pinned; default: detect. */
  readonly devMcp?: boolean;
}

const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

export const readProjectKitManifest = (projectRoot: string): ProjectKitManifest | null => {
  const text = readText(join(projectRoot, KIT_PROJECT_MANIFEST));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Partial<ProjectKitManifest>;
    return parsed && typeof parsed.files === 'object' && parsed.files !== null
      ? { format: 1, version: String(parsed.version ?? ''), files: parsed.files }
      : null;
  } catch {
    return null;
  }
};

const writeAtomic = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, path);
};

/** Add `.pix3/` to `.gitignore` unless an equivalent line is there. Returns true when written. */
export const ensureGitignore = (projectRoot: string): boolean => {
  const path = join(projectRoot, GITIGNORE);
  const current = readText(path) ?? '';
  const covered = current
    .split(/\r?\n/)
    .map(line => line.trim())
    .some(line => ['.pix3', '.pix3/', '/.pix3', '/.pix3/', '.pix3/*', '/.pix3/*'].includes(line));
  if (covered) return false;
  const prefix = current.length === 0 || current.endsWith('\n') ? current : `${current}\n`;
  writeAtomic(
    path,
    `${prefix}${prefix ? '\n' : ''}# Pix3 editor + CLI bookkeeping (recovery journal, merge log, script types)\n${GITIGNORE_ENTRY}\n`
  );
  return true;
};

/** Set `metadata.agentKit` in `pix3project.yaml`, keeping everything else as written. */
export const writeAgentKitMetadata = (
  projectRoot: string,
  agentKit: { readonly version: string; readonly files: readonly string[] }
): boolean => {
  const path = join(projectRoot, PROJECT_MANIFEST_FILE);
  const text = readText(path);
  if (text === null) return false;
  const doc = parseDocument(text);
  const next = { version: agentKit.version, files: [...agentKit.files] };
  const plain = doc.toJS() as { metadata?: { agentKit?: unknown } } | null;
  if (JSON.stringify(plain?.metadata?.agentKit ?? null) === JSON.stringify(next)) return false;
  if (!plain?.metadata || typeof plain.metadata !== 'object')
    doc.set('metadata', doc.createNode({}));
  doc.setIn(['metadata', 'agentKit'], doc.createNode(next));
  writeAtomic(path, doc.toString({ indent: 2 }));
  return true;
};

/** Which instruction file wins on what, when a project has its own `AGENTS.md`. */
export const PRECEDENCE_SENTENCE =
  "The project's own AGENTS.md wins on process (planning first, config placement); the Pix3 kit wins on Pix3 facts (YAML, runtime API, pix3 check).";

/** The line the project's own `AGENTS.md` should carry so agents that read only it find ours. */
export const AGENTS_LINK_LINE = `See ${AGENTS_ALT_FILE} for the Pix3 engine rules.`;

/**
 * The kit's AGENTS.md as it lands in `AGENTS.pix3.md` beside a project's own `AGENTS.md`: the same
 * text with a header that says so — the TODO `pix3 kit` prints scrolls away, this stays. Inserted
 * after the first line (the kit's version comment) so the file still starts the same way.
 */
export const withAltAgentsHeader = (contents: string): string => {
  const header = [
    '',
    `> **This project has its own \`${AGENTS_FILE}\`; this file is the Pix3 kit beside it.** ${PRECEDENCE_SENTENCE}`,
    `> If \`${AGENTS_FILE}\` does not mention this file yet, add the line "${AGENTS_LINK_LINE}" to it (agents that read only \`${AGENTS_FILE}\` will not find this one otherwise).`,
    '',
  ].join('\n');
  const newline = contents.indexOf('\n');
  return newline < 0
    ? `${contents}\n${header}\n`
    : `${contents.slice(0, newline + 1)}${header}\n${contents.slice(newline + 1)}`;
};

const mentionsAltAgents = (path: string): boolean =>
  (readText(path) ?? '').includes(AGENTS_ALT_FILE);

const claudeContent = (agentsTarget: string): string =>
  agentsTarget === AGENTS_FILE ? '@AGENTS.md\n' : `@AGENTS.md\n@${AGENTS_ALT_FILE}\n`;

/** Install or update the kit in `projectRoot`. */
export const installKit = (
  projectRoot: string,
  source: KitSource,
  options: InstallKitOptions = {}
): KitInstallReport => {
  const previous = readProjectKitManifest(projectRoot);
  const owned: Record<string, string> = { ...(previous?.files ?? {}) };
  const outcomes: KitFileOutcome[] = [];
  const instructions: string[] = [];
  const notes: string[] = [];

  /** Write `contents` at `path` under the ownership rules; records the outcome. */
  const place = (path: string, contents: string): void => {
    const target = join(projectRoot, path);
    const next = sha256(contents);
    const existing = existsSync(target) ? readFileSync(target) : null;
    if (existing === null) {
      writeAtomic(target, contents);
      owned[path] = next;
      outcomes.push({ path, action: 'written' });
      return;
    }
    const current = sha256(existing);
    if (current === next) {
      owned[path] = next;
      outcomes.push({ path, action: 'unchanged' });
      return;
    }
    if (owned[path] === current) {
      if (options.update) {
        writeAtomic(target, contents);
        owned[path] = next;
        outcomes.push({ path, action: 'updated' });
      } else {
        outcomes.push({ path, action: 'outdated' });
      }
      return;
    }
    // Edited since the kit wrote it, or never the kit's.
    outcomes.push({ path, action: 'skipped-edited' });
  };

  // AGENTS.md: a project's own stays; ours goes beside it.
  const agentsPath = join(projectRoot, AGENTS_FILE);
  const ownsAgents =
    !existsSync(agentsPath) ||
    (owned[AGENTS_FILE] !== undefined && owned[AGENTS_FILE] === sha256(readFileSync(agentsPath)));
  const agentsTarget =
    owned[AGENTS_ALT_FILE] !== undefined || !ownsAgents ? AGENTS_ALT_FILE : AGENTS_FILE;

  for (const file of source.manifest.files) {
    const contents = readFileSync(join(source.filesDir, file), 'utf8');
    if (file === AGENTS_FILE) {
      const alt = agentsTarget === AGENTS_ALT_FILE;
      place(agentsTarget, alt ? withAltAgentsHeader(contents) : contents);
      // Every run until it is done, not only the first: the line is the human's to add.
      if (alt && !mentionsAltAgents(agentsPath)) {
        instructions.push(
          `This project already has its own ${AGENTS_FILE}: the Pix3 kit is in ${AGENTS_ALT_FILE}. ${PRECEDENCE_SENTENCE} Add a line "${AGENTS_LINK_LINE}" to ${AGENTS_FILE}.`
        );
      }
      continue;
    }
    if (file === CLAUDE_FILE) {
      const claudePath = join(projectRoot, CLAUDE_FILE);
      const content = claudeContent(agentsTarget);
      const claudeOwned =
        !existsSync(claudePath) ||
        owned[CLAUDE_FILE] === sha256(readFileSync(claudePath)) ||
        readFileSync(claudePath, 'utf8') === content;
      if (claudeOwned) {
        place(CLAUDE_FILE, content);
      } else {
        const text = readFileSync(claudePath, 'utf8');
        const line = `@${agentsTarget}`;
        if (!text.split(/\r?\n/).some(l => l.trim() === line)) {
          instructions.push(
            `This project already has its own ${CLAUDE_FILE}: add the line "${line}" to it so Claude Code loads the Pix3 kit.`
          );
        }
        outcomes.push({ path: CLAUDE_FILE, action: 'skipped-edited' });
      }
      continue;
    }
    place(file, contents);
  }

  // .mcp.json — merged: other servers stay; our entry is (re)pinned on install and --update.
  const mcpPath = join(projectRoot, MCP_CONFIG_FILE);
  const mcpBefore = readText(mcpPath);
  const mcpNext = renderMcpConfig(mcpLaunch({ dev: options.devMcp }), mcpBefore ?? undefined);
  const hasPix3Entry = (() => {
    try {
      const parsed = mcpBefore
        ? (JSON.parse(mcpBefore) as { mcpServers?: { pix3?: unknown } })
        : null;
      return Boolean(parsed?.mcpServers?.pix3);
    } catch {
      return false;
    }
  })();
  if (mcpBefore === mcpNext) {
    outcomes.push({ path: MCP_CONFIG_FILE, action: 'unchanged' });
  } else if (!hasPix3Entry || options.update) {
    writeAtomic(mcpPath, mcpNext);
    outcomes.push({ path: MCP_CONFIG_FILE, action: mcpBefore === null ? 'written' : 'updated' });
  } else {
    outcomes.push({ path: MCP_CONFIG_FILE, action: 'outdated' });
  }

  if (ensureGitignore(projectRoot)) outcomes.push({ path: GITIGNORE, action: 'updated' });

  // Script types.
  let types: KitInstallReport['types'];
  if (hasOwnTsconfig(projectRoot)) {
    types = 'own-tsconfig';
    notes.push(
      `${ROOT_TSCONFIG} is the project's own: pix3 check type-checks with it (against node_modules), .pix3/types is not written.`
    );
  } else {
    if (!options.runtimeTypes) throw new Error('installKit: runtime types are required');
    if (projectTypesCurrent(projectRoot, options.runtimeTypes.manifest)) {
      types = 'current';
    } else {
      installProjectTypes(projectRoot, options.runtimeTypes);
      types = 'installed';
    }
    place(ROOT_TSCONFIG, ROOT_TSCONFIG_CONTENT);
  }

  const kitFiles = [
    ...outcomes.filter(o => o.action !== 'skipped-edited' && o.path !== GITIGNORE).map(o => o.path),
  ].sort();
  // Files left at an older version (no --update) keep the recorded kit version honest: `check`
  // then keeps saying the kit is outdated until `pix3 kit --update`.
  const outdated = outcomes.filter(o => o.action === 'outdated');
  const version =
    outdated.length > 0 && previous?.version ? previous.version : source.manifest.version;
  const manifest: ProjectKitManifest = {
    format: 1,
    version,
    files: Object.fromEntries(
      Object.entries(owned)
        .filter(([path]) => existsSync(join(projectRoot, path)))
        .sort(([a], [b]) => (a < b ? -1 : 1))
    ),
  };
  writeAtomic(join(projectRoot, KIT_PROJECT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  writeAgentKitMetadata(projectRoot, { version, files: kitFiles });

  if (outdated.length > 0) {
    notes.push(
      `${outdated.length} kit file(s) are from another version and unchanged by you: pix3 kit --update replaces them.`
    );
  }
  return { version, files: outcomes, instructions, notes, types };
};

/** `pix3 new`'s post-create step: the kit into the fresh project. */
export const agentKitStep =
  (
    source: KitSource,
    runtimeTypes: { readonly dir: string; readonly manifest: RuntimeTypesManifest },
    options: { readonly devMcp?: boolean } = {}
  ): PostCreateStep =>
  (project: CreatedProject) => {
    const report = installKit(project.dir, source, { runtimeTypes, devMcp: options.devMcp });
    return report.files
      .filter(o => o.action === 'written' || o.action === 'updated')
      .map(o => o.path);
  };

export const formatKitReport = (report: KitInstallReport, projectRoot: string): string => {
  const lines: string[] = [`Pix3 agent kit ${report.version} in ${projectRoot}`];
  const label: Record<KitFileAction, string> = {
    written: 'wrote',
    updated: 'updated',
    unchanged: 'current',
    'skipped-edited': 'SKIPPED',
    outdated: 'outdated',
  };
  for (const outcome of report.files) {
    const why =
      outcome.action === 'skipped-edited'
        ? "  (edited since the kit wrote it, or not the kit's; left as is)"
        : outcome.action === 'outdated'
          ? '  (pix3 kit --update replaces it)'
          : '';
    lines.push(`  ${label[outcome.action].padEnd(8)} ${outcome.path}${why}`);
  }
  if (report.types === 'installed')
    lines.push('  wrote    .pix3/types/, .pix3/tsconfig.check.json');
  for (const note of report.notes) lines.push(`note: ${note}`);
  for (const instruction of report.instructions) lines.push(`TODO: ${instruction}`);
  return `${lines.join('\n')}\n`;
};
