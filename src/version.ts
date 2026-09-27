export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.6.1',
  build: 48,
  displayVersion: 'v1.6.1 (build 48)',
  publishedAt: '2026-09-27T16:29:11.202Z',
};
