import { ServiceContainer, ServiceLifetime } from '@/fw/di';
import { ResourceManager } from '@/services/assets/ResourceManager';
import { CollaborationService } from '@/services/collab/CollaborationService';
import { AssetUploadService } from '@/services/cloud/AssetUploadService';
import { SceneCRDTBinding } from '@/services/collab/SceneCRDTBinding';
import { CollabViewportOverlayService } from '@/services/collab/CollabViewportOverlayService';
import {
  AssetLoader,
  AudioService,
  InputService,
  SceneLoader,
  SceneManager,
  SceneSaver,
  ScriptRegistry,
} from '@pix3/runtime';

/**
 * Wrappers for Runtime classes to allow DI container instantiation.
 * The DI container expects parameterless constructors for service implementation classes.
 */

class EditorAssetLoader extends AssetLoader {
  constructor() {
    const container = ServiceContainer.getInstance();
    super(
      container.getService<ResourceManager>(container.getOrCreateToken(ResourceManager)),
      container.getService<AudioService>(container.getOrCreateToken(AudioService))
    );
  }
}

class EditorSceneLoader extends SceneLoader {
  constructor() {
    const container = ServiceContainer.getInstance();
    const scriptRegistryToken = container.getOrCreateToken(ScriptRegistry);
    const scriptRegistry = container.getService<ScriptRegistry>(scriptRegistryToken);
    const assetLoaderToken = container.getOrCreateToken(AssetLoader);
    const assetLoader = container.getService<AssetLoader>(assetLoaderToken);
    const resourceManagerToken = container.getOrCreateToken(ResourceManager);
    const resourceManager = container.getService<ResourceManager>(resourceManagerToken);

    super(assetLoader, scriptRegistry, resourceManager);
  }
}

class EditorSceneManager extends SceneManager {
  constructor() {
    const container = ServiceContainer.getInstance();

    const loaderToken = container.getOrCreateToken(SceneLoader);
    const loader = container.getService<SceneLoader>(loaderToken);

    const saverToken = container.getOrCreateToken(SceneSaver);
    const saver = container.getService<SceneSaver>(saverToken);

    super(loader, saver);
  }
}

export function registerRuntimeServices(): void {
  const container = ServiceContainer.getInstance();

  container.addService(
    container.getOrCreateToken(AudioService),
    AudioService,
    ServiceLifetime.Singleton
  );

  // 0. InputService
  container.addService(
    container.getOrCreateToken(InputService),
    InputService,
    ServiceLifetime.Singleton
  );

  // 1. ScriptRegistry (No dependencies)
  container.addService(
    container.getOrCreateToken(ScriptRegistry),
    ScriptRegistry,
    ServiceLifetime.Singleton
  );

  // 2. AssetLoader (Depends on ResourceManager)
  // Register EditorAssetLoader as implementation for AssetLoader interface/token
  container.addService(
    container.getOrCreateToken(AssetLoader),
    EditorAssetLoader,
    ServiceLifetime.Singleton
  );

  // 3. SceneSaver (No dependencies)
  container.addService(
    container.getOrCreateToken(SceneSaver),
    SceneSaver,
    ServiceLifetime.Singleton
  );

  // 4. SceneLoader (Depends on AssetLoader, ScriptRegistry)
  container.addService(
    container.getOrCreateToken(SceneLoader),
    EditorSceneLoader,
    ServiceLifetime.Singleton
  );

  // 5. SceneManager (Depends on SceneLoader, SceneSaver)
  container.addService(
    container.getOrCreateToken(SceneManager),
    EditorSceneManager,
    ServiceLifetime.Singleton
  );

  // 6. CollaborationService
  container.addService(
    container.getOrCreateToken(CollaborationService),
    CollaborationService,
    ServiceLifetime.Singleton
  );

  // 7. AssetUploadService
  container.addService(
    container.getOrCreateToken(AssetUploadService),
    AssetUploadService,
    ServiceLifetime.Singleton
  );

  // 8. SceneCRDTBinding
  container.addService(
    container.getOrCreateToken(SceneCRDTBinding),
    SceneCRDTBinding,
    ServiceLifetime.Singleton
  );

  // 9. CollabViewportOverlayService
  container.addService(
    container.getOrCreateToken(CollabViewportOverlayService),
    CollabViewportOverlayService,
    ServiceLifetime.Singleton
  );

  console.log('[Pix3] Runtime services registered');
}
