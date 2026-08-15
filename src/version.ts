export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.4.0',
  build: 42,
  displayVersion: 'v1.4.0 (build 42)',
  publishedAt: '2026-08-15T15:26:36.498Z',
};
