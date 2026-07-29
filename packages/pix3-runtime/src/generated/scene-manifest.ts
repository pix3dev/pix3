export const scenePaths: readonly string[] = [];
export const activeScenePath = '';
export const runtimeQuality: {
  readonly antialias: boolean;
  readonly shadows: boolean;
  readonly maxPixelRatio: number;
} = {
  antialias: true,
  shadows: true,
  maxPixelRatio: 2,
};
export const runtimeLocalization: {
  readonly defaultLocale: string;
  readonly fallbackLocale?: string;
  readonly locales: readonly string[];
} | null = null;
/**
 * `kind ↔ prefab` table for multiplayer spawns (plan decision D6). The wire `Kind` is the index
 * into it — `prefabs` first, then the reserved `authored` segment — so the exporter emits it from a
 * deterministic sort and the room's kind allowlist is this table's index set.
 */
export const netKindTable: {
  readonly prefabs: readonly string[];
  readonly authored: readonly string[];
} = {
  prefabs: [],
  authored: [],
};
