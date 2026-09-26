/**
 * Node-only entry point of `@pix3/runtime`: what it takes to hydrate a `.pix3scene` with the real
 * `SceneLoader` in plain Node — no browser, no happy-dom.
 *
 * Used by `pix3 validate` (level 2) and by the runtime's node-profile golden spec. Deliberately NOT
 * re-exported from the package index: it imports `node:fs`, which no browser bundle may reach.
 *
 * Import it as `@pix3/runtime/node`.
 */
export {
  createCanvasOnlyDocument,
  createStub2DContext,
  installCanvasOnlyDocument,
  type CanvasOnlyDocument,
} from './canvas-only-document';
export {
  DiskResourceManager,
  MissingResourceError,
  NodeAssetLoader,
  ResourceNotDecodedError,
  type DiskResourceManagerOptions,
} from './disk-resources';
export { collectLoaderWarnings, type LoaderWarning } from './loader-warnings';
