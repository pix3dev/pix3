export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.5.0',
  build: 45,
  displayVersion: 'v1.5.0 (build 45)',
  publishedAt: '2026-09-02T19:43:27.256Z',
};
