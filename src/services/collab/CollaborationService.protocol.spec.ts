import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HocuspocusProviderConfiguration } from '@hocuspocus/provider';
import {
  CLIENT_SCENE_FORMAT_ERROR,
  COLLABORATION_METADATA_MAP,
  SCENE_FORMAT_PARAMETER,
  SCENE_FORMAT_VERSION,
  SERVER_SCENE_FORMAT_ERROR,
  SERVER_SCENE_FORMAT_KEY,
} from '@pix3/collab-protocol';
import { appState, resetAppState } from '@/state';
import { CollaborationService } from '@/services/collab/CollaborationService';

interface MockProvider {
  configuration: HocuspocusProviderConfiguration;
  destroy: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  providers: [] as MockProvider[],
  onConstruct: null as ((configuration: HocuspocusProviderConfiguration) => void) | null,
}));

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    readonly awareness = {
      setLocalStateField: vi.fn(),
      getLocalState: () => null,
    };
    readonly destroy = vi.fn();
    constructor(readonly configuration: HocuspocusProviderConfiguration) {
      mocks.providers.push(this);
      mocks.onConstruct?.(configuration);
    }
  },
}));

let service: CollaborationService;

function currentProvider(): MockProvider {
  return mocks.providers[mocks.providers.length - 1];
}

function advertiseVersion(version: unknown): void {
  service.getYDoc()?.getMap(COLLABORATION_METADATA_MAP).set(SERVER_SCENE_FORMAT_KEY, version);
}

beforeEach(() => {
  resetAppState();
  mocks.providers.length = 0;
  mocks.onConstruct = null;
  service = new CollaborationService();
});

afterEach(() => service.dispose());

describe('collaboration scene-format handshake', () => {
  it('advertises format 2 without changing an explicit share token', async () => {
    await service.connect('project-1', 'scene-1', 'Guest', '#fff', {
      tokenOverride: 'share-token',
      role: 'viewer',
      authSource: 'share-token',
      isReadOnly: true,
    });
    const config = currentProvider().configuration;
    const url = 'url' in config ? config.url : '';
    expect(new URL(url).searchParams.get(SCENE_FORMAT_PARAMETER)).toBe('2');
    expect(config.token).toBe('share-token');
    expect(config.preserveConnection).toBe(false);
    expect(config.name).toBe('project:project-1');
    expect(appState.collaboration.isReadOnly).toBe(true);
    expect(appState.collaboration.role).toBe('viewer');
  });

  it('does not expose a transport connection as ready before the capability check', async () => {
    await service.connect('project-1', 'scene-1', 'Editor', '#fff');
    currentProvider().configuration.onStatus?.({ status: 'connected' as never });
    expect(service.isConnected()).toBe(false);
    expect(service.connectionStatus).toBe('connecting');
    advertiseVersion(SCENE_FORMAT_VERSION);
    currentProvider().configuration.onSynced?.({ state: true });
    expect(service.connectionStatus).toBe('synced');
    expect(service.isConnected()).toBe(true);
    expect(service.connectionError).toBeNull();
  });

  it.each([undefined, 1, 3, '2'])(
    'rejects missing or unsupported server version %s',
    async version => {
      await service.connect('project-1', 'scene-1', 'Editor', '#fff');
      const provider = currentProvider();
      if (version !== undefined) advertiseVersion(version);
      const statuses: string[] = [];
      service.addStatusListener(status => statuses.push(status));
      provider.configuration.onSynced?.({ state: true });
      expect(statuses).toEqual(['disconnected']);
      expect(service.connectionError).toBe(SERVER_SCENE_FORMAT_ERROR);
      expect(appState.project.errorMessage).toBe(SERVER_SCENE_FORMAT_ERROR);
      expect(provider.destroy).toHaveBeenCalledOnce();
      expect(service.getYDoc()).toBeNull();
      expect(service.getProvider()).toBeNull();
    }
  );

  it('ignores unsynced callbacks while waiting for the server', async () => {
    await service.connect('project-1', 'scene-1', 'Editor', '#fff');
    currentProvider().configuration.onSynced?.({ state: false });
    expect(service.connectionStatus).toBe('connecting');
    expect(service.connectionError).toBeNull();
    expect(currentProvider().destroy).not.toHaveBeenCalled();
  });

  it('surfaces the server refresh reason before notifying disconnected listeners', async () => {
    await service.connect('project-1', 'scene-1', 'Editor', '#fff');
    const observed: (string | null)[] = [];
    service.addStatusListener(() => observed.push(service.connectionError));
    currentProvider().configuration.onAuthenticationFailed?.({ reason: CLIENT_SCENE_FORMAT_ERROR });
    expect(observed).toEqual([CLIENT_SCENE_FORMAT_ERROR]);
    expect(appState.project.errorMessage).toBe(CLIENT_SCENE_FORMAT_ERROR);
    expect(service.getYDoc()).toBeNull();
  });

  it('ignores late callbacks from the previous connection epoch', async () => {
    await service.connect('old-project', 'scene-1', 'Editor', '#fff');
    const old = currentProvider();
    await service.connect('new-project', 'scene-2', 'Editor', '#fff');
    const current = currentProvider();
    advertiseVersion(SCENE_FORMAT_VERSION);
    current.configuration.onSynced?.({ state: true });
    old.configuration.onAuthenticationFailed?.({ reason: CLIENT_SCENE_FORMAT_ERROR });
    old.configuration.onDisconnect?.({ event: {} as never });
    old.configuration.onStatus?.({ status: 'disconnected' as never });
    old.configuration.onSynced?.({ state: true });
    expect(service.connectionStatus).toBe('synced');
    expect(service.connectionError).toBeNull();
    expect(appState.collaboration.roomName).toBe('project:new-project');
    expect(current.destroy).not.toHaveBeenCalled();
  });

  it('does not revive a connection rejected during provider construction', async () => {
    mocks.onConstruct = config => config.onSynced?.({ state: true });
    await service.connect('project-1', 'scene-1', 'Editor', '#fff');
    expect(service.connectionStatus).toBe('disconnected');
    expect(service.getProvider()).toBeNull();
    expect(service.getYDoc()).toBeNull();
    expect(currentProvider().destroy).toHaveBeenCalledOnce();
  });

  it('invalidates an in-flight lazy connection on disconnect', async () => {
    const connecting = service.connect('project-1', 'scene-1', 'Editor', '#fff');
    service.disconnect();
    await connecting;
    expect(mocks.providers).toHaveLength(0);
    expect(service.connectionStatus).toBe('disconnected');
  });

  it('clears only its own error on a fresh connection', async () => {
    await service.connect('project-1', 'scene-1', 'Editor', '#fff');
    currentProvider().configuration.onSynced?.({ state: true });
    await service.connect('project-1', 'scene-1', 'Editor', '#fff');
    expect(service.connectionError).toBeNull();
    expect(appState.project.errorMessage).toBeNull();
    appState.project.errorMessage = 'Unrelated project problem';
    await service.connect('project-1', 'scene-1', 'Editor', '#fff');
    expect(appState.project.errorMessage).toBe('Unrelated project problem');
  });
});
