import { injectable, ServiceContainer } from '@/fw/di';
import { CollaborationService } from '@/services/collab/CollaborationService';

export interface AssetUploadResult {
  serverUrl: string;
  storedName: string;
  originalName: string;
}

@injectable()
export class AssetUploadService {
  private get collabService(): CollaborationService {
    const container = ServiceContainer.getInstance();
    return container.getService<CollaborationService>(
      container.getOrCreateToken(CollaborationService)
    );
  }

  async uploadAsset(projectId: string, file: File): Promise<AssetUploadResult> {
    const baseUrl = this.collabService.getServerBaseUrl();
    const formData = new FormData();
    formData.append('files', file);

    const response = await fetch(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/assets`,
      { method: 'POST', body: formData }
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error((error as { error?: string }).error || `Upload failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      files: Array<{ url: string; storedName: string; originalName: string }>;
    };
    const uploaded = result.files[0];
    return {
      serverUrl: `${baseUrl}${uploaded.url}`,
      storedName: uploaded.storedName,
      originalName: uploaded.originalName,
    };
  }

  async isAssetAvailable(url: string): Promise<boolean> {
    try {
      const resp = await fetch(url, { method: 'HEAD' });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
