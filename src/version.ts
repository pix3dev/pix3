export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.1.0',
  build: 38,
  displayVersion: 'v1.1.0 (build 38)',
  publishedAt: '2026-07-21T07:31:42.148Z',
};
