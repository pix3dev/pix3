/**
 * Test-only entry point for `@pix3/runtime`.
 *
 * Deliberately NOT re-exported from the package index: a game bundle must never pull this in, and
 * the single-file export decides what ships by scanning for mentioned identifiers, so an
 * always-reachable testing module would pin whatever it touches into every playable.
 *
 * Import it as `@pix3/runtime/testing`.
 */
export { installCanvas2DStub, type Canvas2DStubHandle } from './canvas-2d-stub';
export { createHeadlessGame, type HeadlessGame, type HeadlessGameOptions } from './headless-game';
