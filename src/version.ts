export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: "1.0.0",
  build: 37,
  displayVersion: "v1.0.0 (build 37)",
  publishedAt: "2026-07-20T21:04:57.548Z",
};
