/**
 * The editor's `pix3 kit [--update]`: puts the agent kit into the open project through whatever
 * storage backs it (a local folder, or a `pix3 serve` workspace).
 *
 * A port of `@pix3/cli` 1.6.x `src/kit/install.ts` (Node-only: `node:fs`, `node:crypto`; source
 * now in pix3-core, `packages/cli/`) with the same outcome file by file. The byte-for-byte parity
 * spec against the CLI sources left with them at the 1.6.x freeze; the rules mirror the CLI's:
 * - kit files (`AGENTS.md`, `CLAUDE.md`, `.claude/skills/pix3-*`) are written when missing, left
 *   when identical, replaced only with `update` AND only while still the kit's (sha256 matches the
 *   one `.pix3/kit-manifest.json` recorded), and never when edited since (`skipped-edited`);
 * - a project's own `AGENTS.md` stays: the kit goes to `AGENTS.pix3.md`, and a `CLAUDE.md` of the
 *   project's own is never touched (an instruction says which line to add);
 * - `.mcp.json` is merged (other servers kept) — and only written when the caller has a CLI
 *   version confirmed to exist on npm (`cli-version-gate.ts`); otherwise it is left out and the
 *   report says so;
 * - `.pix3/` goes into `.gitignore`; a root `tsconfig.json` extending `.pix3/tsconfig.check.json`
 *   is placed unless the project has its own (the `.pix3/types/` it points at are written by the
 *   first `pix3 check`, which hydrates them — the editor does not carry 6 MB of declarations);
 * - `.pix3/kit-manifest.json` records the hash of every file the kit owns.
 *
 * `metadata.agentKit` is returned rather than written: the editor owns `pix3project.yaml` through
 * `ProjectService.saveProjectManifest`, which also keeps `appState.project.manifest` current.
 */

export const KIT_PROJECT_MANIFEST = '.pix3/kit-manifest.json';
export const AGENTS_FILE = 'AGENTS.md';
export const AGENTS_ALT_FILE = 'AGENTS.pix3.md';
export const CLAUDE_FILE = 'CLAUDE.md';
export const MCP_CONFIG_FILE = '.mcp.json';
export const GITIGNORE_FILE = '.gitignore';
export const ROOT_TSCONFIG = 'tsconfig.json';
export const ROOT_TSCONFIG_CONTENT = '{ "extends": "./.pix3/tsconfig.check.json" }\n';
const GITIGNORE_ENTRY = '.pix3/';

/** Which instruction file wins on what, when a project has its own `AGENTS.md` (CLI wording). */
export const PRECEDENCE_SENTENCE =
  "The project's own AGENTS.md wins on process (planning first, config placement); the Pix3 kit wins on Pix3 facts (YAML, runtime API, pix3 check).";

export const AGENTS_LINK_LINE = `See ${AGENTS_ALT_FILE} for the Pix3 engine rules.`;

export interface BundledAgentKit {
  readonly version: string;
  /** Project path → contents, in the kit manifest's order. */
  readonly files: ReadonlyMap<string, string>;
}

/** The storage the kit is written through; `read` answers null for a missing file. */
export interface AgentKitFileSystem {
  read(path: string): Promise<string | null>;
  write(path: string, contents: string): Promise<void>;
}

export type KitFileAction = 'written' | 'updated' | 'unchanged' | 'skipped-edited' | 'outdated';

export interface KitFileOutcome {
  readonly path: string;
  readonly action: KitFileAction;
}

export interface AgentKitInstallReport {
  readonly version: string;
  readonly files: readonly KitFileOutcome[];
  /** Things the human (or agent) should do, e.g. link `AGENTS.pix3.md`. */
  readonly instructions: readonly string[];
  readonly notes: readonly string[];
  /** Root `tsconfig.json` placed (types come with the first `pix3 check`) or the project's own. */
  readonly types: 'kit-tsconfig' | 'own-tsconfig';
  /** CLI version pinned in `.mcp.json`, or null when `.mcp.json` was left out. */
  readonly mcpCliVersion: string | null;
  /** What `pix3project.yaml` `metadata.agentKit` should say. */
  readonly agentKitMetadata: { readonly version: string; readonly files: readonly string[] };
}

export interface AgentKitInstallOptions {
  /** `pix3 kit --update`: replace kit files the user has not edited. */
  readonly update?: boolean;
  /** CLI version confirmed on npm for `.mcp.json`; null leaves `.mcp.json` out. */
  readonly mcpCliVersion: string | null;
}

interface ProjectKitManifest {
  readonly format: 1;
  readonly version: string;
  readonly files: Readonly<Record<string, string>>;
}

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const parseKitManifest = (text: string | null): ProjectKitManifest | null => {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Partial<ProjectKitManifest> | null;
    return parsed && typeof parsed.files === 'object' && parsed.files !== null
      ? { format: 1, version: String(parsed.version ?? ''), files: parsed.files }
      : null;
  } catch {
    return null;
  }
};

/** The `.gitignore` with `.pix3/` added, or null when an equivalent line is already there. */
export const gitignoreWithPix3 = (current: string | null): string | null => {
  const text = current ?? '';
  const covered = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .some(line => ['.pix3', '.pix3/', '/.pix3', '/.pix3/', '.pix3/*', '/.pix3/*'].includes(line));
  if (covered) return null;
  const prefix = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
  return `${prefix}${prefix ? '\n' : ''}# Pix3 editor + CLI bookkeeping (recovery journal, merge log, script types)\n${GITIGNORE_ENTRY}\n`;
};

/** The kit's AGENTS.md as it lands in `AGENTS.pix3.md` beside a project's own `AGENTS.md`. */
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

/** The pinned `pix3 mcp --workspace` launch every configuration we write carries. */
export const mcpLaunchArgs = (cliVersion: string): string[] => [
  '-y',
  `@pix3/cli@${cliVersion}`,
  'mcp',
  '--workspace',
];

/** `.mcp.json` in Claude Code's project format; keeps other servers already listed there. */
export const renderMcpConfig = (cliVersion: string, existing?: string): string => {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      base = {};
    }
  }
  const servers =
    base.mcpServers && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)
      ? (base.mcpServers as Record<string, unknown>)
      : {};
  return (
    JSON.stringify(
      {
        ...base,
        mcpServers: { ...servers, pix3: { command: 'npx', args: mcpLaunchArgs(cliVersion) } },
      },
      null,
      2
    ) + '\n'
  );
};

const claudeContent = (agentsTarget: string): string =>
  agentsTarget === AGENTS_FILE ? '@AGENTS.md\n' : `@AGENTS.md\n@${AGENTS_ALT_FILE}\n`;

/** Install or update the kit through `fs`. Mirrors the CLI's `installKit` outcome for outcome. */
export const installAgentKit = async (
  fs: AgentKitFileSystem,
  kit: BundledAgentKit,
  options: AgentKitInstallOptions
): Promise<AgentKitInstallReport> => {
  const previous = parseKitManifest(await fs.read(KIT_PROJECT_MANIFEST));
  const owned: Record<string, string> = { ...(previous?.files ?? {}) };
  const outcomes: KitFileOutcome[] = [];
  const instructions: string[] = [];
  const notes: string[] = [];
  /** Paths known to exist now (read or written during this run). */
  const present = new Set<string>();

  const read = async (path: string): Promise<string | null> => {
    const text = await fs.read(path);
    if (text !== null) present.add(path);
    return text;
  };
  const write = async (path: string, contents: string): Promise<void> => {
    await fs.write(path, contents);
    present.add(path);
  };

  const place = async (path: string, contents: string): Promise<void> => {
    const next = await sha256Hex(contents);
    const existing = await read(path);
    if (existing === null) {
      await write(path, contents);
      owned[path] = next;
      outcomes.push({ path, action: 'written' });
      return;
    }
    const current = await sha256Hex(existing);
    if (current === next) {
      owned[path] = next;
      outcomes.push({ path, action: 'unchanged' });
      return;
    }
    if (owned[path] === current) {
      if (options.update) {
        await write(path, contents);
        owned[path] = next;
        outcomes.push({ path, action: 'updated' });
      } else {
        outcomes.push({ path, action: 'outdated' });
      }
      return;
    }
    outcomes.push({ path, action: 'skipped-edited' });
  };

  // AGENTS.md: a project's own stays; ours goes beside it.
  const agentsBefore = await read(AGENTS_FILE);
  const ownsAgents =
    agentsBefore === null ||
    (owned[AGENTS_FILE] !== undefined && owned[AGENTS_FILE] === (await sha256Hex(agentsBefore)));
  const agentsTarget =
    owned[AGENTS_ALT_FILE] !== undefined || !ownsAgents ? AGENTS_ALT_FILE : AGENTS_FILE;

  for (const [file, contents] of kit.files) {
    if (file === AGENTS_FILE) {
      const alt = agentsTarget === AGENTS_ALT_FILE;
      await place(agentsTarget, alt ? withAltAgentsHeader(contents) : contents);
      if (alt && !((await fs.read(AGENTS_FILE)) ?? '').includes(AGENTS_ALT_FILE)) {
        instructions.push(
          `This project already has its own ${AGENTS_FILE}: the Pix3 kit is in ${AGENTS_ALT_FILE}. ${PRECEDENCE_SENTENCE} Add a line "${AGENTS_LINK_LINE}" to ${AGENTS_FILE}.`
        );
      }
      continue;
    }
    if (file === CLAUDE_FILE) {
      const content = claudeContent(agentsTarget);
      const existing = await read(CLAUDE_FILE);
      const claudeOwned =
        existing === null ||
        owned[CLAUDE_FILE] === (await sha256Hex(existing)) ||
        existing === content;
      if (claudeOwned) {
        await place(CLAUDE_FILE, content);
      } else {
        const line = `@${agentsTarget}`;
        if (!existing.split(/\r?\n/).some(l => l.trim() === line)) {
          instructions.push(
            `This project already has its own ${CLAUDE_FILE}: add the line "${line}" to it so Claude Code loads the Pix3 kit.`
          );
        }
        outcomes.push({ path: CLAUDE_FILE, action: 'skipped-edited' });
      }
      continue;
    }
    await place(file, contents);
  }

  // .mcp.json — merged; only with a CLI version that exists on npm.
  if (options.mcpCliVersion !== null) {
    const mcpBefore = await read(MCP_CONFIG_FILE);
    const mcpNext = renderMcpConfig(options.mcpCliVersion, mcpBefore ?? undefined);
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
      await write(MCP_CONFIG_FILE, mcpNext);
      outcomes.push({ path: MCP_CONFIG_FILE, action: mcpBefore === null ? 'written' : 'updated' });
    } else {
      outcomes.push({ path: MCP_CONFIG_FILE, action: 'outdated' });
    }
  }

  const gitignoreNext = gitignoreWithPix3(await read(GITIGNORE_FILE));
  if (gitignoreNext !== null) {
    await write(GITIGNORE_FILE, gitignoreNext);
    outcomes.push({ path: GITIGNORE_FILE, action: 'updated' });
  }

  // Script types: the root tsconfig; `.pix3/types/` itself comes with the first `pix3 check`.
  let types: AgentKitInstallReport['types'];
  const tsconfig = await read(ROOT_TSCONFIG);
  if (tsconfig !== null && tsconfig.trim() !== ROOT_TSCONFIG_CONTENT.trim()) {
    types = 'own-tsconfig';
    notes.push(
      `${ROOT_TSCONFIG} is the project's own: pix3 check type-checks with it (against node_modules), .pix3/types is not written.`
    );
  } else {
    types = 'kit-tsconfig';
    await place(ROOT_TSCONFIG, ROOT_TSCONFIG_CONTENT);
  }

  const kitFiles = outcomes
    .filter(o => o.action !== 'skipped-edited' && o.path !== GITIGNORE_FILE)
    .map(o => o.path)
    .sort();
  const outdated = outcomes.filter(o => o.action === 'outdated');
  const version = outdated.length > 0 && previous?.version ? previous.version : kit.version;

  const ownedEntries: Array<[string, string]> = [];
  for (const [path, hash] of Object.entries(owned)) {
    if (present.has(path) || (await fs.read(path)) !== null) ownedEntries.push([path, hash]);
  }
  ownedEntries.sort(([a], [b]) => (a < b ? -1 : 1));
  const manifest: ProjectKitManifest = {
    format: 1,
    version,
    files: Object.fromEntries(ownedEntries),
  };
  await fs.write(KIT_PROJECT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  if (outdated.length > 0) {
    notes.push(
      `${outdated.length} kit file(s) are from another version and unchanged by you: pix3 kit --update replaces them.`
    );
  }
  return {
    version,
    files: outcomes,
    instructions,
    notes,
    types,
    mcpCliVersion: options.mcpCliVersion,
    agentKitMetadata: { version, files: kitFiles },
  };
};
