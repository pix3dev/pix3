export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.6.2',
  build: 49,
  displayVersion: 'v1.6.2 (build 49)',
  publishedAt: '2026-09-27T21:15:02.722Z',
};
