import { inject, injectable, ServiceContainer } from '@/fw/di';
import { subscribe } from 'valtio/vanilla';
import {
  appState,
  createInitialWorkspaceConnectionState,
  type WorkspaceConnectionState,
} from '@/state';
import { FileWatchService } from '@/services/project/FileWatchService';
import { isPix3InternalPath } from '@/services/project/coauthoring/coauthoring-paths';
import { WorkspaceClient } from '@/services/project/workspace/WorkspaceClient';
import {
  WorkspaceEventsClient,
  type WorkspaceEventsHandlers,
} from '@/services/project/workspace/WorkspaceEventsClient';
import {
  WORKSPACE_PROTOCOL,
  WorkspaceError,
  normalizeWorkspaceEndpoint,
  type WorkspaceChangeEvent,
  type WorkspaceChangeFrame,
  type WorkspaceHelloFrame,
  type WorkspaceLeaseFrame,
  type WorkspaceStatusInfo,
} from '@/services/project/workspace/workspace-protocol';

export interface WorkspaceConnectOptions {
  /** Refuse to proceed when the address now serves another workspace (recents reopen). */
  readonly expectedWorkspaceId?: string | null;
}

export interface WorkspaceConnection {
  readonly endpoint: string;
  readonly hello: WorkspaceHelloFrame;
  readonly status: WorkspaceStatusInfo;
}

/** How long `connect` waits for the socket's `hello` after `/ws/status` answered. */
const HELLO_TIMEOUT_MS = 10_000;
/** How long `connect` waits for the first lease answer before letting the project open. */
const FIRST_LEASE_TIMEOUT_MS = 3_000;

const SCRIPT_SOURCE = /\.(?:ts|js)$/i;

/**
 * One live connection to a `pix3 serve` workspace: configures {@link WorkspaceClient} (HTTP) and
 * runs {@link WorkspaceEventsClient} (WebSocket), and turns what the socket says into editor state:
 *
 * - connection + lease → `appState.project.workspace` (this service owns that slice);
 * - `change` batches → {@link FileWatchService.notifyExternalChange} (the same listeners the FSA
 *   poller drives, so open scenes reload through `ReloadSceneCommand` exactly as for a local
 *   folder) plus `fileRefreshSignal` for listings, and a script rebuild when sources appear or go;
 * - reconnect → full manifest re-scan, diffed against what was known, fed through the same path.
 *
 * A change whose hash equals the bytes this editor last read or wrote is not an external change
 * (the server already suppresses our own mutations by id; this also covers a racing echo).
 */
@injectable()
export class WorkspaceSessionService {
  @inject(WorkspaceClient)
  private readonly client!: WorkspaceClient;

  @inject(FileWatchService)
  private readonly fileWatch!: FileWatchService;

  private events: WorkspaceEventsClient | null = null;
  private eventsFactory: () => WorkspaceEventsClient = () => new WorkspaceEventsClient();
  private connection: WorkspaceConnection | null = null;
  private helloWaiter: {
    resolve: (hello: WorkspaceHelloFrame) => void;
    reject: (error: WorkspaceError) => void;
  } | null = null;
  private leaseWaiter: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  /** Project id the live connection belongs to (set by the open path once state is switched). */
  private attachedProjectId: string | null = null;
  private disposeProjectSubscription: (() => void) | null = null;

  /**
   * Bind the live connection to the project that was just opened with it. From then on, the
   * moment another project replaces it (a folder picked, a cloud project opened, Close Project),
   * the connection is dropped — no path has to remember to disconnect it.
   */
  attachToProject(projectId: string): void {
    this.attachedProjectId = projectId;
    this.disposeProjectSubscription ??= subscribe(appState.project, () => {
      const attached = this.attachedProjectId;
      if (
        attached !== null &&
        (appState.project.backend !== 'workspace' || appState.project.id !== attached)
      ) {
        this.disconnect();
      }
    });
  }

  /** Tests inject a fake-socket events client here. */
  setEventsClientFactory(factory: () => WorkspaceEventsClient): void {
    this.eventsFactory = factory;
  }

  getConnection(): WorkspaceConnection | null {
    return this.connection;
  }

  isConnected(): boolean {
    return this.connection !== null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Verify the server (`/ws/status`: reachability, token, protocol, identity), open the events
   * socket and wait for `hello` and the first lease answer. Throws a {@link WorkspaceError} with a
   * user-facing message; on failure nothing stays connected.
   */
  async connect(
    rawEndpoint: string,
    rawToken: string,
    options: WorkspaceConnectOptions = {}
  ): Promise<WorkspaceConnection> {
    const endpoint = normalizeWorkspaceEndpoint(rawEndpoint);
    const token = rawToken.trim();
    if (!token) {
      throw new WorkspaceError('bad_request', 'Enter the token printed by `pix3 serve`.');
    }

    this.disconnect();
    this.client.configure({ endpoint, token });
    this.patchState({
      ...createInitialWorkspaceConnectionState(),
      status: 'connecting',
      endpoint,
    });

    try {
      const status = await this.client.status();
      assertProtocol(status.protocol, status.cliVersion);
      if (options.expectedWorkspaceId && status.workspaceId !== options.expectedWorkspaceId) {
        throw new WorkspaceError(
          'workspace_mismatch',
          `${endpoint} now serves a different workspace (${status.root}). Start \`pix3 serve\` ` +
            'in the project you want, or connect to it as a new workspace.'
        );
      }

      const hello = await this.openEvents(endpoint, token);
      assertProtocol(hello.protocol, hello.cliVersion);
      await this.waitForFirstLease();
      await this.client.getManifest(true);
      this.fileWatch.setPushMode(true);

      this.connection = { endpoint, hello, status };
      this.patchState({
        status: 'connected',
        workspaceId: hello.workspaceId,
        root: hello.root,
        serverSession: hello.serverSession,
        errorMessage: null,
      });
      return this.connection;
    } catch (error) {
      const workspaceError =
        error instanceof WorkspaceError
          ? error
          : new WorkspaceError(
              'server_error',
              error instanceof Error ? error.message : String(error),
              {
                cause: error,
              }
            );
      this.disconnect();
      throw workspaceError;
    }
  }

  /** Close the socket (releasing the lease), forget caches and credentials in memory. */
  disconnect(): void {
    this.attachedProjectId = null;
    const events = this.events;
    this.events = null;
    this.connection = null;
    this.rejectHello(
      new WorkspaceError('connection_failed', 'The workspace connection was closed.')
    );
    this.leaseWaiter?.();
    this.leaseWaiter = null;
    events?.close();
    this.client.reset();
    this.fileWatch.setPushMode(false);
    this.patchState(createInitialWorkspaceConnectionState());
  }

  /** Take the edit lease from the window that holds it (the explicit "Take over" action). */
  takeOverLease(): void {
    if (!this.events) {
      return;
    }
    this.patchState({ lease: 'pending' });
    this.events.takeOverLease();
  }

  /** False while another window holds the lease: this one must not write. */
  canWrite(): boolean {
    const lease = appState.project.workspace.lease;
    return lease !== 'busy' && lease !== 'lost';
  }

  dispose(): void {
    this.disconnect();
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = null;
    this.listeners.clear();
  }

  // --- Events socket --------------------------------------------------------------------------

  private openEvents(endpoint: string, token: string): Promise<WorkspaceHelloFrame> {
    const events = this.eventsFactory();
    this.events = events;

    const hello = new Promise<WorkspaceHelloFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectHello(
          new WorkspaceError(
            'timeout',
            `${endpoint} answered over HTTP but its event socket (/ws/events) did not. Check ` +
              'that the forwarded port carries WebSocket traffic, then connect again.'
          )
        );
      }, HELLO_TIMEOUT_MS);
      this.helloWaiter = {
        resolve: frame => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });

    const handlers: WorkspaceEventsHandlers = {
      onHello: (frame, info) => this.handleHello(frame, info.reconnected),
      onChange: frame => {
        void this.handleChangeFrame(frame);
      },
      onLease: frame => this.handleLease(frame),
      onRescanNeeded: () => {
        void this.rescan();
      },
      onConnectionState: (state, error) => {
        if (this.events !== events) {
          return;
        }
        if (state === 'reconnecting') {
          this.patchState({ status: 'reconnecting' });
        } else if (state === 'open') {
          this.patchState({ status: 'connected', errorMessage: null });
        } else if (state === 'closed' && error) {
          this.rejectHello(error);
          this.leaseWaiter?.();
          this.leaseWaiter = null;
          this.patchState({ status: 'disconnected', lease: 'none', errorMessage: error.message });
        }
      },
    };

    events.connect(endpoint, token, handlers);
    return hello;
  }

  private handleHello(frame: WorkspaceHelloFrame, reconnected: boolean): void {
    if (this.helloWaiter) {
      const waiter = this.helloWaiter;
      this.helloWaiter = null;
      waiter.resolve(frame);
      return;
    }
    if (!reconnected || !this.connection) {
      return;
    }
    if (frame.workspaceId !== this.connection.hello.workspaceId) {
      // The forwarded port now leads to a different project: do not mix its files into this one.
      this.events?.close();
      this.events = null;
      this.patchState({
        status: 'disconnected',
        lease: 'none',
        errorMessage:
          'The server at this address now serves a different workspace. Reconnect to this ' +
          "project's own `pix3 serve`.",
      });
      return;
    }
    this.connection = { ...this.connection, hello: frame };
    this.patchState({ serverSession: frame.serverSession, root: frame.root });
  }

  private handleLease(frame: WorkspaceLeaseFrame): void {
    switch (frame.state) {
      case 'granted':
        this.patchState({ lease: 'held', leaseInGrace: false });
        break;
      case 'busy':
        this.patchState({ lease: 'busy', leaseInGrace: frame.inGrace });
        break;
      case 'lost':
        this.patchState({ lease: 'lost', leaseInGrace: false });
        break;
      case 'released':
        this.patchState({ lease: 'none', leaseInGrace: false });
        break;
    }
    const waiter = this.leaseWaiter;
    this.leaseWaiter = null;
    waiter?.();
  }

  private waitForFirstLease(): Promise<void> {
    if (appState.project.workspace.lease !== 'none') {
      return Promise.resolve();
    }
    this.patchState({ lease: 'pending' });
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.leaseWaiter = null;
        resolve();
      }, FIRST_LEASE_TIMEOUT_MS);
      this.leaseWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private rejectHello(error: WorkspaceError): void {
    const waiter = this.helloWaiter;
    this.helloWaiter = null;
    waiter?.reject(error);
  }

  // --- External changes -----------------------------------------------------------------------

  /** Visible for tests. */
  async handleChangeFrame(frame: WorkspaceChangeFrame): Promise<void> {
    if (!this.client.isConfigured()) {
      return;
    }
    this.client.applyChangeEvents(frame.events);
    await this.dispatchChanges(frame.events);
  }

  /**
   * Re-read the whole manifest after a reconnect (events are not replayed) and push every
   * difference from what was known through the normal change path.
   */
  async rescan(): Promise<void> {
    if (!this.client.isConfigured()) {
      return;
    }
    const before = new Map(
      this.client.getManifestEntries().map(entry => [entry.path, entry] as const)
    );
    let manifest;
    try {
      manifest = await this.client.getManifest(true);
    } catch (error) {
      console.warn('[WorkspaceSessionService] Re-scan after reconnect failed', error);
      return;
    }

    const events: WorkspaceChangeEvent[] = [];
    const seen = new Set<string>();
    for (const entry of manifest.files) {
      seen.add(entry.path);
      const previous = before.get(entry.path);
      if (!previous) {
        events.push({
          op: 'create',
          path: entry.path,
          kind: entry.kind,
          ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
        });
      } else if (entry.kind === 'file' && previous.sha256 !== entry.sha256) {
        events.push({
          op: 'modify',
          path: entry.path,
          kind: 'file',
          ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
        });
      }
    }
    for (const [path, entry] of before) {
      if (!seen.has(path)) {
        events.push({ op: 'delete', path, kind: entry.kind });
      }
    }
    if (events.length > 0) {
      await this.dispatchChanges(events);
    }
  }

  private async dispatchChanges(events: readonly WorkspaceChangeEvent[]): Promise<void> {
    const directories = new Set<string>();
    let scriptsChanged = false;

    for (const event of events) {
      if (isPix3InternalPath(event.path) && (!event.from || isPix3InternalPath(event.from))) {
        // Editor bookkeeping (journal, protected set, merge log): not project content.
        continue;
      }
      directories.add(parentDirectory(event.path));
      if (event.from) {
        directories.add(parentDirectory(event.from));
      }
      if (
        event.op !== 'modify' &&
        (SCRIPT_SOURCE.test(event.path) || SCRIPT_SOURCE.test(event.from ?? ''))
      ) {
        scriptsChanged = true;
      }
      if (event.kind !== 'file' || event.op === 'delete') {
        // A deleted open file is not reloaded (the FSA poller also just drops it); listings refresh.
        continue;
      }
      const knownHash = this.client.getKnownHash(event.path);
      if (event.sha256 && knownHash === event.sha256) {
        continue;
      }
      this.fileWatch.notifyExternalChange(event.path, { sha256: event.sha256 ?? null });
    }

    if (directories.size > 0) {
      appState.project.lastModifiedDirectoryPath =
        directories.size === 1 ? Array.from(directories)[0] : '.';
      appState.project.fileRefreshSignal = (appState.project.fileRefreshSignal || 0) + 1;
    }

    if (scriptsChanged) {
      await this.rebuildScripts();
    }
  }

  private async rebuildScripts(): Promise<void> {
    try {
      const { ProjectScriptLoaderService } = await import(
        '@/services/scripting/ProjectScriptLoaderService'
      );
      const container = ServiceContainer.getInstance();
      const loader = container.getService<InstanceType<typeof ProjectScriptLoaderService>>(
        container.getOrCreateToken(ProjectScriptLoaderService)
      );
      await loader.syncAndBuild();
    } catch (error) {
      console.warn(
        '[WorkspaceSessionService] Script rebuild after an external change failed',
        error
      );
    }
  }

  private patchState(patch: Partial<WorkspaceConnectionState>): void {
    Object.assign(appState.project.workspace, patch);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('[WorkspaceSessionService] Listener error', error);
      }
    }
  }
}

function assertProtocol(protocol: number, cliVersion: string): void {
  if (protocol !== WORKSPACE_PROTOCOL) {
    throw new WorkspaceError(
      'protocol_mismatch',
      `The workspace server speaks protocol ${protocol} (pix3 ${cliVersion}); this editor speaks ` +
        `protocol ${WORKSPACE_PROTOCOL}. Run the \`@pix3/cli\` version that matches this editor ` +
        '(or update the editor) and connect again.'
    );
  }
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : '.';
}
