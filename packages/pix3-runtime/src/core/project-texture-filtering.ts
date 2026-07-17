/**
 * Project-level 2D texture filtering, stored on a global sink so both the
 * runtime (`configure2DTexture`) and the editor viewport can read it without a
 * shared service instance — mirroring the project AO-default pattern.
 *
 * `linear` smooths textures on scale (the default); `nearest` disables smoothing
 * for crisp pixel-art rendering. Applies to 2D sprite/UI textures only.
 */
export const PROJECT_TEXTURE_FILTERING_MODES = ['linear', 'nearest'] as const;
export type ProjectTextureFiltering = (typeof PROJECT_TEXTURE_FILTERING_MODES)[number];

const PROJECT_TEXTURE_FILTERING_KEY = '__PIX3_PROJECT_TEXTURE_FILTERING__';
const DEFAULT_PROJECT_TEXTURE_FILTERING: ProjectTextureFiltering = 'linear';

export function normalizeProjectTextureFiltering(input: unknown): ProjectTextureFiltering {
  const mode = typeof input === 'string' ? input.toLowerCase() : '';
  return (PROJECT_TEXTURE_FILTERING_MODES as readonly string[]).includes(mode)
    ? (mode as ProjectTextureFiltering)
    : DEFAULT_PROJECT_TEXTURE_FILTERING;
}

export function setProjectTextureFiltering(mode: string): void {
  (globalThis as Record<string, unknown>)[PROJECT_TEXTURE_FILTERING_KEY] =
    normalizeProjectTextureFiltering(mode);
}

export function getProjectTextureFiltering(): ProjectTextureFiltering {
  return normalizeProjectTextureFiltering(
    (globalThis as Record<string, unknown>)[PROJECT_TEXTURE_FILTERING_KEY]
  );
}
