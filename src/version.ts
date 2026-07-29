export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.3.0',
  build: 40,
  displayVersion: 'v1.3.0 (build 40)',
  publishedAt: '2026-07-29T20:34:57.724Z',
};
