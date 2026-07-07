export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '0.8.10',
  build: 36,
  displayVersion: 'v0.8.10 (build 36)',
  publishedAt: '2026-07-05T18:24:47.048Z',
};
