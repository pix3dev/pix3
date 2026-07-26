import type {
  AssetInclusionReason,
  AssetReachabilityEntry,
} from '@/services/export/ProjectBuildService';

/**
 * Human-facing formatting of an export's asset provenance.
 *
 * The collector is deliberately over-inclusive (a game can load any scene or
 * build any asset path at runtime, so the static scan errs toward shipping too
 * much). That is only defensible if an author can *see* what it decided: these
 * helpers turn `RuntimeProjectBuildModel.reachability` into a per-reason byte
 * breakdown — which is where "why is this bundle 8 MB?" actually gets answered —
 * and into per-asset lines naming what pulled each file in.
 */

export interface AssetSizeLike {
  readonly path: string;
  readonly rawBytes: number;
}

export interface InclusionReasonSummaryRow {
  readonly reason: AssetInclusionReason;
  readonly count: number;
  readonly bytes: number;
}

const REASON_LABELS: Record<AssetInclusionReason, string> = {
  'project-scene': 'Project scenes and prefabs',
  'entry-scene': 'Entry scene',
  'extra-root': 'Declared as an extra export root',
  'scene-reference': 'Referenced by a scene or prefab',
  'script-reference': 'Referenced by a project script',
  'directory-expansion': 'Whole directory pulled in by a dynamic path',
  'atlas-page': 'Spine atlas page images',
  'locale-table': 'Locale tables',
  'locale-sprite': 'Localized sprite variants',
  'include-glob': 'Forced in by export includeGlobs',
};

export const describeInclusionReason = (reason: AssetInclusionReason): string =>
  REASON_LABELS[reason] ?? reason;

export const formatExportBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KiB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
};

/**
 * Group the reachability graph by reason, heaviest first. `assetSizes` is
 * optional: without it the rows carry counts only (`bytes` stays 0).
 */
export const summarizeInclusionReasons = (
  reachability: ReadonlyMap<string, AssetReachabilityEntry>,
  assetSizes: readonly AssetSizeLike[] = []
): InclusionReasonSummaryRow[] => {
  const bytesByPath = new Map(assetSizes.map(entry => [entry.path, entry.rawBytes]));
  const counts = new Map<AssetInclusionReason, { count: number; bytes: number }>();

  for (const [path, entry] of reachability) {
    const bucket = counts.get(entry.reason) ?? { count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += bytesByPath.get(path) ?? 0;
    counts.set(entry.reason, bucket);
  }

  return Array.from(counts.entries())
    .map(([reason, bucket]) => ({ reason, count: bucket.count, bytes: bucket.bytes }))
    .sort((left, right) => {
      if (right.bytes !== left.bytes) {
        return right.bytes - left.bytes;
      }
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      return left.reason.localeCompare(right.reason);
    });
};

/** Indented `Reason: N files, X MiB` lines for a confirmation dialog body. */
export const buildInclusionSummaryLines = (rows: readonly InclusionReasonSummaryRow[]): string[] =>
  rows.map(row => {
    const files = `${row.count} file${row.count === 1 ? '' : 's'}`;
    const size = row.bytes > 0 ? `, ${formatExportBytes(row.bytes)}` : '';
    return `  ${describeInclusionReason(row.reason)}: ${files}${size}`;
  });

/**
 * Per-asset provenance lines for the dialog's expandable list, biggest first
 * (the input order is preserved — callers pass an already-sorted list).
 */
export const buildAssetProvenanceItems = <TEntry extends AssetSizeLike>(
  assetSizes: readonly TEntry[],
  reachability: ReadonlyMap<string, AssetReachabilityEntry>,
  formatSize: (entry: TEntry) => string = entry => formatExportBytes(entry.rawBytes)
): string[] =>
  assetSizes.map(entry => {
    const provenance = reachability.get(entry.path);
    if (!provenance) {
      return `${entry.path}: ${formatSize(entry)}`;
    }

    const via = provenance.via ? ` <- ${provenance.via}` : '';
    return `${entry.path}: ${formatSize(entry)} [${describeInclusionReason(provenance.reason)}${via}]`;
  });
