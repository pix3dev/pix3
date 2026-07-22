import { injectable } from '@/fw/di';
import { CURRENT_EDITOR_VERSION, type EditorVersionInfo } from '@/version';

export type UpdateCheckStatus = 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'error';

export interface UpdateCheckState {
  status: UpdateCheckStatus;
  currentVersion: EditorVersionInfo;
  latestVersion: EditorVersionInfo | null;
}

export type UpdateCheckListener = (state: UpdateCheckState) => void;

const VERSION_ENDPOINT = '/version.json';

function buildVersionCheckUrl(): string {
  const url = new URL(VERSION_ENDPOINT, window.location.origin);
  url.searchParams.set('ts', Date.now().toString());
  return `${url.pathname}${url.search}`;
}

function normalizeSemver(version: string): [number, number, number] {
  const [major = '0', minor = '0', patch = '0'] = version.split('.');
  return [major, minor, patch].map(part => Number.parseInt(part, 10) || 0) as [
    number,
    number,
    number,
  ];
}

export function compareEditorVersions(
  left: Pick<EditorVersionInfo, 'version' | 'build'>,
  right: Pick<EditorVersionInfo, 'version' | 'build'>
): number {
  const leftSemver = normalizeSemver(left.version);
  const rightSemver = normalizeSemver(right.version);

  for (let index = 0; index < leftSemver.length; index += 1) {
    if (leftSemver[index] !== rightSemver[index]) {
      return leftSemver[index] > rightSemver[index] ? 1 : -1;
    }
  }

  if (left.build === right.build) {
    return 0;
  }

  return left.build > right.build ? 1 : -1;
}

function isEditorVersionInfo(value: unknown): value is EditorVersionInfo {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<EditorVersionInfo>;
  return (
    typeof candidate.version === 'string' &&
    typeof candidate.build === 'number' &&
    typeof candidate.displayVersion === 'string' &&
    (candidate.publishedAt === undefined || typeof candidate.publishedAt === 'string')
  );
}

@injectable()
export class UpdateCheckService {
  private readonly listeners = new Set<UpdateCheckListener>();
  private initialized = false;
  private state: UpdateCheckState = {
    status: 'idle',
    currentVersion: CURRENT_EDITOR_VERSION,
    latestVersion: null,
  };

  getState(): UpdateCheckState {
    return this.state;
  }

  subscribe(listener: UpdateCheckListener): () => void {
    this.listeners.add(listener);
    listener(this.state);

    return () => {
      this.listeners.delete(listener);
    };
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    void this.checkForUpdates();
  }

  async checkForUpdates(): Promise<UpdateCheckState> {
    this.updateState({
      status: 'checking',
      latestVersion: null,
    });

    try {
      const response = await fetch(buildVersionCheckUrl(), {
        cache: 'no-store',
        headers: {
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch version manifest: ${response.status}`);
      }

      const payload: unknown = await response.json();
      if (!isEditorVersionInfo(payload)) {
        throw new Error('Version manifest has invalid shape');
      }

      const nextState: UpdateCheckState = {
        status:
          compareEditorVersions(payload, this.state.currentVersion) > 0
            ? 'update-available'
            : 'up-to-date',
        currentVersion: this.state.currentVersion,
        latestVersion: payload,
      };

      this.state = nextState;
      this.emit();
      return nextState;
    } catch {
      const errorState: UpdateCheckState = {
        status: 'error',
        currentVersion: this.state.currentVersion,
        latestVersion: null,
      };
      this.state = errorState;
      this.emit();
      return errorState;
    }
  }

  dispose(): void {
    this.listeners.clear();
  }

  private updateState(partial: Partial<UpdateCheckState>): void {
    this.state = {
      ...this.state,
      ...partial,
    };
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach(listener => listener(this.state));
  }
}
