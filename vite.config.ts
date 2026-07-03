import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';
import wasm from 'vite-plugin-wasm';

export default defineConfig(async ({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const collabTarget = env.VITE_COLLAB_SERVER_URL || 'http://localhost:4001';

  // Enumerate rapier exports at config time so the runtime importmap shim
  // can re-export them without bundling rapier into the main chunk. We use
  // `@dimforge/rapier3d-compat` here purely for export-key introspection
  // because it is plain ESM (no wasm imports), while `@dimforge/rapier3d`
  // ships an ESM-with-wasm bundle that Node cannot evaluate without a
  // bundler. Both packages share the same wasm-bindgen-generated public API,
  // so the compat surface is a faithful proxy for non-compat keys.
  const compatModule = (await import('@dimforge/rapier3d-compat')) as Record<string, unknown>;
  const rapierExportKeys: string[] = Object.keys(compatModule).filter(key => key !== 'default');

  return {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@/core': resolve(__dirname, 'src/core'),
        '@/services': resolve(__dirname, 'src/services'),
        '@/state': resolve(__dirname, 'src/state'),
        '@/fw': resolve(__dirname, 'src/fw'),
        '@pix3/runtime': resolve(__dirname, 'packages/pix3-runtime/src'),
      },
    },
    // `vite-plugin-wasm` handles `import * as wasm from "*.wasm"` used by
    // `@dimforge/rapier3d`. The non-compat package becomes a TLA module after
    // wasm instantiation — our ES2022 build target supports native top-level
    // await, so no TLA polyfill plugin is required.
    plugins: [wasm()],
    define: {
      __PIX3_RAPIER_EXPORT_KEYS__: JSON.stringify(rapierExportKeys),
    },
    optimizeDeps: {
      include: ['three', 'lit', 'valtio', 'yaml', 'golden-layout'],
      esbuildOptions: {
        target: 'es2022',
      },
    },
    build: {
      target: 'es2022',
      sourcemap: 'hidden',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/@dimforge/rapier3d')) return 'rapier';
            if (id.includes('node_modules/three/')) return 'three';
            if (id.includes('packages/pix3-runtime/')) return 'pix3-runtime';
            return undefined;
          },
        },
      },
    },
    // ES worker format is required: the background-removal worker uses dynamic import()
    // (code-splitting) to lazy-load its engine libraries, which the default IIFE format rejects.
    worker: {
      format: 'es',
    },
    server: {
      port: 8123,
      fs: {
        allow: ['..'],
      },
      proxy: {
        '/api': {
          target: collabTarget,
          changeOrigin: true,
          secure: false,
        },
        '/collaboration': {
          target: collabTarget,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
      },
    },
    esbuild: {
      sourcemap: false,
    },
  };
});
