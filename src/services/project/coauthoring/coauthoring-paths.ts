/**
 * Path helpers of the co-authoring mode (`.plans/external-agent-authoring.md` §4.3 / §5 C).
 *
 * Every co-authoring service keys its per-file memory by the project-relative path WITHOUT a
 * scheme (`scenes/level.pix3scene`): scene descriptors say `res://scenes/level.pix3scene`, the
 * workspace speaks bare relative paths, and both must land on the same key.
 */

/** Editor-private directory: recovery journal, protected set, merge log, challenge files. */
export const PIX3_INTERNAL_DIRECTORY = '.pix3';
export const RECOVERY_DIRECTORY = `${PIX3_INTERNAL_DIRECTORY}/recovery`;
export const PROTECTED_SET_FILE = `${PIX3_INTERNAL_DIRECTORY}/protected.json`;
/** Agent read confirmations (`pix3 read` / `pix3 ack`): `{ acks: [{ path, sha256, at }] }`. */
export const ACK_FILE = `${PIX3_INTERNAL_DIRECTORY}/ack.json`;
/** One JSON line per merge decision / ack event (plan §4.3 "Видимость для агента"). */
export const MERGE_LOG_FILE = `${PIX3_INTERNAL_DIRECTORY}/merge-log.jsonl`;

/** `res://scenes/a.pix3scene`, `./scenes/a.pix3scene`, `/scenes\\a.pix3scene` → `scenes/a.pix3scene`. */
export function toProjectPath(path: string): string {
  return path
    .replace(/^res:\/\//i, '')
    .replace(/\\+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** True for `.pix3` itself and anything under it (in any spelling of the path). */
export function isPix3InternalPath(path: string): boolean {
  const normalized = toProjectPath(path);
  return (
    normalized === PIX3_INTERNAL_DIRECTORY || normalized.startsWith(`${PIX3_INTERNAL_DIRECTORY}/`)
  );
}

/** Scene-format files the external merge / stabilisation parse check applies to. */
export function isSceneFilePath(path: string): boolean {
  return /\.(?:pix3scene|prefab)$/i.test(path);
}
