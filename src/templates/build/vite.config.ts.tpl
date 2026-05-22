import { defineConfig, type Plugin } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { viteSingleFile } from 'vite-plugin-singlefile';

interface AssetManifest {
  files: string[];
}

interface EmbeddedAssetEntry {
  readonly base64: string;
  readonly mimeType: string;
}

interface EmbeddedAssetSizeEntry {
  readonly path: string;
  readonly rawBytes: number;
  readonly base64Bytes: number;
}

interface EmbeddedAssetsBuildStats {
  readonly entries: EmbeddedAssetSizeEntry[];
  readonly rawTotalBytes: number;
  readonly base64TotalBytes: number;
}

// Project root is the directory containing this vite.config.ts file.
const projectDir = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(projectDir, 'asset-manifest.json');
const outputHtmlPath = resolve(projectDir, 'dist/index.html');
const EMBEDDED_ASSETS_MODULE_ID = 'virtual:runtime-embedded-assets';
const RESOLVED_EMBEDDED_ASSETS_MODULE_ID = `\0${EMBEDDED_ASSETS_MODULE_ID}`;
let latestEmbeddedAssetsStats: EmbeddedAssetsBuildStats = {
  entries: [],
  rawTotalBytes: 0,
  base64TotalBytes: 0,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatPercent(part: number, whole: number): string {
  if (whole <= 0) {
    return '0.00%';
  }
  return `${((part / whole) * 100).toFixed(2)}%`;
}

function getMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();

  if (lower.endsWith('.pix3scene') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return 'text/plain;charset=utf-8';
  }
  if (lower.endsWith('.json')) {
    return 'application/json;charset=utf-8';
  }
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.glb')) {
    return 'model/gltf-binary';
  }
  if (lower.endsWith('.gltf')) {
    return 'model/gltf+json';
  }

  return 'application/octet-stream';
}

function collectEmbeddedAssets(): {
  readonly embeddedAssets: Record<string, EmbeddedAssetEntry>;
  readonly stats: EmbeddedAssetsBuildStats;
} {
  if (!existsSync(manifestPath)) {
    return {
      embeddedAssets: {},
      stats: {
        entries: [],
        rawTotalBytes: 0,
        base64TotalBytes: 0,
      },
    };
  }

  const raw = readFileSync(manifestPath, 'utf-8');
  const manifest = JSON.parse(raw) as AssetManifest;
  const embeddedAssets: Record<string, EmbeddedAssetEntry> = {};
  const entries: EmbeddedAssetSizeEntry[] = [];

  for (const relPath of manifest.files) {
    const source = resolve(projectDir, relPath);
    const normalizedPath = relPath.replace(/\\\\/g, '/').replace(/^\/+/, '');

    if (!existsSync(source)) {
      console.warn(`[RuntimeBuild] Missing source asset: ${relPath}`);
      continue;
    }

    const fileBytes = readFileSync(source);
    const rawBytes = fileBytes.byteLength;
    const base64 = fileBytes.toString('base64');
    const base64Bytes = Buffer.byteLength(base64, 'utf8');

    embeddedAssets[normalizedPath] = {
      base64,
      mimeType: getMimeType(normalizedPath),
    };

    entries.push({
      path: normalizedPath,
      rawBytes,
      base64Bytes,
    });
  }

  const rawTotalBytes = entries.reduce((sum, entry) => sum + entry.rawBytes, 0);
  const base64TotalBytes = entries.reduce((sum, entry) => sum + entry.base64Bytes, 0);

  return {
    embeddedAssets,
    stats: {
      entries,
      rawTotalBytes,
      base64TotalBytes,
    },
  };
}

function buildEmbeddedAssetsModule(): string {
  const { embeddedAssets, stats } = collectEmbeddedAssets();
  latestEmbeddedAssetsStats = stats;
  return `export const embeddedAssets = ${JSON.stringify(embeddedAssets)};\n`;
}

function embeddedRuntimeAssetsPlugin(): Plugin {
  return {
    name: 'embedded-runtime-assets',
    resolveId(source) {
      if (source === EMBEDDED_ASSETS_MODULE_ID) {
        return RESOLVED_EMBEDDED_ASSETS_MODULE_ID;
      }

      return null;
    },
    load(id) {
      if (id === RESOLVED_EMBEDDED_ASSETS_MODULE_ID) {
        return buildEmbeddedAssetsModule();
      }

      return null;
    },
  };
}

function runtimeBuildSizeReportPlugin(): Plugin {
  return {
    name: 'runtime-build-size-report',
    closeBundle() {
      if (!existsSync(outputHtmlPath)) {
        return;
      }

      if (latestEmbeddedAssetsStats.entries.length === 0 && existsSync(manifestPath)) {
        latestEmbeddedAssetsStats = collectEmbeddedAssets().stats;
      }

      const outputHtmlBytes = statSync(outputHtmlPath).size;
      const rawAssetsBytes = latestEmbeddedAssetsStats.rawTotalBytes;
      const base64AssetsBytes = latestEmbeddedAssetsStats.base64TotalBytes;
      const base64ExpansionBytes = Math.max(0, base64AssetsBytes - rawAssetsBytes);
      const codeAndWrapperBytes = Math.max(0, outputHtmlBytes - base64AssetsBytes);

      console.log('[RuntimeBuild] Size distribution report');
      console.log(`  Output HTML: ${formatBytes(outputHtmlBytes)} (${outputHtmlBytes} bytes)`);
      console.log(
        `  Embedded assets (raw): ${formatBytes(rawAssetsBytes)} (${formatPercent(rawAssetsBytes, outputHtmlBytes)} of output)`
      );
      console.log(
        `  Embedded assets (base64 payload): ${formatBytes(base64AssetsBytes)} (${formatPercent(base64AssetsBytes, outputHtmlBytes)} of output)`
      );
      console.log(
        `  Base64 expansion overhead: +${formatBytes(base64ExpansionBytes)} (${formatPercent(base64ExpansionBytes, outputHtmlBytes)} of output)`
      );
      console.log(
        `  JS/HTML + metadata wrapper: ${formatBytes(codeAndWrapperBytes)} (${formatPercent(codeAndWrapperBytes, outputHtmlBytes)} of output)`
      );

      const sortedEntries = [...latestEmbeddedAssetsStats.entries].sort(
        (left, right) => right.rawBytes - left.rawBytes
      );

      if (sortedEntries.length > 0) {
        console.log('  Embedded assets by source size:');
        for (const entry of sortedEntries) {
          console.log(
            `    - ${entry.path}: ${formatBytes(entry.rawBytes)} raw -> ${formatBytes(entry.base64Bytes)} base64`
          );
        }
      }
    },
  };
}

function classicScriptCompatibilityPlugin(): Plugin {
  return {
    name: 'classic-script-compatibility',
    closeBundle() {
      if (!existsSync(outputHtmlPath)) {
        return;
      }

      const originalHtml = readFileSync(outputHtmlPath, 'utf-8');
      let compatibleHtml = originalHtml
        .replace(/<script\b([^>]*)>/gi, (_match, attrs: string) => {
          const cleanedAttrs = attrs
            .replace(/\s+type=(['"])module\1/gi, '')
            .replace(/\s+crossorigin(?:=(['"]).*?\1)?/gi, '');

          return `<script${cleanedAttrs}>`;
        })
        .replace(/\bimport\.meta\.url\b/g, 'document.baseURI');

      const headOpenMatch = /<head>/i.exec(compatibleHtml);
      const headCloseMatch = /<\/head>/i.exec(compatibleHtml);
      const bodyOpenMatch = /<body\b[^>]*>/i.exec(compatibleHtml);

      if (headOpenMatch && headCloseMatch && bodyOpenMatch) {
        const headContentStart = headOpenMatch.index + headOpenMatch[0].length;
        const headContentEnd = headCloseMatch.index;
        const bodyCloseIndex = compatibleHtml
          .toLowerCase()
          .indexOf('</body>', bodyOpenMatch.index + bodyOpenMatch[0].length);

        if (bodyCloseIndex === -1) {
          throw new Error('Failed to locate </body> while rewriting classic script output.');
        }

        const headContent = compatibleHtml.slice(headContentStart, headContentEnd);
        const headScripts = headContent.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];

        if (headScripts.length > 0) {
          let nextHeadContent = headContent;
          for (const scriptTag of headScripts) {
            nextHeadContent = nextHeadContent.replace(scriptTag, '');
          }

          compatibleHtml =
            compatibleHtml.slice(0, headContentStart) +
            nextHeadContent +
            compatibleHtml.slice(headContentEnd, bodyCloseIndex) +
            `${headScripts.join('\n')}\n` +
            compatibleHtml.slice(bodyCloseIndex);
        }
      }

      if (compatibleHtml !== originalHtml) {
        writeFileSync(outputHtmlPath, compatibleHtml, 'utf-8');
      }
    },
  };
}

export default defineConfig({
  root: projectDir,
  base: './',
  resolve: {
    alias: [
      {
        find: /^three$/,
        replacement: resolve(projectDir, 'node_modules/three/build/three.module.js'),
      },
    ],
    dedupe: ['three'],
  },
  build: {
    outDir: resolve(projectDir, 'dist'),
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [
    embeddedRuntimeAssetsPlugin(),
    viteSingleFile(),
    classicScriptCompatibilityPlugin(),
    runtimeBuildSizeReportPlugin(),
  ],
});