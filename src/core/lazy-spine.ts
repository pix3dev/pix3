import { setSpineModuleLoader, type SpineModule } from '@pix3/runtime';

/**
 * Registers the lazy loader for `@esotericsoftware/spine-threejs` with the
 * runtime.
 *
 * The runtime deliberately does not import Spine itself — it declares the module
 * contract and lets the host provide it (see `setSpineModuleLoader`), which keeps
 * the Spine Runtimes (a separately licensed, ~300 KB dependency) out of every
 * consumer project that never places a `SpineSkeleton2D`.
 *
 * The literal dynamic `import()` below is what lets Vite emit Spine as its own
 * chunk: nothing is downloaded until a scene actually loads a Spine asset.
 *
 * Call this once during startup — both the editor and the exported player do, so
 * edit mode and play mode resolve Spine the same way.
 */
export function registerSpineModuleLoader(): void {
  setSpineModuleLoader(
    () => import('@esotericsoftware/spine-threejs') as unknown as Promise<SpineModule>
  );
}
