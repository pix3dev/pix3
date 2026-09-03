import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    // happy-dom fetches an iframe's `src` for real, over the network, the moment one is attached
    // to the document. Nothing under test wants a loaded frame — a spec that renders one cares
    // about the element — and the request only fails noisily against a host the runner never
    // serves, so child-frame navigation is off for every spec rather than per file. Note the
    // non-deprecated spelling: the older `disableIframePageLoading` throws a DOMException into
    // stderr instead of quietly leaving the frame empty.
    environmentOptions: {
      happyDOM: { settings: { navigation: { disableChildFrameNavigation: true } } },
    },
    // Repairs the ambient `localStorage` when the Node build hands us an unusable one — see the
    // file for why this is global setup and not a per-spec stub.
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/**/*.spec.ts',
      'packages/pix3-runtime/src/**/*.spec.ts',
      // Server specs opt out of happy-dom per file via `// @vitest-environment node`.
      'packages/pix3-collab-server/src/**/*.spec.ts',
    ],
    // The default 'forks' pool reports "No test suite found" for every spec on
    // win32-arm64 (vitest 4.x); the threads pool runs them fine everywhere.
    pool: 'threads',
    // Uncapped, one worker per core exhausts memory on high-core machines and every
    // file fails with the same "No test suite found" error. Four is plenty: the run
    // is import/environment-bound, not test-bound.
    maxWorkers: 4,
  },
  resolve: {
    /**
     * One three.js, not two.
     *
     * `packages/pix3-runtime` declares `three` as BOTH a peer and a dev dependency, and npm answers
     * that by installing a second copy under `packages/pix3-runtime/node_modules/three` — same
     * version, different module identity. The editor's own modules then resolve the root copy while
     * every runtime node resolves the nested one, so `mesh instanceof THREE.Mesh` is false across
     * the seam: five specs failed with "expected MeshLambertMaterial to be an instance of
     * MeshLambertMaterial", and `play_status` counted zero visible meshes in a scene that had two.
     */
    dedupe: ['three'],
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/components': resolve(__dirname, 'src/components'),
      '@/core': resolve(__dirname, 'src/core'),
      '@/plugins': resolve(__dirname, 'src/plugins'),
      '@/rendering': resolve(__dirname, 'src/rendering'),
      '@/services': resolve(__dirname, 'src/services'),
      '@/state': resolve(__dirname, 'src/state'),
      '@/styles': resolve(__dirname, 'src/styles'),
      '@/fw': resolve(__dirname, 'src/fw'),
      '@pix3/runtime': resolve(__dirname, 'packages/pix3-runtime/src'),
    },
  },
});
