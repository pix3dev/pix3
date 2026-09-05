/**
 * Hash routes for standalone editor tools — the ones that own the whole window and need no open
 * project, so they can be linked to and cold-loaded (`<editor>/#uikit`).
 *
 * They live here rather than next to the component that renders them because the URL owners
 * (`RouterService`, `WorkspaceModeService`) have to recognise them too, and a service must not
 * import from `src/ui`.
 */

/** UI Kit Forge: generates game-UI sprites (buttons, panels, bars) from a theme. */
export const UIKIT_FORGE_HASH = '#uikit';

/**
 * The tool's own page — a second Vite entry (`tools/uikit-forge.html` + `src/tools/uikit-forge/`),
 * not a `public/` file, so it is typechecked and shares the generator core in
 * `src/services/uikit/`. Usable directly, without the editor shell: the `#uikit` route embeds this
 * same URL in a same-origin iframe.
 */
export const UIKIT_FORGE_URL = '/tools/uikit-forge.html';

/** Every standalone tool route, in the form their hashes take. */
const TOOL_ROUTE_HASHES = [UIKIT_FORGE_HASH];

const matchesRoute = (hash: string, route: string): boolean =>
  hash === route || hash.startsWith(`${route}?`);

/** True when the location asks for the UI Kit Forge route. */
export function isUiKitForgeHash(hash: string): boolean {
  return matchesRoute(hash, UIKIT_FORGE_HASH);
}

/**
 * True while a standalone tool owns the URL. The services that keep the hash in step with editor
 * state check this and stand down — otherwise the next scene/selection change (or a project
 * finishing its open) would silently navigate the user out of the tool.
 */
export function isToolRouteHash(hash: string): boolean {
  return TOOL_ROUTE_HASHES.some(route => matchesRoute(hash, route));
}
