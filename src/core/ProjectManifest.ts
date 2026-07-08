export interface AutoloadConfig {
  scriptPath: string;
  singleton: string;
  enabled: boolean;
}

/** Project-level ambient-occlusion default (top of the AO cascade). */
export const PROJECT_AO_MODES = ['off', 'baked', 'realtime', 'adaptive'] as const;
export type ProjectAODefault = (typeof PROJECT_AO_MODES)[number];

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
  metadata?: Record<string, unknown>;
}

export const DEFAULT_PROJECT_MANIFEST_VERSION = '1.0.0';
export const DEFAULT_AMBIENT_OCCLUSION: ProjectAODefault = 'baked';
export const DEFAULT_VIEWPORT_BASE_WIDTH = 1920;
export const DEFAULT_VIEWPORT_BASE_HEIGHT = 1080;
const MIN_VIEWPORT_BASE_SIZE = 64;

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

  return {
    version:
      typeof record.version === 'string' && record.version.trim().length > 0
        ? record.version
        : DEFAULT_PROJECT_MANIFEST_VERSION,
    autoloads,
    defaultExportScenePath: normalizeDefaultExportScenePath(record.defaultExportScenePath),
    viewportBaseSize: normalizeViewportBaseSize(record.viewportBaseSize),
    ambientOcclusion: normalizeAmbientOcclusion(record.ambientOcclusion),
    metadata:
      record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as Record<string, unknown>)
        : {},
  };
};
