/**
 * Scene ids are derived deterministically from a scene resource path so that the same
 * `.pix3scene` file always maps to the same id — locally, in a cloud copy of the project,
 * and in a share/invite link's `scene` parameter.
 *
 * Keep this the single implementation: `EditorTabService` and `CollabJoinService` both
 * depend on the two sides agreeing.
 */
export function deriveSceneIdFromResourcePath(resourcePath: string): string {
  const withoutScheme = resourcePath
    .replace(/^res:\/\//i, '')
    .replace(/^templ:\/\//i, '')
    .replace(/^collab:\/\//i, '');
  const withoutExtension = withoutScheme.replace(/\.[^./]+$/i, '');
  const normalized = withoutExtension
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || 'scene';
}
