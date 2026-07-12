import { ResourceManager } from '@pix3/runtime';
import type { PreviewFileProvider } from './PreviewPlayerClient';

/**
 * ResourceManager for the standalone preview player: every `res://` read is
 * routed to the editor host through the preview relay instead of fetching
 * from the site origin. Non-res URLs (http, blob, data) keep the default
 * fetch behaviour.
 */
export class RemoteResourceManager extends ResourceManager {
  private readonly provider: PreviewFileProvider;

  constructor(provider: PreviewFileProvider) {
    super('/');
    this.provider = provider;
  }

  override async readText(resource: string): Promise<string> {
    const path = this.toRelayPath(resource);
    if (path === null) {
      return super.readText(resource);
    }

    const bytes = await this.provider.readFile(path);
    return new TextDecoder().decode(bytes);
  }

  override async readBlob(resource: string): Promise<Blob> {
    const path = this.toRelayPath(resource);
    if (path === null) {
      return super.readBlob(resource);
    }

    const file = await this.provider.readFileWithMeta(path);
    const bytes = new Uint8Array(file.bytes.byteLength);
    bytes.set(file.bytes);
    return new Blob([bytes], { type: file.mimeType });
  }

  /** res:// and bare relative paths go through the relay; absolute URLs do not. */
  private toRelayPath(resource: string): string | null {
    const trimmed = resource.trim();
    if (/^res:\/\//i.test(trimmed)) {
      return trimmed.replace(/^res:\/\//i, '').replace(/^\/+/, '');
    }

    if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      return trimmed.replace(/^\/+/, '');
    }

    return null;
  }
}
