export interface EditorVersionInfo {
  version: string;
  build: number;
  displayVersion: string;
  publishedAt?: string;
}

export const CURRENT_EDITOR_VERSION: EditorVersionInfo = {
  version: "0.8.9",
  build: 35,
  displayVersion: "v0.8.9 (build 35)",
  publishedAt: "2026-06-21T21:24:05.949Z",
};
