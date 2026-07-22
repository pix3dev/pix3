import type * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { injectable } from '@/fw/di';
import { appState } from '@/state';
import type { CollabAuthSource, CollabRole } from '@/state/AppState';
import { subscribe } from 'valtio/vanilla';

export type CollabConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'synced';

export interface CollabUserInfo {
  name: string;
  color: string;
  selection: string[];
  cursor3d: { x: number; y: number; z: number } | null;
  cameraPosition: { x: number; y: number; z: number } | null;
  isTransforming: string | null;
}

export interface CollaborationConnectOptions {
  tokenOverride?: string;
  role?: CollabRole;
  authSource?: CollabAuthSource;
  isReadOnly?: boolean;
}

@injectable()
export class CollaborationService {
  private provider: HocuspocusProvider | null = null;
  private ydoc: Y.Doc | null = null;
  private undoManager: Y.UndoManager | null = null;
  private statusListeners = new Set<(status: CollabConnectionStatus) => void>();
  private disposeSelectionSubscription: (() => void) | null = null;
  private connectEpoch = 0;

  connectionStatus: CollabConnectionStatus = 'disconnected';

  /** Flag to prevent echo loop: set to true when processing remote updates */
  isRemoteUpdate = false;

  private getServerBaseUrlInternal(): string {
    if (import.meta.env.DEV) {
      return window.location.origin;
    }

    return import.meta.env.VITE_COLLAB_SERVER_URL || 'http://localhost:4001';
  }

  private getWebSocketUrl(): string {
    const wsUrl = new URL('/collaboration', this.getServerBaseUrlInternal());
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return wsUrl.toString();
  }

  async connect(
    projectId: string,
    _sceneId: string,
    userName: string,
    userColor: string,
    options: CollaborationConnectOptions = {}
  ): Promise<void> {
    // Clean up any existing connection before awaiting so rapid reconnects don't stack.
    this.disconnect();

    // Guard against a double-connect race: capture the epoch before the lazy
    // imports and abort silently if another connect()/disconnect() intervened.
    const epoch = ++this.connectEpoch;

    // Lazy-load the CRDT stack (yjs + hocuspocus) on first connect. Solo/local
    // sessions never reach here, keeping the stack out of the eager main chunk.
    const [{ Doc, UndoManager }, { HocuspocusProvider }] = await Promise.all([
      import('yjs'),
      import('@hocuspocus/provider'),
    ]);

    if (epoch !== this.connectEpoch) {
      return;
    }

    this.ydoc = new Doc();
    const roomName = `project:${projectId}`;
    appState.collaboration.roomName = roomName;
    appState.collaboration.remoteUsers = [];
    appState.collaboration.localUser = {
      clientId: null,
      name: userName,
      color: userColor,
    };
    appState.collaboration.role = options.role ?? null;
    appState.collaboration.authSource = options.authSource ?? 'none';
    appState.collaboration.isReadOnly = Boolean(options.isReadOnly);
    appState.collaboration.accessMode =
      appState.project.backend === 'cloud'
        ? options.isReadOnly
          ? 'cloud-view'
          : 'cloud-edit'
        : 'local';

    // Resolve auth token: explicit override (share token for guests), then JWT from session
    const token = options.tokenOverride ?? appState.auth.user?.token ?? '';

    // Server synchronization
    this.provider = new HocuspocusProvider({
      url: this.getWebSocketUrl(),
      name: roomName,
      document: this.ydoc,
      token,
      onStatus: ({ status }: { status: string }) => {
        this.setConnectionStatus(status as CollabConnectionStatus);
      },
      onSynced: () => {
        this.setConnectionStatus('synced');
      },
      onDisconnect: () => {
        this.setConnectionStatus('disconnected');
      },
    });

    // Set awareness (presence) data
    this.provider.awareness?.setLocalStateField('user', {
      name: userName,
      color: userColor,
      selection: [],
      cursor3d: null,
      cameraPosition: null,
      isTransforming: null,
    } satisfies CollabUserInfo);

    // Track project-scoped scene changes in a single collaboration document.
    const scenesMap = this.ydoc.getMap('scenes');
    this.undoManager = new UndoManager([scenesMap], {
      trackedOrigins: new Set([this.getLocalOrigin()]),
      captureTimeout: 500,
    });
    this.disposeSelectionSubscription = subscribe(appState.selection, () => {
      this.updateLocalSelectionAwareness();
    });
    this.updateLocalSelectionAwareness();

    this.setConnectionStatus('connecting');
  }

  disconnect(): void {
    // Invalidate any in-flight connect() awaiting the lazy CRDT import.
    this.connectEpoch++;
    this.undoManager?.destroy();
    this.undoManager = null;
    this.disposeSelectionSubscription?.();
    this.disposeSelectionSubscription = null;

    this.provider?.destroy();
    this.provider = null;

    this.ydoc?.destroy();
    this.ydoc = null;

    appState.collaboration.roomName = null;
    appState.collaboration.remoteUsers = [];
    appState.collaboration.localUser = null;
    appState.collaboration.role = null;
    appState.collaboration.authSource = 'none';
    appState.collaboration.isReadOnly = false;
    appState.collaboration.accessMode =
      appState.project.backend === 'cloud' ? 'cloud-edit' : 'local';
    appState.collaboration.shareToken = null;
    appState.collaboration.shareEnabled = false;
    this.setConnectionStatus('disconnected');
  }

  isConnected(): boolean {
    return this.connectionStatus === 'connected' || this.connectionStatus === 'synced';
  }

  getYDoc(): Y.Doc | null {
    return this.ydoc;
  }

  getAwareness(): HocuspocusProvider['awareness'] | null {
    return this.provider?.awareness ?? null;
  }

  getUndoManager(): Y.UndoManager | null {
    return this.undoManager;
  }

  getProvider(): HocuspocusProvider | null {
    return this.provider;
  }

  getLocalOrigin(): string {
    return 'pix3-local';
  }

  getServerBaseUrl(): string {
    return this.getServerBaseUrlInternal();
  }

  isReadOnlySession(): boolean {
    return appState.collaboration.isReadOnly;
  }

  private updateLocalSelectionAwareness(): void {
    const awareness = this.provider?.awareness;
    if (!awareness) {
      return;
    }

    const currentState =
      (awareness.getLocalState()?.user as Partial<CollabUserInfo> | undefined) ?? {};
    awareness.setLocalStateField('user', {
      name: currentState.name ?? appState.collaboration.localUser?.name ?? 'Pix3 User',
      color: currentState.color ?? appState.collaboration.localUser?.color ?? '#f5ae39', // --presence-1 (amber, you)
      selection: [...appState.selection.nodeIds],
      cursor3d: currentState.cursor3d ?? null,
      cameraPosition: currentState.cameraPosition ?? null,
      isTransforming: currentState.isTransforming ?? null,
    } satisfies CollabUserInfo);
  }

  addStatusListener(listener: (status: CollabConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  dispose(): void {
    this.disconnect();
    this.statusListeners.clear();
  }

  private setConnectionStatus(status: CollabConnectionStatus): void {
    this.connectionStatus = status;
    appState.collaboration.connectionStatus = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
