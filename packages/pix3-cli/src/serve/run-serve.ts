import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PROJECT_MANIFEST_FILE, findProjectRoot } from '../manifest.ts';
import { DEFAULT_WORKSPACE_PORTS, LINK_HOST } from '../protocol.ts';
import { openWorkspace } from './open-workspace.ts';
import { readProjectName } from './project-info.ts';

/**
 * `pix3 serve [--port N] [--project <dir>] [--new-token]` — human-facing wrapper around
 * {@link openWorkspace}. stdout is for the person at the terminal (no MCP on this command);
 * the event log goes to stderr so it can be silenced without losing the address/token block.
 */

export interface RunServeOptions {
  readonly cwd: string;
  readonly projectDir?: string;
  /** Raw `--port` value; `undefined` = first free of 8490–8499. */
  readonly port?: string;
  readonly newToken: boolean;
}

const parsePort = (raw: string): number => {
  if (!/^\d{1,5}$/.test(raw)) throw new Error(`--port must be a number, got "${raw}".`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error(`--port must be 1–65535, got ${port}.`);
  return port;
};

/** Resolves when the server has stopped (SIGINT/SIGTERM), or at once when nothing was started. */
export const runServe = async (options: RunServeOptions): Promise<number> => {
  const projectDir = options.projectDir
    ? resolve(options.cwd, options.projectDir)
    : (findProjectRoot(options.cwd) ?? resolve(options.cwd));
  if (!existsSync(join(projectDir, PROJECT_MANIFEST_FILE))) {
    process.stderr.write(
      `pix3 serve: ${projectDir} is not a Pix3 project (no ${PROJECT_MANIFEST_FILE}). ` +
        'Run it inside the project folder, or pass --project <dir>.\n'
    );
    return 1;
  }
  const ports = options.port === undefined ? DEFAULT_WORKSPACE_PORTS : [parsePort(options.port)];
  const out = (text: string): void => void process.stdout.write(text);

  const result = await openWorkspace({
    projectDir,
    ports,
    rotateToken: options.newToken,
    log: line => process.stderr.write(`[pix3 serve] ${line}\n`),
  });

  if (result.kind === 'unresponsive') {
    process.stderr.write(
      `pix3 serve: another pix3 serve (pid ${result.pid}) holds ${projectDir} but does not answer. ` +
        `Stop that process, or delete ${join(projectDir, '.pix3', 'serve.lock')} if it is not a pix3 serve.\n`
    );
    return 1;
  }
  if (result.kind === 'running') {
    out(
      `pix3 serve is already running for ${projectDir}\n` +
        `  Address   http://${LINK_HOST}:${result.port}   (pid ${result.pid})\n`
    );
    if (result.issuedToken) {
      out(
        `  Token     ${result.issuedToken}\n` +
          '            New token issued; the running server now refuses the old one.\n'
      );
    }
    return 0;
  }

  const { server, port, identity } = result;
  out(
    `Pix3 workspace server\n` +
      `  Project   ${readProjectName(server.root)}\n` +
      `  Root      ${server.root}\n` +
      `  Address   http://${LINK_HOST}:${port}\n` +
      `  Workspace ${server.workspaceId}\n`
  );
  if (identity.issuedToken) {
    out(
      `  Token     ${identity.issuedToken}\n` +
        '            Shown once: paste it into Pix3 (File → Connect to Workspace…) with the address.\n' +
        (identity.minted === 'moved'
          ? '            (This folder was copied from another workspace; it got its own identity.)\n'
          : '')
    );
  } else {
    out(
      '  Token     paired earlier (not shown again); `pix3 serve --new-token` issues a new one.\n'
    );
  }
  out(
    `\nForward port ${port} to your computer (VS Code: Ports panel, or ssh -L ${port}:127.0.0.1:${port}),\n` +
      'then connect from Pix3 with the address and token. Ctrl+C stops the server.\n'
  );

  await new Promise<void>(resolveStop => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void server.close().finally(resolveStop);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
};
