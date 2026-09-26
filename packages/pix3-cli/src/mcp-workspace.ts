import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { findProjectRoot } from './manifest.ts';
import { CLI_VERSION } from './version.ts';
import { WorkspaceAgentTools } from './workspace-agent/agent-tools.ts';
import { AgentLaneClient, NoWorkspaceServerError } from './workspace-agent/lane-client.ts';

/**
 * `pix3 mcp --workspace [--project <dir>]` — the stdio MCP server of the live channel over a
 * running `pix3 serve` (plan §11.1: phase 3 is built on the workspace backend). It holds no port
 * of its own: every tool call goes to `pix3 serve`'s agent lane (`/ws/agent/*`, authenticated by
 * the control secret in `.pix3/workspace.json`), which parks it for the editor window holding the
 * workspace lease. The tools and the sync barrier live in `workspace-agent/`.
 *
 * stdout belongs to the MCP protocol — every log line goes to stderr.
 */

const log = (line: string): void => {
  process.stderr.write(`[pix3 mcp] ${line}\n`);
};

export interface RunMcpWorkspaceOptions {
  readonly cwd: string;
  readonly projectDir?: string;
  /** `--agent <name>` / `PIX3_AGENT`: used only when the MCP client sends no `clientInfo.name`. */
  readonly agent?: string;
}

export const runMcpWorkspace = async (options: RunMcpWorkspaceOptions): Promise<void> => {
  const root = options.projectDir
    ? resolve(options.cwd, options.projectDir)
    : (findProjectRoot(options.cwd) ?? resolve(options.cwd));

  // Loaded here, not at the top of the CLI: `pix3 new` must not pay for the SDK's import graph.
  const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);

  const server = new Server(
    { name: 'pix3', version: CLI_VERSION },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        'Pix3 editor tools for this project folder (run, observe, generate; no scene editing — ' +
        'edit the files). Pass `expect` {path: sha256 of the bytes you wrote} to play_start / ' +
        'play_restart / game_run so the run is verified against your writes.',
    }
  );
  const session = randomUUID();
  const lane = new AgentLaneClient(root, () => ({
    // Self-declared: the MCP client's own name, else --agent / PIX3_AGENT. Never verified.
    name: server.getClientVersion()?.name ?? options.agent ?? null,
    session,
  }));
  const tools = new WorkspaceAgentTools(lane, { log });

  let advertisedAtList = false;
  server.setRequestHandler(types.ListToolsRequestSchema, async () => {
    const list = await tools.list();
    advertisedAtList = tools.hasAdvertisedTools();
    return {
      tools: list.map(tool => ({ ...tool, inputSchema: { type: 'object', ...tool.inputSchema } })),
    };
  });
  server.setRequestHandler(types.CallToolRequestSchema, async request => {
    const args = request.params.arguments ?? {};
    const result = await tools.call(request.params.name, args);
    // The first list may have been the static fallback; once a window has answered, say so.
    if (!advertisedAtList) {
      void tools.list().then(() => {
        if (tools.hasAdvertisedTools() && !advertisedAtList) {
          advertisedAtList = true;
          void server.sendToolListChanged().catch(() => undefined);
        }
      });
    }
    return result;
  });

  try {
    const status = await lane.status();
    log(
      `workspace server ${status.root} (session ${status.serverSession.slice(0, 8)}, ` +
        `editor ${status.holder ?? 'not connected'})`
    );
  } catch (error) {
    log(
      error instanceof NoWorkspaceServerError
        ? error.message
        : `workspace server check failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdin.on('end', () => void shutdown());

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown();
  await server.connect(transport);
};
