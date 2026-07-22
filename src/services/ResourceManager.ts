import { inject, injectable } from '@/fw/di';
import { ResourceManager as RuntimeResourceManager } from '@pix3/runtime';
import { ProjectStorageService } from './ProjectStorageService';

const RES_SCHEME = 'res';

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
      } catch {
        // Fallback to network
        return super.readText(this.buildPublicUrl(resource));
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
      } catch {
        // Fallback to network
        return super.readBlob(this.buildPublicUrl(resource));
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
