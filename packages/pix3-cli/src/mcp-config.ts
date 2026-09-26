import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CreatedProject, PostCreateStep } from './new-project.ts';
import { CLI_VERSION } from './version.ts';

/**
 * MCP configuration of the live channel (plan §5 A "`pix3 setup`" and "Закрепление версий").
 *
 * Every configuration we write or print starts `npx -y @pix3/cli@<X.Y.Z> mcp --workspace` — the
 * exact CLI version that wrote it, never a bare `@pix3/cli` (npx would then take whatever its cache
 * or the registry has, and the server would drift from the kit and the cached editor).
 *
 * **Dev mode.** From a repo checkout (the CLI runs from its `src/`, next to `packages/pix3-runtime`)
 * or with `PIX3_CLI_DEV=1`, the command is `node <repo>/packages/pix3-cli/src/index.ts mcp
 * --workspace` instead, so the channel can be tried before that version is on npm.
 */

export const MCP_CONFIG_FILE = '.mcp.json';

export interface McpLaunch {
  readonly command: string;
  readonly args: string[];
}

/** `src/index.ts` of this package (dev mode's entry), or null where that is not a file URL. */
const sourceEntry = (): string | null => {
  try {
    return fileURLToPath(new URL('./index.ts', import.meta.url));
  } catch {
    return null;
  }
};

/** True when this CLI runs from a checkout of the pix3 repo (or `PIX3_CLI_DEV=1`). */
export const isDevCheckout = (): boolean => {
  if (process.env.PIX3_CLI_DEV === '1') return true;
  if (process.env.PIX3_CLI_DEV === '0') return false;
  // `src/index.ts` next to this module + the runtime package beside ours = a repo checkout.
  const entry = sourceEntry();
  if (!entry) return false;
  const packageDir = dirname(dirname(entry));
  return (
    existsSync(entry) &&
    import.meta.url.endsWith('.ts') &&
    existsSync(join(packageDir, '..', 'pix3-runtime', 'package.json'))
  );
};

/** How an agent starts `pix3 mcp --workspace`, pinned to this CLI's version (or dev sources). */
export const mcpLaunch = (
  options: { readonly dev?: boolean; readonly projectDir?: string } = {}
): McpLaunch => {
  const dev = options.dev ?? isDevCheckout();
  const tail = [
    'mcp',
    '--workspace',
    ...(options.projectDir ? ['--project', options.projectDir] : []),
  ];
  const entry = dev ? sourceEntry() : null;
  return entry
    ? { command: 'node', args: [entry, ...tail] }
    : { command: 'npx', args: ['-y', `@pix3/cli@${CLI_VERSION}`, ...tail] };
};

/** `.mcp.json` in Claude Code's project format; keeps other servers already listed there. */
export const renderMcpConfig = (launch: McpLaunch, existing?: string): string => {
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
      { ...base, mcpServers: { ...servers, pix3: { command: launch.command, args: launch.args } } },
      null,
      2
    ) + '\n'
  );
};

export const writeMcpConfig = (dir: string, options: { readonly dev?: boolean } = {}): string => {
  const target = join(dir, MCP_CONFIG_FILE);
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  writeFileSync(target, renderMcpConfig(mcpLaunch({ dev: options.dev }), existing));
  return MCP_CONFIG_FILE;
};

/** Post-create step of `pix3 new`: the project-scoped MCP config Claude Code picks up. */
export const mcpConfigStep =
  (options: { readonly dev?: boolean } = {}): PostCreateStep =>
  (project: CreatedProject) => [writeMcpConfig(project.dir, options)];

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

const tomlString = (value: string): string => JSON.stringify(value);

export type SetupTarget = 'claude' | 'codex';

/**
 * What `pix3 setup [claude|codex]` prints — the command / snippet for a project that has no
 * configuration yet. Printed, never executed.
 */
export const setupInstructions = (
  target: SetupTarget | null,
  root: string,
  options: { readonly dev?: boolean } = {}
): string => {
  const out: string[] = [];
  if (target === null || target === 'claude') {
    const launch = mcpLaunch({ dev: options.dev });
    out.push(
      'Claude Code — run inside the project folder:',
      '',
      `  cd ${shellQuote(root)}`,
      `  claude mcp add pix3 -- ${[launch.command, ...launch.args].map(shellQuote).join(' ')}`,
      '',
      `  (or commit the project's ${MCP_CONFIG_FILE}; \`pix3 new\` writes one.)`,
      ''
    );
  }
  if (target === null || target === 'codex') {
    // Codex's config is global, so the project root is passed explicitly.
    const launch = mcpLaunch({ dev: options.dev, projectDir: root });
    out.push(
      'Codex — add to ~/.codex/config.toml:',
      '',
      '  [mcp_servers.pix3]',
      `  command = ${tomlString(launch.command)}`,
      `  args = [${launch.args.map(tomlString).join(', ')}]`,
      '  # game_run can take longer than the default tool timeout',
      '  tool_timeout_sec = 180',
      ''
    );
  }
  out.push(
    'Then start `pix3 serve` in the project, connect the Pix3 editor to it (File → Connect to',
    'Workspace…), and start the agent in the project folder.',
    ''
  );
  return out.join('\n');
};
