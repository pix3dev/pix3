import { realpath } from 'node:fs/promises';

import { LINK_HOST } from '../protocol.ts';
import { acquireServeLock, ensureIdentity, readState, type IdentityResult } from './state-file.ts';
import { WorkspaceServer, type WorkspaceServerOptions } from './workspace-server.ts';

/**
 * Start the workspace server for a root — or find the one already serving it.
 *
 * One server per root: `.pix3/serve.lock` (pid, O_EXCL) says whether a live process owns the
 * root, and the `server` record in `.pix3/workspace.json` says where it listens. The two are
 * confirmed against each other with a `GET /ws/status` carrying the record's control secret, so
 * a stale file — or an unrelated process that happens to hold the recorded port — is not
 * reported as "the running server".
 */

export type OpenWorkspaceResult =
  | {
      readonly kind: 'started';
      readonly server: WorkspaceServer;
      readonly port: number;
      readonly identity: IdentityResult;
    }
  | {
      readonly kind: 'running';
      readonly port: number;
      readonly pid: number;
      readonly workspaceId: string;
      readonly serverSession: string;
      /** A token issued by this call (`--new-token` against a running server), else null. */
      readonly issuedToken: string | null;
    }
  | { readonly kind: 'unresponsive'; readonly pid: number };

export interface OpenWorkspaceOptions extends Omit<WorkspaceServerOptions, 'root' | 'onClosed'> {
  readonly projectDir: string;
  readonly rotateToken?: boolean;
  readonly probeTimeoutMs?: number;
}

interface StatusProbe {
  readonly workspaceId: string;
  readonly serverSession: string;
}

const probeStatus = async (
  port: number,
  control: string,
  timeoutMs: number
): Promise<StatusProbe | null> => {
  try {
    const response = await fetch(`http://${LINK_HOST}:${port}/ws/status`, {
      headers: { 'X-Pix3-Control': control },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.workspaceId !== 'string' || typeof body.serverSession !== 'string') return null;
    return { workspaceId: body.workspaceId, serverSession: body.serverSession };
  } catch {
    return null;
  }
};

export const openWorkspace = async (
  options: OpenWorkspaceOptions
): Promise<OpenWorkspaceResult> => {
  const root = await realpath(options.projectDir);
  const lock = acquireServeLock(root);
  if (!lock.acquired) {
    const issuedToken = options.rotateToken
      ? ensureIdentity(root, { rotateToken: true }).issuedToken
      : null;
    const state = readState(root);
    const record = state?.server;
    if (state && record && record.pid === lock.pid) {
      const probe = await probeStatus(record.port, record.control, options.probeTimeoutMs ?? 2_000);
      if (
        probe &&
        probe.serverSession === record.serverSession &&
        probe.workspaceId === state.workspaceId
      ) {
        return {
          kind: 'running',
          port: record.port,
          pid: record.pid,
          workspaceId: state.workspaceId,
          serverSession: record.serverSession,
          issuedToken,
        };
      }
    }
    return { kind: 'unresponsive', pid: lock.pid };
  }
  try {
    const identity = ensureIdentity(root, { rotateToken: options.rotateToken === true });
    const server = new WorkspaceServer({ ...options, root, onClosed: lock.release });
    const port = await server.start().catch(async (error: unknown) => {
      await server.close().catch(() => undefined);
      throw error;
    });
    return { kind: 'started', server, port, identity };
  } catch (error) {
    lock.release();
    throw error;
  }
};
