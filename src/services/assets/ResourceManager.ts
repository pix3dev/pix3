import { inject, injectable } from '@/fw/di';
import { ResourceManager as RuntimeResourceManager } from '@pix3/runtime';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';

const RES_SCHEME = 'res';

/**
 * A dev/preview server answers unknown paths with the SPA shell (HTTP 200 + index.html) instead of
 * a 404, so an HTML document coming back from the public-URL fallback means the resource simply is
 * not there. Detecting it keeps downstream parsers from reporting nonsense — a missing scene used
 * to surface as a YAML error about `<!doctype html>` rather than "file not found".
 */
const SPA_FALLBACK_HTML = /^\s*<(?:!doctype\s+html|html[\s>])/i;

const missingResource = (resource: string, cause: unknown): Error =>
  new Error(`Resource not found: ${resource}`, { cause });

@injectable()
class EditorResourceManager extends RuntimeResourceManager {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  constructor() {
    super();
  }

  override async readText(resource: string): Promise<string> {
    const scheme = this.getScheme(resource);

    if (scheme === RES_SCHEME) {
      const path = resource.startsWith('res://') ? resource.substring(6) : resource;
      try {
        return await this.storage.readTextFile(path);
      } catch (error) {
        // Fallback to network: some resources (templates, bundled sample assets) are served from
        // /public rather than the project directory.
        let text: string;
        try {
          text = await super.readText(this.buildPublicUrl(resource));
        } catch {
          throw missingResource(resource, error);
        }
        if (SPA_FALLBACK_HTML.test(text)) {
          throw missingResource(resource, error);
        }
        return text;
      }
    }

    return super.readText(resource);
  }

  override async readBlob(resource: string): Promise<Blob> {
    const scheme = this.getScheme(resource);

    if (scheme === RES_SCHEME) {
      const path = resource.startsWith('res://') ? resource.substring(6) : resource;
      try {
        return await this.storage.readBlob(path);
      } catch (error) {
        // Fallback to network (see readText).
        let blob: Blob;
        try {
          blob = await super.readBlob(this.buildPublicUrl(resource));
        } catch {
          throw missingResource(resource, error);
        }
        if (blob.type.startsWith('text/html')) {
          throw missingResource(resource, error);
        }
        return blob;
      }
    }

    return super.readBlob(resource);
  }

  override normalize(resource: string): string {
    const scheme = this.getScheme(resource);
    if (scheme === RES_SCHEME) {
      return this.storage.normalizeResourcePath(resource);
    }
    return super.normalize(resource);
  }

  private buildPublicUrl(relativePath: string): string {
    const envBase = import.meta.env.BASE_URL ?? '/';
    const base = envBase.replace(/\/*$/, '/');
    const path = relativePath.startsWith('res://') ? relativePath.substring(6) : relativePath;
    const trimmedPath = path.replace(/^\/+/, '');
    return `${base}${trimmedPath}`;
  }
}

// Re-export as ResourceManager for the rest of the app
export { EditorResourceManager as ResourceManager };
