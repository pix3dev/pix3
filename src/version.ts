export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.6.3',
  build: 50,
  displayVersion: 'v1.6.3 (build 50)',
  publishedAt: '2026-10-05T13:28:58.060Z',
};
