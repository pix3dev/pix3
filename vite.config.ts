import { defineConfig, loadEnv, type HttpProxy } from 'vite';
import { resolve } from 'path';
import wasm from 'vite-plugin-wasm';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(async ({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const devBackends = resolveDevBackends(mode, env);
  const routeProxyToDevBackend = (proxy: HttpProxy.ProxyServer) =>
    routeToDevBackend(proxy, devBackends);
  // Dev-only bundle inventory: `ANALYZE=1 npm run build` emits dist/stats.html (treemap).
  // Never runs in a normal build — kept out of the default plugin list entirely.
  const analyzePlugins = process.env.ANALYZE
    ? [(await import('rollup-plugin-visualizer')).visualizer({
        filename: 'dist/stats.html',
        gzipSize: true,
        brotliSize: true,
        template: 'treemap',
      })]
    : [];

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
      /**
       * One three.js, not two — see the same note in `vitest.config.ts`.
       *
       * A second three under `node_modules/@pix3/runtime/node_modules/three` (should npm ever nest
       * one) would make the editor's modules bundle the root copy while every runtime node bundles
       * the nested one: ~500 KiB of duplicate three in the output, and an `instanceof` seam running
       * right through the scene graph.
       */
      dedupe: ['three'],
      alias: {
        '@pix3/collab-document': resolve(__dirname, 'packages/pix3-collab-server/src/shared/scene-crdt-document.ts'),
        '@pix3/collab-protocol': resolve(__dirname, 'packages/pix3-collab-server/src/shared/collaboration-protocol.ts'),
        '@': resolve(__dirname, 'src'),
        '@/core': resolve(__dirname, 'src/core'),
        '@/services': resolve(__dirname, 'src/services'),
        '@/state': resolve(__dirname, 'src/state'),
        '@/fw': resolve(__dirname, 'src/fw'),
        '@pix3/runtime': resolve(__dirname, 'node_modules/@pix3/runtime/src'),
      },
    },
    // `vite-plugin-wasm` handles `import * as wasm from "*.wasm"` used by
    // `@dimforge/rapier3d`. The non-compat package becomes a TLA module after
    // wasm instantiation — our ES2022 build target supports native top-level
    // await, so no TLA polyfill plugin is required.
    plugins: [
      wasm(),
      // Same-origin download proxy for Tripo3D generated GLBs. The model URL is a presigned CDN
      // link on a region-variable `*.tripo3d.com` host that sends NO CORS headers, so the browser
      // cannot fetch it directly. A static Vite `proxy` entry can't target a runtime-variable host,
      // so this streams an allowlisted URL server-side. Dev-only (like `/tripo-proxy`); production
      // routes downloads through the pix3-agent-bridge. SSRF-guarded to Tripo hosts. See
      // TripoModelProvider.downloadGlb.
      {
        name: 'pix3-tripo-download-proxy',
        configureServer(server) {
          server.middlewares.use('/tripo-download', async (req, res) => {
            try {
              const params = new URL(req.url ?? '', 'http://localhost').searchParams;
              const target = params.get('url');
              if (!target) {
                res.statusCode = 400;
                res.end('missing url');
                return;
              }
              let parsed: URL;
              try {
                parsed = new URL(target);
              } catch {
                res.statusCode = 400;
                res.end('bad url');
                return;
              }
              if (parsed.protocol !== 'https:' || !/(^|\.)tripo3d\.com$/i.test(parsed.hostname)) {
                res.statusCode = 403;
                res.end('forbidden host');
                return;
              }
              const upstream = await fetch(target);
              if (!upstream.ok) {
                res.statusCode = upstream.status || 502;
                res.end(`upstream ${upstream.status}`);
                return;
              }
              const buf = Buffer.from(await upstream.arrayBuffer());
              res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'model/gltf-binary');
              res.setHeader('Content-Length', String(buf.length));
              res.end(buf);
            } catch (error) {
              res.statusCode = 500;
              res.end(`proxy error: ${error instanceof Error ? error.message : String(error)}`);
            }
          });
        },
      },
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
          // Background-removal ONNX runtimes (~24 MB each) are an optional, lazily-loaded
          // feature — not worth precaching for offline use. Likewise `assets/export-vendor/**`
          // is ~29 MB of vendor/runtime SOURCE TEXT embedded for playable export (see the
          // `chunkFileNames` comment above) — it is fetched on demand only when the user
          // actually exports a playable build, so precaching it for offline editing is wasted
          // bandwidth/storage. No `runtimeCaching` is configured for it, so exporting a
          // playable while genuinely offline (no network, no prior browser HTTP cache hit for
          // these exact chunks) will fail — that's an accepted tradeoff, not "still works
          // offline": export is expected to run online, unlike the rest of the editor shell.
          globIgnores: ['**/ort-wasm*', '**/export-vendor/**'],
          // esbuild.wasm (~11 MB) must be precached to work offline (in-editor script compile).
          maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
          // The editor app shell handles its own routing; API/collab traffic must not be cached.
          // player.html carries session query params, so navigation to it must
          // not fall back to the editor shell. `/tools/*` are the standalone tool pages
          // (UI Kit Forge): real HTML files, precached, and the `#uikit` route frames the same
          // URL — the navigation route would otherwise hand back the editor shell instead.
          navigateFallbackDenylist: [/^\/api\//, /^\/collaboration/, /^\/preview/, /^\/openai-proxy/, /^\/zen-proxy/, /^\/cerebras-proxy/, /^\/tripo-proxy/, /^\/tripo-download/, /^\/player\.html/, /^\/tools\//],
        },
      }),
      ...analyzePlugins,
    ],
    define: {
      __PIX3_RAPIER_EXPORT_KEYS__: JSON.stringify(rapierExportKeys),
      __PIX3_DEV_BACKENDS__: JSON.stringify(devBackends),
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
          // UI Kit Forge: its own entry rather than a `public/` file, so the page is typechecked
          // and shares the generator core with the editor (`src/services/uikit/`). The path keeps
          // the URL the `#uikit` route frames — `/tools/uikit-forge.html` in dev,
          // `dist/tools/uikit-forge.html` in a build.
          uikitForge: resolve(__dirname, 'tools/uikit-forge.html'),
        },
        output: {
          manualChunks(id) {
            // `?raw`/`?url` glob imports (playable-export vendor sources) are lazy and must NOT
            // be merged into the eagerly-loaded engine chunks below — their ids still contain
            // `node_modules/three/` etc., so guard on the query suffix first.
            if (id.includes('?raw') || id.includes('?url')) return undefined;
            if (id.includes('node_modules/@dimforge/rapier3d')) return 'rapier';
            if (id.includes('node_modules/three/')) return 'three';
            if (id.includes('node_modules/@pix3/runtime/')) return 'pix3-runtime';
            return undefined;
          },
          // `PlayableHtmlBuildService` embeds ~1500 vendor/runtime SOURCE FILES as raw text
          // (`?raw`/`?url` glob imports) for playable export — each becomes its own chunk but
          // is never executed by the editor itself. Routing them into a dedicated folder lets
          // the PWA precache glob below exclude the whole feature in one pattern instead of
          // enumerating chunk names, which are content-hashed and change on every build.
          // NARROW on the same source paths as the `manualChunks` guard above, not just the
          // `?raw`/`?url` query suffix alone — `ProjectTemplateService`'s lazy template/agent-
          // overlay/doc-reference globs use the same query suffix and must stay precached for
          // offline "New Project" (they're unrelated content, not playable-export vendor code).
          chunkFileNames(chunkInfo) {
            const id = chunkInfo.facadeModuleId ?? '';
            const isRawOrUrl = id.includes('?raw') || id.includes('?url');
            const isPlayableExportVendorSource =
              isRawOrUrl &&
              (id.includes('node_modules/three/') ||
                id.includes('node_modules/@dimforge/rapier3d-compat/') ||
                id.includes('node_modules/yaml/') ||
                // Both are embedded as SOURCE for playable export only, and both are
                // big (~620 KiB and ~520 KiB of raw text): precaching them for offline
                // editing would cost more than the whole editor shell.
                id.includes('node_modules/postprocessing/') ||
                id.includes('node_modules/@esotericsoftware/spine-threejs/') ||
                id.includes('node_modules/@pix3/runtime/'));
            return isPlayableExportVendorSource
              ? 'assets/export-vendor/[name]-[hash].js'
              : 'assets/[name]-[hash].js';
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
      // PIX3_NO_HMR=1 disables HMR (no websocket). Without the socket the Vite client can never
      // force a full page reload on ws reconnect — a network flap or system suspend would
      // otherwise kill long-running in-editor agent sessions driven through the debug bridge.
      hmr: env.PIX3_NO_HMR ? false : undefined,
      fs: {
        allow: ['..'],
      },
      proxy: {
        // Target is picked per request from the `pix3-dev-backend` cookie (local vs cloud.pix3.dev),
        // so the backend switcher in the editor needs a page reload, not a dev-server restart.
        '/api': {
          target: devBackends.targets[devBackends.default],
          changeOrigin: true,
          secure: false,
          configure: routeProxyToDevBackend,
        },
        '/collaboration': {
          target: devBackends.targets[devBackends.default],
          changeOrigin: true,
          secure: false,
          ws: true,
          configure: routeProxyToDevBackend,
        },
        '/preview': {
          target: devBackends.targets[devBackends.default],
          changeOrigin: true,
          secure: false,
          ws: true,
          configure: routeProxyToDevBackend,
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
        // Tripo3D (neural image→3D) uses a Bearer-key server API with no CORS headers, so the
        // browser cannot call api.tripo3d.ai directly. Same-origin dev proxy mirroring /zen-proxy;
        // the user's key rides along as the Authorization header. For production, host an equivalent
        // proxy (or route through the pix3-agent-bridge). See TripoModelProvider.
        '/tripo-proxy': {
          target: 'https://api.tripo3d.ai',
          changeOrigin: true,
          secure: true,
          rewrite: path => path.replace(/^\/tripo-proxy/, ''),
        },
      },
    },
    esbuild: {
      sourcemap: false,
    },
  };
});

type DevBackendId = 'local' | 'prod';

interface DevBackends {
  /** Backend used while no `pix3-dev-backend` cookie is set: `dev` → local, `dev:prod` → prod. */
  default: DevBackendId;
  targets: Record<DevBackendId, string>;
}

/** Cookie the editor's backend switcher writes (see `src/core/dev-backend.ts`). */
const DEV_BACKEND_COOKIE = 'pix3-dev-backend';
/**
 * Both backends set their session as `token=` on `localhost:8123`, so without a rename logging in
 * to one would log you out of the other (and send a prod session to the local server). The proxy
 * stores the prod session under this name and swaps it back to `token` on the way out.
 */
const PROD_TOKEN_COOKIE = 'pix3prod_token';

function resolveDevBackends(mode: string, env: Record<string, string>): DevBackends {
  const isProdMode = mode === 'prod-backend';
  const local =
    env.PIX3_LOCAL_BACKEND_URL ||
    (isProdMode ? '' : env.VITE_COLLAB_SERVER_URL) ||
    'http://localhost:4001';
  const prod =
    env.PIX3_PROD_BACKEND_URL ||
    (isProdMode ? env.VITE_COLLAB_SERVER_URL : '') ||
    'https://cloud.pix3.dev';
  return { default: isProdMode ? 'prod' : 'local', targets: { local, prod } };
}

function parseCookieHeader(header: string | string[] | undefined): Array<[string, string]> {
  const raw = Array.isArray(header) ? header.join('; ') : (header ?? '');
  return raw
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      return eq < 0 ? [part, ''] : [part.slice(0, eq), part.slice(eq + 1)];
    });
}

function pickDevBackend(
  req: { headers: Record<string, string | string[] | undefined> },
  backends: DevBackends
): DevBackendId {
  const value = parseCookieHeader(req.headers.cookie).find(
    ([name]) => name === DEV_BACKEND_COOKIE
  )?.[1];
  return value === 'local' || value === 'prod' ? value : backends.default;
}

/** Outgoing `Cookie`: hand the chosen backend its own session as `token`, drop the other one. */
function rewriteRequestCookies(
  cookieHeader: string | string[] | undefined,
  backend: DevBackendId
): string {
  const kept: string[] = [];
  for (const [name, value] of parseCookieHeader(cookieHeader)) {
    if (name === DEV_BACKEND_COOKIE) continue;
    if (backend === 'prod') {
      if (name === 'token') continue;
      kept.push(name === PROD_TOKEN_COOKIE ? `token=${value}` : `${name}=${value}`);
    } else if (name !== PROD_TOKEN_COOKIE) {
      kept.push(`${name}=${value}`);
    }
  }
  return kept.join('; ');
}

/**
 * Re-targets one Vite proxy entry per request. Vite calls `proxy.web(req, res, {})` and
 * `proxy.ws(req, socket, head)`; per-call options are merged over the entry's options by
 * http-proxy-3, so injecting `target` here routes the request without touching Vite internals.
 */
function routeToDevBackend(proxy: HttpProxy.ProxyServer, backends: DevBackends): void {
  type Req = Parameters<HttpProxy.ProxyServer['web']>[0];
  const backendOf = new WeakMap<Req, DevBackendId>();
  const web = proxy.web.bind(proxy) as (...args: unknown[]) => unknown;
  const ws = proxy.ws.bind(proxy) as (...args: unknown[]) => unknown;

  const withTarget = (req: Req, args: unknown[], optsIndex: number): unknown[] => {
    const backend = pickDevBackend(req, backends);
    backendOf.set(req, backend);
    const next = [...args];
    const cb = typeof next[next.length - 1] === 'function' ? next.pop() : undefined;
    const opts = (next[optsIndex] as Record<string, unknown> | undefined) ?? {};
    next.length = optsIndex;
    next.push({ ...opts, target: backends.targets[backend] });
    if (cb) next.push(cb);
    return next;
  };

  (proxy as { web: unknown }).web = (...args: unknown[]) =>
    web(...withTarget(args[0] as Req, args, 2));
  (proxy as { ws: unknown }).ws = (...args: unknown[]) =>
    ws(...withTarget(args[0] as Req, args, 3));

  const onProxyReq = (
    proxyReq: {
      getHeader(name: string): unknown;
      setHeader(name: string, value: string): void;
      removeHeader(name: string): void;
    },
    req: Req
  ) => {
    const backend = backendOf.get(req) ?? pickDevBackend(req, backends);
    const cookie = rewriteRequestCookies(
      proxyReq.getHeader('cookie') as string | string[] | undefined,
      backend
    );
    if (cookie) proxyReq.setHeader('cookie', cookie);
    else proxyReq.removeHeader('cookie');
  };
  proxy.on('proxyReq', onProxyReq);
  proxy.on('proxyReqWs', onProxyReq);

  proxy.on('proxyRes', (proxyRes, req) => {
    if ((backendOf.get(req) ?? pickDevBackend(req, backends)) !== 'prod') return;
    const setCookie = proxyRes.headers['set-cookie'];
    if (!setCookie) return;
    proxyRes.headers['set-cookie'] = setCookie.map(cookie =>
      cookie.startsWith('token=') ? `${PROD_TOKEN_COOKIE}=${cookie.slice('token='.length)}` : cookie
    );
  });
}
