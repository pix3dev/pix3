export interface AutoloadConfig {
  scriptPath: string;
  singleton: string;
  enabled: boolean;
}

/** Project-level ambient-occlusion default (top of the AO cascade). */
export const PROJECT_AO_MODES = ['off', 'baked', 'realtime', 'adaptive'] as const;
export type ProjectAODefault = (typeof PROJECT_AO_MODES)[number];

export const PROJECT_TYPES = ['2d', '3d'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const TARGET_PLATFORMS = ['mobile', 'desktop', 'universal'] as const;
export type TargetPlatform = (typeof TARGET_PLATFORMS)[number];

/**
 * How 2D graphics are sampled. `linear` smooths on scale (default); `nearest`
 * disables smoothing for crisp pixel-art rendering. Applies to 2D sprite/UI
 * textures only — 3D textures keep their mipmapped linear sampling.
 */
export const TEXTURE_FILTERING_MODES = ['linear', 'nearest'] as const;
export type TextureFiltering = (typeof TEXTURE_FILTERING_MODES)[number];

/** Renderer quality preset applied in play mode and exported builds. */
export interface QualitySettings {
  antialias: boolean;
  shadows: boolean;
  /** Upper bound for the renderer pixel ratio; the device ratio is used when lower. */
  maxPixelRatio: number;
}

export interface ProjectManifest {
  version: string;
  autoloads: AutoloadConfig[];
  defaultExportScenePath?: string;
  viewportBaseSize: {
    width: number;
    height: number;
  };
  /** Default AO mode scenes inherit when their PostProcess is set to `inherit`. */
  ambientOcclusion: ProjectAODefault;
  /** 2D texture sampling: `linear` (smoothed) or `nearest` (crisp pixel-art). */
  textureFiltering: TextureFiltering;
  projectType: ProjectType;
  targetPlatform: TargetPlatform;
  quality: QualitySettings;
  metadata?: Record<string, unknown>;
}

export const DEFAULT_PROJECT_MANIFEST_VERSION = '1.0.0';
export const DEFAULT_AMBIENT_OCCLUSION: ProjectAODefault = 'baked';
export const DEFAULT_TEXTURE_FILTERING: TextureFiltering = 'linear';
export const DEFAULT_VIEWPORT_BASE_WIDTH = 1920;
export const DEFAULT_VIEWPORT_BASE_HEIGHT = 1080;
export const DEFAULT_PROJECT_TYPE: ProjectType = '3d';
export const DEFAULT_TARGET_PLATFORM: TargetPlatform = 'universal';
const MIN_VIEWPORT_BASE_SIZE = 64;
const MIN_PIXEL_RATIO = 1;
const MAX_PIXEL_RATIO = 4;

/** Platform-derived quality defaults; explicit `quality` entries override per field. */
export const createDefaultQualitySettings = (platform: TargetPlatform): QualitySettings => {
  switch (platform) {
    case 'mobile':
      return { antialias: false, shadows: false, maxPixelRatio: 2 };
    case 'desktop':
      return { antialias: true, shadows: true, maxPixelRatio: 3 };
    case 'universal':
      return { antialias: true, shadows: true, maxPixelRatio: 2 };
  }
};

const normalizeViewportBaseSize = (
  input: unknown
): {
  width: number;
  height: number;
} => {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const rawWidth = Number(record.width);
  const rawHeight = Number(record.height);
  const width = Number.isFinite(rawWidth) ? Math.round(rawWidth) : DEFAULT_VIEWPORT_BASE_WIDTH;
  const height = Number.isFinite(rawHeight) ? Math.round(rawHeight) : DEFAULT_VIEWPORT_BASE_HEIGHT;

  return {
    width: Math.max(MIN_VIEWPORT_BASE_SIZE, width),
    height: Math.max(MIN_VIEWPORT_BASE_SIZE, height),
  };
};

const normalizeAmbientOcclusion = (input: unknown): ProjectAODefault => {
  const mode = typeof input === 'string' ? input.toLowerCase() : '';
  return (PROJECT_AO_MODES as readonly string[]).includes(mode)
    ? (mode as ProjectAODefault)
    : DEFAULT_AMBIENT_OCCLUSION;
};

const normalizeTextureFiltering = (input: unknown): TextureFiltering => {
  const mode = typeof input === 'string' ? input.toLowerCase() : '';
  return (TEXTURE_FILTERING_MODES as readonly string[]).includes(mode)
    ? (mode as TextureFiltering)
    : DEFAULT_TEXTURE_FILTERING;
};

const normalizeProjectType = (input: unknown): ProjectType => {
  const value = typeof input === 'string' ? input.toLowerCase() : '';
  return (PROJECT_TYPES as readonly string[]).includes(value)
    ? (value as ProjectType)
    : DEFAULT_PROJECT_TYPE;
};

const normalizeTargetPlatform = (input: unknown): TargetPlatform => {
  const value = typeof input === 'string' ? input.toLowerCase() : '';
  return (TARGET_PLATFORMS as readonly string[]).includes(value)
    ? (value as TargetPlatform)
    : DEFAULT_TARGET_PLATFORM;
};

const normalizeQualitySettings = (input: unknown, platform: TargetPlatform): QualitySettings => {
  const defaults = createDefaultQualitySettings(platform);
  if (!input || typeof input !== 'object') {
    return defaults;
  }

  const record = input as Record<string, unknown>;
  const rawRatio = Number(record.maxPixelRatio);
  const maxPixelRatio = Number.isFinite(rawRatio)
    ? Math.min(MAX_PIXEL_RATIO, Math.max(MIN_PIXEL_RATIO, rawRatio))
    : defaults.maxPixelRatio;

  return {
    antialias: typeof record.antialias === 'boolean' ? record.antialias : defaults.antialias,
    shadows: typeof record.shadows === 'boolean' ? record.shadows : defaults.shadows,
    maxPixelRatio,
  };
};

const normalizeDefaultExportScenePath = (input: unknown): string | undefined => {
  if (typeof input !== 'string') {
    return undefined;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed.startsWith('res://') ? trimmed.slice(6) : trimmed;
};

export const createDefaultProjectManifest = (): ProjectManifest => ({
  version: DEFAULT_PROJECT_MANIFEST_VERSION,
  autoloads: [],
  viewportBaseSize: {
    width: DEFAULT_VIEWPORT_BASE_WIDTH,
    height: DEFAULT_VIEWPORT_BASE_HEIGHT,
  },
  ambientOcclusion: DEFAULT_AMBIENT_OCCLUSION,
  textureFiltering: DEFAULT_TEXTURE_FILTERING,
  projectType: DEFAULT_PROJECT_TYPE,
  targetPlatform: DEFAULT_TARGET_PLATFORM,
  quality: createDefaultQualitySettings(DEFAULT_TARGET_PLATFORM),
  metadata: {},
});

export const normalizeProjectManifest = (input: unknown): ProjectManifest => {
  if (!input || typeof input !== 'object') {
    return createDefaultProjectManifest();
  }

  const record = input as Record<string, unknown>;
  const rawAutoloads = Array.isArray(record.autoloads) ? record.autoloads : [];
  const autoloads: AutoloadConfig[] = [];

  for (const entry of rawAutoloads) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const autoload = entry as Record<string, unknown>;
    const scriptPath = typeof autoload.scriptPath === 'string' ? autoload.scriptPath.trim() : '';
    const singleton = typeof autoload.singleton === 'string' ? autoload.singleton.trim() : '';
    if (!scriptPath || !singleton) {
      continue;
    }

    autoloads.push({
      scriptPath,
      singleton,
      enabled: autoload.enabled !== false,
    });
  }

  const targetPlatform = normalizeTargetPlatform(record.targetPlatform);

  return {
    version:
      typeof record.version === 'string' && record.version.trim().length > 0
        ? record.version
        : DEFAULT_PROJECT_MANIFEST_VERSION,
    autoloads,
    defaultExportScenePath: normalizeDefaultExportScenePath(record.defaultExportScenePath),
    viewportBaseSize: normalizeViewportBaseSize(record.viewportBaseSize),
    ambientOcclusion: normalizeAmbientOcclusion(record.ambientOcclusion),
    textureFiltering: normalizeTextureFiltering(record.textureFiltering),
    projectType: normalizeProjectType(record.projectType),
    targetPlatform,
    quality: normalizeQualitySettings(record.quality, targetPlatform),
    metadata:
      record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as Record<string, unknown>)
        : {},
  };
};
