/**
 * Which `@pix3/cli` version a configuration written by the editor may pin (plan §5 A, "publish
 * gate for the site entry").
 *
 * Deploying the editor and publishing `@pix3/cli` to npm are separate processes, so the editor's
 * lockstep version may not exist on npm yet — and `npx -y @pix3/cli@<that>` in `.mcp.json` would
 * then fail the moment the agent starts. The editor therefore asks the registry:
 * 1. the lockstep version (the editor's own) is published → pin it;
 * 2. otherwise the registry's `latest` → pin that (a CLI of another version still speaks the
 *    workspace protocol; `pix3 check` reports the version difference);
 * 3. the package or both versions are missing, or the registry cannot be reached → the build's
 *    last confirmed version (`VITE_PIX3_CLI_CONFIRMED_VERSION`, stamped only after a successful
 *    publish) when the registry was unreachable, else nothing: the caller leaves `.mcp.json` out.
 *
 * Note the browser cannot tell "not published" from "offline": npm answers an unknown package with
 * a 404 that carries no CORS header, which `fetch` reports as a network error. Both read as
 * `unavailable`, and the message says both.
 */

export const NPM_REGISTRY_CLI_URL = 'https://registry.npmjs.org/@pix3%2Fcli';

export type CliVersionResolution =
  | { readonly kind: 'lockstep' | 'latest' | 'confirmed'; readonly version: string }
  | { readonly kind: 'unavailable'; readonly reason: 'not-published' | 'unreachable' };

export interface ResolveCliVersionOptions {
  /** The editor's lockstep version. */
  readonly editorVersion: string;
  /** Last version the build confirmed published; used only when the registry is unreachable. */
  readonly confirmedVersion?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface RegistryPackument {
  readonly versions?: Record<string, unknown>;
  readonly 'dist-tags'?: Record<string, unknown>;
}

export const resolvePublishedCliVersion = async (
  options: ResolveCliVersionOptions
): Promise<CliVersionResolution> => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const confirmed = options.confirmedVersion?.trim() || null;
  const unreachable = (): CliVersionResolution =>
    confirmed
      ? { kind: 'confirmed', version: confirmed }
      : { kind: 'unavailable', reason: 'unreachable' };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs ?? 5000) : null;
  let body: RegistryPackument;
  try {
    const response = await fetchImpl(NPM_REGISTRY_CLI_URL, {
      // The abbreviated document: just versions and dist-tags.
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: controller?.signal,
    });
    if (response.status === 404) return { kind: 'unavailable', reason: 'not-published' };
    if (!response.ok) return unreachable();
    body = (await response.json()) as RegistryPackument;
  } catch {
    return unreachable();
  } finally {
    if (timer) clearTimeout(timer);
  }

  const versions = body.versions && typeof body.versions === 'object' ? body.versions : {};
  if (Object.hasOwn(versions, options.editorVersion)) {
    return { kind: 'lockstep', version: options.editorVersion };
  }
  const latest = body['dist-tags']?.latest;
  if (typeof latest === 'string' && Object.hasOwn(versions, latest)) {
    return { kind: 'latest', version: latest };
  }
  return { kind: 'unavailable', reason: 'not-published' };
};

/** The version to pin, or null when `.mcp.json` must be left out. */
export const pinnedCliVersion = (resolution: CliVersionResolution): string | null =>
  resolution.kind === 'unavailable' ? null : resolution.version;
