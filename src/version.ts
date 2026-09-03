export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.6.0',
  build: 46,
  displayVersion: 'v1.6.0 (build 46)',
  publishedAt: '2026-09-03T14:41:21.461Z',
};
