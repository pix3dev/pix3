import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';
import wasm from 'vite-plugin-wasm';
import { VitePWA } from 'vite-plugin-pwa';

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
    plugins: [
      wasm(),
      VitePWA({
        registerType: 'autoUpdate',
        // The legacy src/sw.ts is NOT this service worker — generateSW builds
        // its own precache worker; src/sw.ts stays unregistered.
        includeAssets: ['icon.png', 'splash.jpg', 'splash-logo.png', 'menu-logo.png'],
        manifest: {
          name: 'Pix3 Editor',
          short_name: 'Pix3',
          description: 'Browser-based editor for HTML5 games blending 2D and 3D layers.',
          start_url: '.',
          display: 'standalone',
          theme_color: '#1a1a2e',
          background_color: '#1a1a2e',
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,png,jpg,svg,woff2,wasm,glb}'],
          // Background-removal ONNX runtimes (~24 MB each) are an optional,
          // lazily-loaded feature — not worth precaching for offline use.
          globIgnores: ['**/ort-wasm*'],
          // esbuild.wasm (~10 MB) and the three chunk (~19 MB, embeds runtime
          // sources for playable export) must be precached to work offline.
          maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
          // The editor app shell handles its own routing; API/collab traffic must not be cached.
          // player.html carries session query params, so navigation to it must
          // not fall back to the editor shell.
          navigateFallbackDenylist: [/^\/api\//, /^\/collaboration/, /^\/preview/, /^\/openai-proxy/, /^\/zen-proxy/, /^\/cerebras-proxy/, /^\/player\.html/],
        },
      }),
    ],
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
        input: {
          main: resolve(__dirname, 'index.html'),
          player: resolve(__dirname, 'player.html'),
        },
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
        '/preview': {
          target: collabTarget,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
        // OpenAI does not send CORS headers, so the browser cannot call api.openai.com directly
        // (Gemini can). This same-origin dev proxy forwards GPT Image requests; the user's key
        // rides along as the Authorization header. For production, host an equivalent proxy and set
        // VITE_OPENAI_PROXY_URL. See OpenAIImageProvider.
        '/openai-proxy': {
          target: 'https://api.openai.com',
          changeOrigin: true,
          secure: true,
          rewrite: path => path.replace(/^\/openai-proxy/, ''),
        },
        // OpenCode Zen sends no CORS headers at all, so the browser cannot call opencode.ai
        // directly. Same-origin dev proxy mirroring /openai-proxy; the user's key rides along as
        // the Authorization header. For production, host an equivalent proxy and set
        // VITE_OPENCODE_ZEN_PROXY_URL. See OpenCodeZenLlmProvider.
        '/zen-proxy': {
          target: 'https://opencode.ai',
          changeOrigin: true,
          secure: true,
          rewrite: path => path.replace(/^\/zen-proxy/, ''),
        },
        // Cerebras sends no CORS headers, so the browser cannot call api.cerebras.ai directly
        // (a rejected key even surfaces as an opaque CORS/network error rather than a readable 401).
        // Same-origin dev proxy mirroring /openai-proxy; the user's key rides along as the
        // Authorization header. For production, host an equivalent proxy and set
        // VITE_CEREBRAS_PROXY_URL. See CerebrasLlmProvider.
        '/cerebras-proxy': {
          target: 'https://api.cerebras.ai',
          changeOrigin: true,
          secure: true,
          rewrite: path => path.replace(/^\/cerebras-proxy/, ''),
        },
      },
    },
    esbuild: {
      sourcemap: false,
    },
  };
});
