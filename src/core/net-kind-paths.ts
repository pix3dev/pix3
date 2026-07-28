/**
 * The one place that decides **which project files are spawnable prefabs, and in what order** —
 * plan decision D6.
 *
 * The wire `Kind` is a `u16` index into this list and the room's allowlist is the same index set, so
 * two participants that disagree about the order silently spawn each other's wrong prefab. The
 * exporter (`ProjectBuildService`) bakes the list into a build's manifest; the editor's Play Online
 * session derives it live from the project folder. Both must apply identical rules, which is why
 * neither owns them.
 *
 * Two rules, both load-bearing:
 *
 * - **Sorted by code point, not by locale.** `localeCompare` depends on locale and ICU version; two
 *   machines exporting the same project must not produce different kinds.
 * - **Prefabs only**, by the same convention the exporter has always used: anything under a
 *   `prefabs/` directory, or any `*.prefab` file.
 */

/** True for a path the project treats as a prefab (directory convention or `.prefab` extension). */
export function isPrefabResourcePath(path: string): boolean {
  return /(^|\/)prefabs\//i.test(path) || /\.prefab$/i.test(path);
}

/** True for a prefab file that can actually be instantiated (`.pix3scene` or `.prefab`). */
export function isSpawnablePrefabPath(path: string): boolean {
  return isPrefabResourcePath(path) && /\.(pix3scene|prefab)$/i.test(path);
}

/**
 * Turns project-relative paths into the canonical `netKindTable.prefabs` list: spawnable prefabs
 * only, `res://`-prefixed, sorted by code point. The index of an entry is its wire `Kind`.
 */
export function collectNetKindPrefabPaths(paths: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const path of paths) {
    const normalized = path
      .replace(/\\/g, '/')
      .replace(/^res:\/\//i, '')
      .replace(/^\.\//, '');
    if (isSpawnablePrefabPath(normalized)) {
      unique.add(`res://${normalized}`);
    }
  }

  return [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
