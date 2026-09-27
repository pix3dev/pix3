import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

import type { TargetPlatform, TemplateInfo } from './templates.ts';

export const PROJECT_MANIFEST_FILE = 'pix3project.yaml';

/**
 * Where the stable project id lives: `metadata.projectId`.
 *
 * Not a top-level `id` — the editor's `normalizeProjectManifest` keeps only the fields it knows and
 * `ProjectService.saveProjectManifest` rewrites the file from that, so a top-level key would be
 * erased the first time a human saved Project Settings. `metadata` is round-tripped verbatim.
 * The editor uses the same key (`PROJECT_ID_METADATA_KEY` in `src/core/ProjectManifest.ts`): it
 * mints one when it creates a project and backfills it once when it opens a project without one.
 * (`appState.project.id` is something else — a per-open session UUID for "Recent projects".)
 */
const PROJECT_ID_METADATA_KEY = 'projectId';

const MANIFEST_VERSION = '1.0.0';

const qualityFor = (platform: TargetPlatform) => {
  switch (platform) {
    case 'mobile':
      return { antialias: false, shadows: false, maxPixelRatio: 2 };
    case 'desktop':
      return { antialias: true, shadows: true, maxPixelRatio: 3 };
    case 'universal':
      return { antialias: true, shadows: true, maxPixelRatio: 2 };
  }
};

export const createProjectId = (): string => randomUUID();

/**
 * The manifest payload exactly as the editor writes it for a new project from `template`:
 * `ProjectLifecycleService.createManifest` (template defaults from the create dialog) serialised
 * through `ProjectService.saveProjectManifest` (same key order, `stringify(..., { indent: 2 })`).
 */
export const buildManifestPayload = (
  template: TemplateInfo,
  options: { readonly projectName: string; readonly projectId: string }
): Record<string, unknown> => ({
  version: MANIFEST_VERSION,
  // `undefined` is dropped by the YAML stringifier, as it is in the editor.
  defaultExportScenePath: template.entryScenePath,
  viewportBaseSize: {
    width: Math.max(64, template.viewport.width),
    height: Math.max(64, template.viewport.height),
  },
  ambientOcclusion: 'baked',
  textureFiltering: 'linear',
  projectType: template.projectType,
  targetPlatform: template.targetPlatform,
  quality: qualityFor(template.targetPlatform),
  metadata: {
    projectName: options.projectName,
    templateId: template.id,
    [PROJECT_ID_METADATA_KEY]: options.projectId,
  },
  autoloads: [],
});

export const renderManifest = (payload: Record<string, unknown>): string =>
  stringify(payload, { indent: 2 });

/** Nearest ancestor (inclusive) of `start` that holds a `pix3project.yaml`, or null. */
export const findProjectRoot = (start: string): string | null => {
  let current = resolve(start);
  for (;;) {
    try {
      readFileSync(join(current, PROJECT_MANIFEST_FILE));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
};

/** `metadata.projectId` of the manifest in `projectDir` (top-level `id` accepted as a fallback). */
export const readProjectId = (projectDir: string): string | null => {
  try {
    const parsed = parse(readFileSync(join(projectDir, PROJECT_MANIFEST_FILE), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const metadata =
      record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as Record<string, unknown>)
        : {};
    const fromMetadata = metadata[PROJECT_ID_METADATA_KEY];
    if (typeof fromMetadata === 'string' && fromMetadata.trim()) return fromMetadata.trim();
    return typeof record.id === 'string' && record.id.trim() ? record.id.trim() : null;
  } catch {
    return null;
  }
};
