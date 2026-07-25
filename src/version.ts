export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.2.0',
  build: 39,
  displayVersion: 'v1.2.0 (build 39)',
  publishedAt: '2026-07-25T20:38:32.549Z',
};
