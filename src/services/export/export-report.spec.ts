import { describe, expect, it } from 'vitest';

import {
  buildAssetProvenanceItems,
  buildInclusionSummaryLines,
  formatExportBytes,
  summarizeInclusionReasons,
} from '@/services/export/export-report';
import type { AssetReachabilityEntry } from '@/services/export/ProjectBuildService';

const reachability = new Map<string, AssetReachabilityEntry>([
  ['scenes/main.pix3scene', { reason: 'project-scene', via: '' }],
  ['textures/hero.png', { reason: 'scene-reference', via: 'scenes/main.pix3scene' }],
  ['frames/a.png', { reason: 'directory-expansion', via: 'frames' }],
  ['frames/b.png', { reason: 'directory-expansion', via: 'frames' }],
]);

describe('summarizeInclusionReasons', () => {
  it('groups by reason and orders the heaviest first', () => {
    const rows = summarizeInclusionReasons(reachability, [
      { path: 'scenes/main.pix3scene', rawBytes: 500 },
      { path: 'textures/hero.png', rawBytes: 4_000 },
      { path: 'frames/a.png', rawBytes: 10_000 },
      { path: 'frames/b.png', rawBytes: 10_000 },
    ]);

    expect(rows).toEqual([
      { reason: 'directory-expansion', count: 2, bytes: 20_000 },
      { reason: 'scene-reference', count: 1, bytes: 4_000 },
      { reason: 'project-scene', count: 1, bytes: 500 },
    ]);
  });

  it('falls back to counts when no sizes are available', () => {
    const rows = summarizeInclusionReasons(reachability);

    expect(rows).toEqual([
      { reason: 'directory-expansion', count: 2, bytes: 0 },
      { reason: 'project-scene', count: 1, bytes: 0 },
      { reason: 'scene-reference', count: 1, bytes: 0 },
    ]);
  });

  it('ignores sizes for paths outside the graph', () => {
    const rows = summarizeInclusionReasons(
      new Map<string, AssetReachabilityEntry>([
        ['textures/hero.png', { reason: 'scene-reference', via: 'scenes/main.pix3scene' }],
      ]),
      [
        { path: 'textures/hero.png', rawBytes: 100 },
        { path: 'not/in/graph.png', rawBytes: 999_999 },
      ]
    );

    expect(rows).toEqual([{ reason: 'scene-reference', count: 1, bytes: 100 }]);
  });

  it('returns nothing for an empty graph', () => {
    expect(summarizeInclusionReasons(new Map())).toEqual([]);
  });
});

describe('buildInclusionSummaryLines', () => {
  it('renders readable labels with counts and sizes', () => {
    const lines = buildInclusionSummaryLines([
      { reason: 'directory-expansion', count: 2, bytes: 20_480 },
      { reason: 'project-scene', count: 1, bytes: 0 },
    ]);

    expect(lines).toEqual([
      '  Whole directory pulled in by a dynamic path: 2 files, 20.00 KiB',
      '  Project scenes and prefabs: 1 file',
    ]);
  });
});

describe('buildAssetProvenanceItems', () => {
  it('names what referenced each asset', () => {
    const items = buildAssetProvenanceItems(
      [
        { path: 'textures/hero.png', rawBytes: 2_048 },
        { path: 'scenes/main.pix3scene', rawBytes: 512 },
      ],
      reachability
    );

    expect(items).toEqual([
      'textures/hero.png: 2.00 KiB [Referenced by a scene or prefab <- scenes/main.pix3scene]',
      // A root has no referrer, so no arrow.
      'scenes/main.pix3scene: 512 B [Project scenes and prefabs]',
    ]);
  });

  it('degrades gracefully for an asset missing from the graph', () => {
    const items = buildAssetProvenanceItems([{ path: 'stray.png', rawBytes: 10 }], new Map());

    expect(items).toEqual(['stray.png: 10 B']);
  });

  it('supports a custom size formatter that sees the original entry', () => {
    const items = buildAssetProvenanceItems(
      [{ path: 'textures/hero.png', rawBytes: 2_048, base64Bytes: 2_732 }],
      reachability,
      entry =>
        `${formatExportBytes(entry.rawBytes)} raw -> ${formatExportBytes(entry.base64Bytes)} base64`
    );

    expect(items).toEqual([
      'textures/hero.png: 2.00 KiB raw -> 2.67 KiB base64 [Referenced by a scene or prefab <- scenes/main.pix3scene]',
    ]);
  });
});
