export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.3.0',
  build: 41,
  displayVersion: 'v1.3.0 (build 41)',
  publishedAt: '2026-08-12T00:48:21.405Z',
};
