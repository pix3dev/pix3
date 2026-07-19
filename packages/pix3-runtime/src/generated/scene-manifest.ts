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
