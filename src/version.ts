export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.6.0',
  build: 47,
  displayVersion: 'v1.6.0 (build 47)',
  publishedAt: '2026-09-06T20:53:07.738Z',
};
