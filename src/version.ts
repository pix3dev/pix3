export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.4.1',
  build: 43,
  displayVersion: 'v1.4.1 (build 43)',
  publishedAt: '2026-08-16T16:42:43.235Z',
};
