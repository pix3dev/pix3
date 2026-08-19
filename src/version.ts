export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: '1.4.1',
  build: 44,
  displayVersion: 'v1.4.1 (build 44)',
  publishedAt: '2026-08-18T23:48:09.493Z',
};
