import { injectable } from '@/fw/di';

export interface WorkspaceConnectDialogRequest {
  readonly id: string;
  /** Address to prefill (a recents entry's endpoint, or the default). */
  readonly endpoint: string | null;
  /** Why the dialog opened instead of a silent reconnect (a rejected token, a dead server…). */
  readonly errorMessage: string | null;
  /** Name of the workspace being reconnected, when known. */
  readonly workspaceName: string | null;
  /** Workspace being reconnected: its stored token (if any) is prefilled, masked. */
  readonly workspaceId: string | null;
}

export interface WorkspaceConnectDialogOptions {
  readonly endpoint?: string | null;
  readonly errorMessage?: string | null;
  readonly workspaceName?: string | null;
  readonly workspaceId?: string | null;
}

/**
 * Open/close state of the "Connect to Workspace" dialog. The editor shell renders
 * `pix3-workspace-connect-dialog` for the active request; the dialog itself performs the
 * connection through `ProjectService.openWorkspaceProject`.
 */
@injectable()
export class WorkspaceConnectDialogService {
  private active: WorkspaceConnectDialogRequest | null = null;
  private readonly listeners = new Set<(request: WorkspaceConnectDialogRequest | null) => void>();
  private nextId = 0;

  open(options: WorkspaceConnectDialogOptions = {}): void {
    this.active = {
      id: `workspace-connect-${this.nextId++}`,
      endpoint: options.endpoint ?? null,
      errorMessage: options.errorMessage ?? null,
      workspaceName: options.workspaceName ?? null,
      workspaceId: options.workspaceId ?? null,
    };
    this.notify();
  }

  close(): void {
    if (!this.active) {
      return;
    }
    this.active = null;
    this.notify();
  }

  isOpen(): boolean {
    return this.active !== null;
  }

  subscribe(listener: (request: WorkspaceConnectDialogRequest | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.active);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.active = null;
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.active);
    }
  }
}
