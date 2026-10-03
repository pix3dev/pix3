// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { afterLoadDocumentPayload, onAuthenticatePayload } from '@hocuspocus/server';
import {
  CLIENT_SCENE_FORMAT_ERROR,
  COLLABORATION_METADATA_MAP,
  SCENE_FORMAT_PARAMETER,
  SCENE_FORMAT_VERSION,
  SERVER_SCENE_FORMAT_KEY,
} from '../shared/collaboration-protocol.js';

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getUserRole: vi.fn(),
  getProjectByShareToken: vi.fn(),
}));

vi.mock('../core/auth/auth-middleware.js', () => ({ verifyToken: mocks.verifyToken }));
vi.mock('../core/projects/projects-service.js', () => ({
  getUserRole: mocks.getUserRole,
  getProjectByShareToken: mocks.getProjectByShareToken,
}));
vi.mock('better-sqlite3', () => ({
  default: class {
    pragma() {}
    exec() {}
    close() {}
  },
}));
vi.mock('fs', () => ({ default: { mkdirSync: vi.fn() } }));
vi.mock('./document-files.js', () => ({
  loadScenesFromDisk: vi.fn(),
  loadScriptsFromDisk: vi.fn(),
  persistDocumentToDisk: vi.fn(),
}));

const { createHocuspocusServer } = await import('./hocuspocus.js');
const { Doc } = await import('yjs');
let server: ReturnType<typeof createHocuspocusServer>;

function authenticate(format: string | null, token = 'jwt') {
  const requestParameters = new URLSearchParams();
  if (format !== null) requestParameters.set(SCENE_FORMAT_PARAMETER, format);
  const connectionConfig = { readOnly: false, isAuthenticated: false };
  const result = server.instance.configuration.onAuthenticate?.({
    token,
    documentName: 'project:project-1',
    connectionConfig,
    requestParameters,
  } as onAuthenticatePayload);
  return { result, connectionConfig };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyToken.mockReturnValue({ userId: 'user-1' });
  mocks.getUserRole.mockReturnValue('editor');
  mocks.getProjectByShareToken.mockReturnValue(undefined);
  server = createHocuspocusServer();
});

afterEach(async () => server.destroy());

describe('server scene-format compatibility guard', () => {
  it.each([null, '', '1', '3', '02'])(
    'rejects client format %s with a wire-visible refresh reason',
    async format => {
      const { result } = authenticate(format);
      await expect(result).rejects.toMatchObject({
        message: CLIENT_SCENE_FORMAT_ERROR,
        reason: CLIENT_SCENE_FORMAT_ERROR,
      });
      expect(mocks.verifyToken).not.toHaveBeenCalled();
      expect(mocks.getProjectByShareToken).not.toHaveBeenCalled();
    }
  );

  it.each(['editor', 'viewer'])('retains JWT %s authorization for format 2', async role => {
    mocks.getUserRole.mockReturnValue(role);
    const { result, connectionConfig } = authenticate('2');
    await expect(result).resolves.toEqual({ userId: 'user-1', role });
    expect(connectionConfig.readOnly).toBe(role === 'viewer');
    expect(mocks.verifyToken).toHaveBeenCalledWith('jwt');
    expect(mocks.getUserRole).toHaveBeenCalledWith('project-1', 'user-1');
  });

  it('retains share-token read-only authorization for format 2', async () => {
    mocks.verifyToken.mockImplementation(() => {
      throw new Error('Not a JWT');
    });
    mocks.getProjectByShareToken.mockReturnValue({ id: 'project-1' });
    const { result, connectionConfig } = authenticate('2', 'share-token');
    await expect(result).resolves.toEqual({ userId: 'guest', role: 'viewer' });
    expect(connectionConfig.readOnly).toBe(true);
    expect(mocks.getProjectByShareToken).toHaveBeenCalledWith('share-token');
  });

  it('still rejects unauthorized current-format clients', async () => {
    const { result } = authenticate('2', '');
    await expect(result).rejects.toThrow('Unauthorized');
  });

  it('advertises support after loading, replacing an older persisted marker', async () => {
    const document = new Doc();
    const metadata = document.getMap(COLLABORATION_METADATA_MAP);
    metadata.set(SERVER_SCENE_FORMAT_KEY, 1);
    await server.instance.configuration.afterLoadDocument?.({
      document,
    } as afterLoadDocumentPayload);
    expect(metadata.get(SERVER_SCENE_FORMAT_KEY)).toBe(SCENE_FORMAT_VERSION);
    document.destroy();
  });

  it('advertises support for empty rooms without touching their scenes', async () => {
    const document = new Doc();
    await server.instance.configuration.afterLoadDocument?.({
      document,
    } as afterLoadDocumentPayload);
    expect(document.getMap(COLLABORATION_METADATA_MAP).get(SERVER_SCENE_FORMAT_KEY)).toBe(2);
    expect(document.getMap('scenes').size).toBe(0);
    document.destroy();
  });
});
