import { CLI_VERSION } from './version.ts';

/**
 * The `pix3` help text — its own module so specs (the kit drift spec checks every command the kit
 * names against it) can read it without running the CLI.
 */
export const USAGE = `pix3 ${CLI_VERSION}

Usage:
  pix3 new                         List recipes and templates
  pix3 new <recipe> [dir]          Create a project (dir defaults to the recipe id)
        [--name <project name>]
  pix3 mcp --workspace             MCP server for your agent (stdio), relayed through the
        [--project <dir>]          running \`pix3 serve\` to the connected Pix3 editor
  pix3 mcp [--project <dir>]       (phase-0 prototype) MCP server + FSA loopback link
        [--agent <name>]
  pix3 setup [claude|codex]        Print how to register the MCP server with your agent
  pix3 serve [--project <dir>]     Serve this project folder to a Pix3 editor over one
        [--port <n>] [--new-token] loopback port (e.g. through VS Code Remote SSH)
  pix3 validate [paths…] [--json]  Strict scene check: schema, references, guards, then
        [--no-hydrate]             hydration with the real loader (exit 1 on errors)
  pix3 check [--json]              validate + TypeScript check of the scripts + merge-log +
        [--no-hydrate] [--offline] version check (exit 1 on errors)
        [--project <dir>]
  pix3 kit [--update]              Install (or update) the agent kit: AGENTS.md, CLAUDE.md,
        [--project <dir>]          .claude/skills/pix3-*, .mcp.json, script types
  pix3 read <path>                 Print a project file and confirm to the editor that you
                                   read exactly these bytes (.pix3/ack.json)
  pix3 ack <path> --sha256 <hash>  Confirm you read the version with this byte hash
  pix3 --version
`;
