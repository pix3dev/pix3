/**
 * Project-level 2D texture filtering, stored on a global sink so both the
 * runtime (`configure2DTexture`) and the editor viewport can read it without a
 * shared service instance — mirroring the project AO-default pattern.
 *
 * `linear` smooths textures on scale (the default); `nearest` disables smoothing
 * for crisp pixel-art rendering. Applies to 2D sprite/UI textures only.
 */
export declare const PROJECT_TEXTURE_FILTERING_MODES: readonly ["linear", "nearest"];
export type ProjectTextureFiltering = (typeof PROJECT_TEXTURE_FILTERING_MODES)[number];
export declare function normalizeProjectTextureFiltering(input: unknown): ProjectTextureFiltering;
export declare function setProjectTextureFiltering(mode: string): void;
export declare function getProjectTextureFiltering(): ProjectTextureFiltering;
