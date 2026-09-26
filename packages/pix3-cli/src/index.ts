#!/usr/bin/env node
import { resolve } from 'node:path';

import { createProject } from './new-project.ts';
import { listTemplates, oneLine, resolveTemplate } from './templates.ts';
import { CLI_VERSION } from './version.ts';

/**
 * `pix3` — entry point of `@pix3/cli`. Deliberately free of heavy imports: `new` must stay instant
 * under a cold `npx`, so `mcp` loads the MCP SDK lazily (`mcp.ts` is itself imported on demand).
 */

const USAGE = `pix3 ${CLI_VERSION}

Usage:
  pix3 new                         List recipes and templates
  pix3 new <recipe> [dir]          Create a project (dir defaults to the recipe id)
        [--name <project name>]
  pix3 mcp [--project <dir>]       Run the MCP server for your agent (stdio) and the
        [--agent <name>]           loopback link the Pix3 editor connects to
  pix3 serve [--project <dir>]     Serve this project folder to a Pix3 editor over one
        [--port <n>] [--new-token] loopback port (e.g. through VS Code Remote SSH)
  pix3 validate [paths…] [--json]  Strict scene check: schema, references, guards, then
        [--no-hydrate]             hydration with the real loader (exit 1 on errors)
  pix3 read <path>                 Print a project file and confirm to the editor that you
                                   read exactly these bytes (.pix3/ack.json)
  pix3 ack <path> --sha256 <hash>  Confirm you read the version with this byte hash
  pix3 --version
`;

interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
}

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags.set(arg.slice(2), argv[++i]);
      } else {
        flags.set(arg.slice(2), true);
      }
    } else if (arg === '-v') {
      flags.set('version', true);
    } else if (arg === '-h') {
      flags.set('help', true);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
};

const stringFlag = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

const printTemplateList = (): void => {
  const templates = listTemplates().filter(t => !t.hidden);
  const width = Math.max(...templates.map(t => t.id.length));
  const section = (title: string, items: typeof templates): void => {
    if (items.length === 0) return;
    process.stdout.write(`${title}\n`);
    for (const t of items) {
      process.stdout.write(`  ${t.id.padEnd(width)}  ${t.title} — ${oneLine(t.description)}\n`);
    }
    process.stdout.write('\n');
  };
  section(
    'Recipes (ship design/recipe.md — a playable core loop):',
    templates.filter(t => t.isRecipe)
  );
  section(
    'Starter templates:',
    templates.filter(t => !t.isRecipe)
  );
  process.stdout.write(
    'Create one:  pix3 new <id> [dir]   (recipes also by short name: pix3 new tapper)\n'
  );
};

const runNew = (args: ParsedArgs): number => {
  const [, query, dirArg] = args.positionals;
  if (!query) {
    printTemplateList();
    return 0;
  }
  const resolved = resolveTemplate(query, listTemplates());
  if ('error' in resolved) {
    process.stderr.write(`pix3: ${resolved.error}\n`);
    return 1;
  }
  const dir = resolve(process.cwd(), dirArg ?? resolved.template.id);
  const project = createProject({
    template: resolved.template,
    dir,
    projectName: stringFlag(args, 'name'),
  });
  process.stdout.write(
    `Created ${project.projectName} from ${project.template.id} in ${project.dir}\n` +
      `  ${project.files.length} files, project id ${project.projectId}\n\n` +
      `Next: open that folder in Pix3 (Open Folder), and start your agent inside it.\n`
  );
  return 0;
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positionals[0];
  if (args.flags.has('version')) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  if (!command || args.flags.has('help') || command === 'help') {
    process.stdout.write(USAGE);
    return command || args.flags.has('help') ? 0 : 1;
  }
  switch (command) {
    case 'new':
      return runNew(args);
    case 'mcp': {
      const { runMcp } = await import('./mcp.ts');
      await runMcp({
        cwd: process.cwd(),
        projectDir: stringFlag(args, 'project'),
        agent: stringFlag(args, 'agent') ?? (process.env.PIX3_AGENT || undefined),
      });
      return -1; // keeps running; exits from its own shutdown path
    }
    case 'serve': {
      const { runServe } = await import('./serve/run-serve.ts');
      const port = args.flags.get('port');
      if (port === true) {
        process.stderr.write('pix3: --port needs a number.\n');
        return 1;
      }
      return runServe({
        cwd: process.cwd(),
        projectDir: stringFlag(args, 'project'),
        port,
        newToken: args.flags.has('new-token'),
      });
    }
    case 'read':
    case 'ack': {
      const file = args.positionals[1];
      if (!file) {
        process.stderr.write(`pix3: ${command} needs a file path.\n`);
        return 1;
      }
      const { ackFile, readAndAck } = await import('./ack.ts');
      const projectDir = stringFlag(args, 'project');
      if (command === 'read') {
        process.stdout.write(readAndAck({ cwd: process.cwd(), file, projectDir }).bytes);
        return 0;
      }
      if (args.flags.get('sha256') === true) {
        process.stderr.write('pix3: --sha256 needs a hash.\n');
        return 1;
      }
      const record = ackFile({
        cwd: process.cwd(),
        file,
        projectDir,
        hash: stringFlag(args, 'sha256'),
      });
      process.stdout.write(`acked ${record.path} ${record.sha256}\n`);
      return 0;
    }
    case 'validate': // own argument parsing (`--json` takes no value); runtime loads lazily
      return (await import('./validate/entry.ts')).runValidateCli(
        process.argv.slice(process.argv.indexOf('validate') + 1)
      );
    default:
      process.stderr.write(`pix3: unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
};

main().then(
  code => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`pix3: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
);
