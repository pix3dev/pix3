export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '0.8.8',
  build: 34,
  displayVersion: 'v0.8.8 (build 34)',
  publishedAt: '2026-05-06T13:25:12.596Z',
};
