import { resolve } from 'node:path';

import { textResult, type ToolCallResult } from './call-relay.ts';
import { LinkServer, type LinkStatus } from './link-server.ts';
import { PROJECT_MANIFEST_FILE, findProjectRoot } from './manifest.ts';
import { CLI_VERSION } from './version.ts';

/**
 * `pix3 mcp` — the agent-facing half of the live channel (plan §5 D): a stdio MCP server the
 * agent starts from its config, plus the loopback {@link LinkServer} the editor window discovers.
 *
 * Phase 0 exposes one tool, `project_status`. With a leased window it is forwarded to the editor
 * (the round trip the real tools will use); without one it answers locally with what the user has
 * to do. stdout belongs to the MCP protocol — every log line goes to stderr.
 */

const log = (line: string): void => {
  process.stderr.write(`[pix3 mcp] ${line}\n`);
};

/** How recent a browser `/hello` or failed claim must be to count as "a window is out there". */
const RECENT_MS = 30_000;

export const describeUnlinked = (
  status: LinkStatus,
  projectDir: string,
  now: number = Date.now()
): string => {
  if (status.port === null) {
    return (
      'The Pix3 link server could not start (every port in 8490–8499 is taken), so no editor ' +
      'window can connect to this agent session. Close other `pix3 mcp` processes and restart the agent.'
    );
  }
  if (status.projectId === null) {
    return (
      `${projectDir} is not a Pix3 project with a project id (no ${PROJECT_MANIFEST_FILE} with ` +
      '`metadata.projectId` here or above). Create one with `npx @pix3/cli new`, or start the ' +
      'agent from the project folder.'
    );
  }
  const recent = (at: number | null): boolean => at !== null && now - at < RECENT_MS;
  if (recent(status.lastFailedClaimAt)) {
    return (
      'A Pix3 editor window has a project with this id open, but not THIS folder — it is a copy, ' +
      `another checkout or a worktree. Open ${projectDir} itself in Pix3 (Open Folder).`
    );
  }
  if (recent(status.lastBrowserHelloAt)) {
    return (
      'A Pix3 editor window can see this agent but has not connected: it has a different folder ' +
      `open. Open ${projectDir} in Pix3 (Open Folder).`
    );
  }
  return (
    `The Pix3 editor is not open on this project. Open ${projectDir} in Pix3 (Open Folder, or ` +
    'Recent projects); the window connects to this agent by itself. Files can be edited meanwhile — ' +
    'the editor picks them up when it opens.'
  );
};

export const projectStatus = async (link: LinkServer): Promise<ToolCallResult> => {
  if (link.isLeased()) {
    return link.callEditor('project_status', {});
  }
  return textResult(describeUnlinked(link.status(), link.projectDir));
};

export interface RunMcpOptions {
  readonly cwd: string;
  /** `--project <dir>`; otherwise the nearest ancestor of `cwd` with a manifest, else `cwd`. */
  readonly projectDir?: string;
  /** `--agent <name>` / `PIX3_AGENT`; otherwise the MCP client's own `clientInfo.name`. */
  readonly agent?: string;
}

export const runMcp = async (options: RunMcpOptions): Promise<void> => {
  const projectDir = options.projectDir
    ? resolve(options.cwd, options.projectDir)
    : (findProjectRoot(options.cwd) ?? resolve(options.cwd));

  // Loaded here, not at the top of the CLI: `pix3 new` must not pay for the SDK's import graph.
  const [{ McpServer }, { StdioServerTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
  ]);

  const mcp = new McpServer({ name: 'pix3', version: CLI_VERSION });
  const link = new LinkServer({
    projectDir,
    agent: () => options.agent ?? mcp.server.getClientVersion()?.name ?? null,
    log,
  });

  mcp.registerTool(
    'project_status',
    {
      description:
        'Whether a Pix3 editor window is connected to this project folder, and what it reports. ' +
        'When none is, says what the user has to open.',
    },
    async () => projectStatus(link)
  );

  // The link server is best-effort: an agent without it still gets a truthful project_status.
  try {
    const port = await link.start();
    log(`link server on http://127.0.0.1:${port} for ${projectDir} (session ${link.sessionId})`);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  }

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await link.close();
    await mcp.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // The agent closing our stdin is how a stdio MCP server is told to go away.
  process.stdin.on('end', () => void shutdown());

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown();
  await mcp.connect(transport);
};
