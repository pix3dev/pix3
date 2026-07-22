import { parse } from 'yaml';

import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';

import * as ApiClient from '@/services/cloud/ApiClient';
import {
  ApiClientError,
  PROJECT_UPLOAD_FILE_SIZE_LIMIT_BYTES,
  formatUploadLimitBytes,
  type ManifestEntry,
} from '@/services/cloud/ApiClient';
import { CloudProjectService } from '@/services/cloud/CloudProjectService';
import { DialogService } from '@/services/editor/DialogService';
import { FileSystemAPIService } from '@/services/project/FileSystemAPIService';
import { LoggingService } from '@/services/core/LoggingService';
import { ProjectService } from '@/services/project/ProjectService';

interface FileHashEntry {
  readonly hash: string;
  readonly modified: number;
  readonly size: number;
}

interface SyncSkippedEntry {
  readonly path: string;
  readonly size: number | null;
  readonly reason: string;
}

interface SyncProgressState {
  processedFileCount: number;
  totalFileCount: number;
}

interface HybridLinkRecord {
  readonly cloudProjectId: string;
  readonly localSessionId: string;
  readonly localProjectName: string;
  readonly localAbsolutePath: string | null;
  readonly lastSyncAt: number | null;
}

interface SyncPlan {
  readonly uploadToCloud: string[];
  readonly downloadToLocal: string[];
  readonly deleteFromCloud: string[];
  readonly deleteFromLocal: string[];
  readonly conflicts: string[];
  readonly unchanged: string[];
}

interface PreparedCurrentSync {
  readonly link: HybridLinkRecord;
  readonly localHandle: FileSystemDirectoryHandle;
  readonly localManifest: Map<string, FileHashEntry>;
  readonly cloudManifest: Map<string, ManifestEntry>;
  readonly baseline: Map<string, string>;
  readonly plan: SyncPlan;
}

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  conflicts: string[];
  unchanged: string[];
  skipped: SyncSkippedEntry[];
}

const HYBRID_LINKS_KEY = 'pix3.hybridLinks:v1';
const HYBRID_BASELINE_PREFIX = 'pix3.hybridBaseline:v1:';
const HYBRID_METADATA_KEY = 'pix3Hybrid';
const PROJECT_MANIFEST_PATH = 'pix3project.yaml';

const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const IGNORED_FILE_NAMES = new Set(['.DS_Store']);
const LOCAL_MAPPING_SEED_FILE_NAMES = new Set([
  '.gitattributes',
  '.gitignore',
  '.gitkeep',
  '.gitmodules',
]);

@injectable()
export class LocalSyncService {
  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(FileSystemAPIService)
  private readonly fileSystem!: FileSystemAPIService;

  @inject(CloudProjectService)
  private readonly cloudProjectService!: CloudProjectService;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  private lastPromptSignature: string | null = null;

  async handleProjectActivated(): Promise<void> {
    const prepared = await this.refreshCurrentProjectStatus();
    if (!prepared || appState.project.backend !== 'local') {
      return;
    }

    await this.promptForPendingLocalHybridSync(prepared);
  }

  async refreshCurrentProjectStatus(): Promise<PreparedCurrentSync | null> {
    const projectId = appState.project.id;
    const backend = appState.project.backend;
    const projectStatus = appState.project.status;

    if (!projectId || projectStatus !== 'ready') {
      this.applyHybridState(null, {
        status: 'unlinked',
        lastSyncAt: null,
        errorMessage: null,
        localChangeCount: 0,
        cloudChangeCount: 0,
        conflictCount: 0,
        processedFileCount: 0,
        totalFileCount: 0,
        issues: [],
      });
      return null;
    }

    const link = this.resolveCurrentLink();
    if (!link) {
      this.applyHybridState(null, {
        status: 'unlinked',
        lastSyncAt: null,
        errorMessage: null,
        localChangeCount: 0,
        cloudChangeCount: 0,
        conflictCount: 0,
        processedFileCount: 0,
        totalFileCount: 0,
        issues: [],
      });
      this.projectService.syncProjectMetadata();
      return null;
    }

    this.applyHybridState(link, {
      status: 'checking',
      errorMessage: null,
      issues: [],
      processedFileCount: 0,
      totalFileCount: 0,
    });

    try {
      const localHandle = await this.resolveLinkedLocalHandle(link, {
        promptForPermission: false,
      });

      if (!localHandle) {
        this.applyHybridState(link, {
          status: 'error',
          errorMessage: 'Reconnect the linked local folder to continue syncing.',
          localChangeCount: 0,
          cloudChangeCount: 0,
          conflictCount: 0,
          processedFileCount: 0,
          totalFileCount: 0,
          issues: [],
        });
        this.projectService.syncProjectMetadata();
        return null;
      }

      if (backend === 'local' && !appState.auth.isAuthenticated) {
        this.applyHybridState(link, {
          status: 'auth-required',
          errorMessage: 'Sign in to compare this local project with the cloud version.',
          localChangeCount: 0,
          cloudChangeCount: 0,
          conflictCount: 0,
          processedFileCount: 0,
          totalFileCount: 0,
          issues: [],
        });
        this.projectService.syncProjectMetadata();
        return null;
      }

      const [localManifest, cloudManifest] = await Promise.all([
        this.buildLocalManifest(localHandle),
        this.getCloudManifest(link.cloudProjectId),
      ]);
      const baseline = this.readBaseline(link);
      const plan = this.createSyncPlan(localManifest, cloudManifest, baseline);
      const status = this.getPlanStatus(plan);
      const oversizeEntries = this.getOversizeLocalEntries(localManifest, plan);
      const issues =
        oversizeEntries.length > 0
          ? oversizeEntries
          : status === 'local-changes' && appState.project.hybridSync.issues.length > 0
            ? appState.project.hybridSync.issues
            : [];

      this.applyHybridState(link, {
        status,
        errorMessage: this.buildIssuesSummary(issues),
        localChangeCount: plan.uploadToCloud.length + plan.deleteFromCloud.length,
        cloudChangeCount: plan.downloadToLocal.length + plan.deleteFromLocal.length,
        conflictCount: plan.conflicts.length,
        processedFileCount: 0,
        totalFileCount: 0,
        issues,
      });
      this.projectService.syncProjectMetadata();

      return {
        link,
        localHandle,
        localManifest,
        cloudManifest,
        baseline,
        plan,
      };
    } catch (error) {
      this.applyHybridState(link, {
        status: 'error',
        errorMessage:
          error instanceof Error
            ? error.message
            : 'Failed to compare local and cloud project data.',
        localChangeCount: 0,
        cloudChangeCount: 0,
        conflictCount: 0,
        processedFileCount: 0,
        totalFileCount: 0,
        issues: [],
      });
      this.projectService.syncProjectMetadata();
      return null;
    }
  }

  async syncCurrentProject(options?: {
    readonly conflictResolution?: 'local' | 'cloud';
  }): Promise<SyncResult | null> {
    const prepared = await this.refreshCurrentProjectStatus();
    if (!prepared) {
      return null;
    }

    const status = this.getPlanStatus(prepared.plan);
    if (status === 'up-to-date') {
      return {
        uploaded: [],
        downloaded: [],
        deletedLocal: [],
        deletedRemote: [],
        conflicts: [],
        unchanged: prepared.plan.unchanged,
        skipped: [],
      };
    }

    if (status === 'conflict') {
      const resolution = options?.conflictResolution ?? (await this.chooseConflictResolution());
      if (!resolution) {
        return null;
      }

      return resolution === 'local'
        ? this.applyLocalChangesToCloud(prepared, { includeConflicts: true })
        : this.applyCloudChangesToLocal(prepared, { includeConflicts: true });
    }

    if (status === 'local-changes') {
      return this.applyLocalChangesToCloud(prepared);
    }

    if (status === 'cloud-changes') {
      return this.applyCloudChangesToLocal(prepared);
    }

    return null;
  }

  async syncCurrentLocalProjectToCloud(): Promise<void> {
    if (
      appState.project.backend !== 'local' ||
      !appState.project.id ||
      !appState.project.directoryHandle
    ) {
      throw new Error('Open a local project folder before syncing to cloud.');
    }

    if (!appState.auth.isAuthenticated) {
      throw new Error('Sign in to create a linked cloud project.');
    }

    const localSessionId = appState.project.id;
    const localHandle = appState.project.directoryHandle;
    const projectName = appState.project.projectName?.trim() || localHandle.name || 'Pix3 Project';

    this.applyHybridState(null, {
      status: 'syncing',
      errorMessage: null,
      issues: [],
    });

    const project = await this.cloudProjectService.createProject(projectName);
    await this.writeLinkedCloudProjectId(project.id);

    const localManifest = await this.buildLocalManifest(localHandle);
    const filePaths = Array.from(localManifest.keys()).sort((a, b) => a.localeCompare(b));
    const skipped: SyncSkippedEntry[] = [];
    const progress: SyncProgressState = {
      processedFileCount: 0,
      totalFileCount: filePaths.length,
    };
    this.updateSyncProgress(null, progress);

    this.logger.info(`Hybrid sync started: local -> cloud (${filePaths.length} file(s))`, {
      projectId: project.id,
    });

    for (const filePath of filePaths) {
      const entry = localManifest.get(filePath);
      if (!entry) {
        continue;
      }

      this.logger.info(`Upload ${filePath} (${this.formatBytes(entry.size)})`, {
        path: filePath,
        size: entry.size,
        direction: 'local-to-cloud',
      });

      try {
        const content = await this.readFile(localHandle, filePath);
        await ApiClient.uploadFile(project.id, filePath, content);
      } catch (error) {
        if (this.isUploadTooLargeError(error)) {
          const reason = this.getUploadTooLargeMessage(filePath, entry.size, error);
          skipped.push({ path: filePath, size: entry.size, reason });
          this.logger.warn(reason, {
            path: filePath,
            size: entry.size,
            limitBytes: PROJECT_UPLOAD_FILE_SIZE_LIMIT_BYTES,
          });
          progress.processedFileCount += 1;
          this.updateSyncProgress(null, progress);
          continue;
        }

        throw error;
      }

      progress.processedFileCount += 1;
      this.updateSyncProgress(null, progress);
    }

    const link = this.upsertLinkRecord({
      cloudProjectId: project.id,
      localSessionId,
      localProjectName: projectName,
      localAbsolutePath: appState.project.localAbsolutePath,
      lastSyncAt: Date.now(),
    });

    const nextBaseline = this.createBaselineForInitialCloudSync(localManifest, skipped);
    this.writeBaseline(link, nextBaseline);
    const skippedMessage = this.buildIssuesSummary(skipped);
    this.applyHybridState(link, {
      status: skipped.length > 0 ? 'local-changes' : 'up-to-date',
      errorMessage: skippedMessage,
      localChangeCount: skipped.length,
      cloudChangeCount: 0,
      conflictCount: 0,
      processedFileCount: 0,
      totalFileCount: 0,
      issues: skipped,
      lastSyncAt: link.lastSyncAt,
    });

    if (skipped.length > 0) {
      this.logger.warn(`Hybrid sync finished with skipped file(s): ${skipped.length}`, {
        skipped,
      });
    } else {
      this.logger.info('Hybrid sync finished: local -> cloud completed successfully');
    }

    this.projectService.addRecentProject({
      id: project.id,
      name: projectName,
      backend: 'cloud',
      linkedLocalSessionId: localSessionId,
      localAbsolutePath: appState.project.localAbsolutePath ?? undefined,
      lastOpenedAt: Date.now(),
    });
    this.projectService.syncProjectMetadata();
  }

  async syncCurrentCloudProjectToLocalFolder(): Promise<void> {
    if (appState.project.backend !== 'cloud' || !appState.project.id) {
      throw new Error('Open a cloud project before syncing it to a local folder.');
    }

    this.ensureCloudWriteAccess();
    await this.ensureCurrentCloudManifestLinked(appState.project.id);

    const handle = await this.fileSystem.requestProjectDirectory('readwrite');
    const cloudProjectId = appState.project.id;
    const currentLocalManifest = await this.buildLocalManifest(handle);
    const currentLocalProjectContent = this.excludeLocalMappingSeedEntries(currentLocalManifest);
    const linkedCloudId = await this.readLinkedCloudProjectIdFromHandle(handle);

    if (
      currentLocalProjectContent.size > 0 &&
      linkedCloudId !== null &&
      linkedCloudId !== cloudProjectId
    ) {
      throw new Error('Selected folder is already linked to a different cloud project.');
    }

    if (currentLocalProjectContent.size > 0 && linkedCloudId === null) {
      throw new Error(
        'Choose an empty folder, a Git-only folder, or a folder already linked to this cloud project.'
      );
    }

    const existingLink = this.getLinkRecordByCloudProjectId(cloudProjectId);
    const localSessionId =
      existingLink?.localSessionId ?? this.projectService.createProjectSessionId();
    await this.projectService.persistProjectDirectoryHandle(localSessionId, handle);

    const link = this.upsertLinkRecord({
      cloudProjectId,
      localSessionId,
      localProjectName: appState.project.projectName?.trim() || handle.name || 'Pix3 Project',
      localAbsolutePath: existingLink?.localAbsolutePath ?? null,
      lastSyncAt: existingLink?.lastSyncAt ?? null,
    });

    this.applyHybridState(link, {
      status: 'syncing',
      errorMessage: null,
    });

    const prepared = await this.prepareSyncForLink(link, {
      localHandle: handle,
      promptForPermission: true,
      forceCloudStatus: true,
    });
    if (!prepared) {
      throw new Error('Failed to prepare local folder synchronization.');
    }

    await this.applyCloudChangesToLocal(prepared, { includeConflicts: true });

    this.projectService.addRecentProject({
      id: localSessionId,
      name: link.localProjectName,
      backend: 'local',
      linkedCloudProjectId: cloudProjectId,
      lastOpenedAt: Date.now(),
    });
    this.projectService.syncProjectMetadata();
  }

  private async promptForPendingLocalHybridSync(prepared: PreparedCurrentSync): Promise<void> {
    const status = this.getPlanStatus(prepared.plan);
    if (status !== 'local-changes' && status !== 'cloud-changes' && status !== 'conflict') {
      this.lastPromptSignature = null;
      return;
    }

    const signature = [
      appState.project.backend,
      appState.project.id,
      status,
      prepared.plan.uploadToCloud.length,
      prepared.plan.downloadToLocal.length,
      prepared.plan.deleteFromCloud.length,
      prepared.plan.deleteFromLocal.length,
      prepared.plan.conflicts.length,
    ].join(':');

    if (this.lastPromptSignature === signature) {
      return;
    }
    this.lastPromptSignature = signature;

    if (status === 'local-changes') {
      const confirmed = await this.dialogService.showConfirmation({
        title: 'Sync local changes to cloud?',
        message:
          'Pix3 detected changes in the linked local folder that were made outside the editor. Sync them to the cloud project now?',
        confirmLabel: 'Sync to Cloud',
        cancelLabel: 'Later',
      });
      if (confirmed) {
        await this.applyLocalChangesToCloud(prepared);
      }
      return;
    }

    if (status === 'cloud-changes') {
      const confirmed = await this.dialogService.showConfirmation({
        title: 'Sync cloud changes to local folder?',
        message:
          'The linked cloud project contains newer changes. Download them into the local folder now?',
        confirmLabel: 'Sync to Local',
        cancelLabel: 'Later',
      });
      if (confirmed) {
        await this.applyCloudChangesToLocal(prepared);
      }
      return;
    }

    const resolution = await this.chooseConflictResolution();
    if (!resolution) {
      return;
    }

    if (resolution === 'local') {
      await this.applyLocalChangesToCloud(prepared, { includeConflicts: true });
      return;
    }

    await this.applyCloudChangesToLocal(prepared, { includeConflicts: true });
  }

  private async chooseConflictResolution(): Promise<'local' | 'cloud' | null> {
    const choice = await this.dialogService.showChoice({
      title: 'Resolve hybrid sync conflicts',
      message:
        'Both the linked local folder and the cloud project changed since the last sync. Choose which side should overwrite the other.',
      confirmLabel: 'Use Local',
      secondaryLabel: 'Use Cloud',
      cancelLabel: 'Cancel',
    });

    if (choice === 'confirm') {
      return 'local';
    }

    if (choice === 'secondary') {
      return 'cloud';
    }

    return null;
  }

  private async applyLocalChangesToCloud(
    prepared: PreparedCurrentSync,
    options: { includeConflicts?: boolean } = {}
  ): Promise<SyncResult> {
    if (!appState.auth.isAuthenticated) {
      throw new Error('Sign in to sync local changes to the cloud project.');
    }

    this.applyHybridState(prepared.link, {
      status: 'syncing',
      errorMessage: null,
      issues: [],
    });

    const uploadPaths = [...prepared.plan.uploadToCloud];
    const deletePaths = [...prepared.plan.deleteFromCloud];
    if (options.includeConflicts) {
      for (const filePath of prepared.plan.conflicts) {
        if (prepared.localManifest.has(filePath)) {
          uploadPaths.push(filePath);
        } else {
          deletePaths.push(filePath);
        }
      }
    }

    const uploaded: string[] = [];
    const deletedRemote: string[] = [];
    const skipped: SyncSkippedEntry[] = [];
    const uniqueUploadPaths = this.uniqueSortedPaths(uploadPaths);
    const uniqueDeletePaths = this.uniqueSortedPaths(deletePaths);
    const progress: SyncProgressState = {
      processedFileCount: 0,
      totalFileCount: uniqueUploadPaths.length + uniqueDeletePaths.length,
    };
    this.updateSyncProgress(prepared.link, progress);

    this.logger.info(
      `Hybrid sync started: local -> cloud (${uploadPaths.length} upload(s), ${deletePaths.length} delete(s))`
    );

    for (const filePath of uniqueUploadPaths) {
      const entry = prepared.localManifest.get(filePath);
      if (!entry) {
        continue;
      }

      this.logger.info(`Upload ${filePath} (${this.formatBytes(entry.size)})`, {
        path: filePath,
        size: entry.size,
        direction: 'local-to-cloud',
      });

      try {
        const content = await this.readFile(prepared.localHandle, filePath);
        await ApiClient.uploadFile(prepared.link.cloudProjectId, filePath, content);
        uploaded.push(filePath);
      } catch (error) {
        if (this.isUploadTooLargeError(error)) {
          const reason = this.getUploadTooLargeMessage(filePath, entry.size, error);
          skipped.push({ path: filePath, size: entry.size, reason });
          this.logger.warn(reason, {
            path: filePath,
            size: entry.size,
            limitBytes: PROJECT_UPLOAD_FILE_SIZE_LIMIT_BYTES,
          });
          progress.processedFileCount += 1;
          this.updateSyncProgress(prepared.link, progress);
          continue;
        }

        throw error;
      }

      progress.processedFileCount += 1;
      this.updateSyncProgress(prepared.link, progress);
    }

    for (const filePath of uniqueDeletePaths) {
      this.logger.info(`Delete remote ${filePath}`, {
        path: filePath,
        direction: 'local-to-cloud',
      });
      try {
        await ApiClient.deleteFile(prepared.link.cloudProjectId, filePath);
        deletedRemote.push(filePath);
      } catch {
        // Ignore missing files while converging to the local folder state.
      }

      progress.processedFileCount += 1;
      this.updateSyncProgress(prepared.link, progress);
    }

    const lastSyncAt = Date.now();
    const nextLink = this.upsertLinkRecord({
      ...prepared.link,
      lastSyncAt,
    });
    const nextBaseline = this.createBaselineAfterLocalToCloud(prepared, uploaded, deletedRemote);
    this.writeBaseline(nextLink, nextBaseline);
    const skippedMessage = this.buildIssuesSummary(skipped);
    this.applyHybridState(nextLink, {
      status: skipped.length > 0 ? 'local-changes' : 'up-to-date',
      errorMessage: skippedMessage,
      localChangeCount: skipped.length,
      cloudChangeCount: 0,
      conflictCount: 0,
      processedFileCount: 0,
      totalFileCount: 0,
      issues: skipped,
      lastSyncAt,
    });
    this.projectService.syncProjectMetadata();

    if (skipped.length > 0) {
      this.logger.warn(`Hybrid sync finished with skipped file(s): ${skipped.length}`, {
        uploaded: uploaded.length,
        deletedRemote: deletedRemote.length,
        skipped,
      });
    } else {
      this.logger.info('Hybrid sync finished: local -> cloud completed successfully', {
        uploaded: uploaded.length,
        deletedRemote: deletedRemote.length,
      });
    }

    return {
      uploaded,
      downloaded: [],
      deletedLocal: [],
      deletedRemote,
      conflicts: options.includeConflicts ? prepared.plan.conflicts : [],
      unchanged: prepared.plan.unchanged,
      skipped,
    };
  }

  private async applyCloudChangesToLocal(
    prepared: PreparedCurrentSync,
    options: { includeConflicts?: boolean } = {}
  ): Promise<SyncResult> {
    this.applyHybridState(prepared.link, {
      status: 'syncing',
      errorMessage: null,
      issues: [],
    });

    const downloadPaths = [...prepared.plan.downloadToLocal];
    const deletePaths = [...prepared.plan.deleteFromLocal];
    if (options.includeConflicts) {
      for (const filePath of prepared.plan.conflicts) {
        if (prepared.cloudManifest.has(filePath)) {
          downloadPaths.push(filePath);
        } else {
          deletePaths.push(filePath);
        }
      }
    }

    const downloaded: string[] = [];
    const deletedLocal: string[] = [];
    const shareToken = this.getCloudShareToken(prepared.link.cloudProjectId);
    const uniqueDownloadPaths = this.uniqueSortedPaths(downloadPaths);
    const uniqueDeletePaths = this.uniqueSortedPaths(deletePaths);
    const progress: SyncProgressState = {
      processedFileCount: 0,
      totalFileCount: uniqueDownloadPaths.length + uniqueDeletePaths.length,
    };
    this.updateSyncProgress(prepared.link, progress);

    this.logger.info(
      `Hybrid sync started: cloud -> local (${downloadPaths.length} download(s), ${deletePaths.length} delete(s))`
    );

    for (const filePath of uniqueDownloadPaths) {
      const entry = prepared.cloudManifest.get(filePath);
      this.logger.info(`Download ${filePath}${entry ? ` (${this.formatBytes(entry.size)})` : ''}`, {
        path: filePath,
        size: entry?.size ?? null,
        direction: 'cloud-to-local',
      });
      const response = await ApiClient.downloadFile(
        prepared.link.cloudProjectId,
        filePath,
        shareToken
      );
      await this.writeFile(prepared.localHandle, filePath, await response.arrayBuffer());
      downloaded.push(filePath);
      progress.processedFileCount += 1;
      this.updateSyncProgress(prepared.link, progress);
    }

    for (const filePath of uniqueDeletePaths) {
      this.logger.info(`Delete local ${filePath}`, {
        path: filePath,
        direction: 'cloud-to-local',
      });
      await this.deleteFile(prepared.localHandle, filePath);
      deletedLocal.push(filePath);
      progress.processedFileCount += 1;
      this.updateSyncProgress(prepared.link, progress);
    }

    const nextLocalManifest = await this.buildLocalManifest(prepared.localHandle);
    const lastSyncAt = Date.now();
    const nextLink = this.upsertLinkRecord({
      ...prepared.link,
      lastSyncAt,
    });
    this.writeBaseline(nextLink, nextLocalManifest);
    this.applyHybridState(nextLink, {
      status: 'up-to-date',
      errorMessage: null,
      localChangeCount: 0,
      cloudChangeCount: 0,
      conflictCount: 0,
      processedFileCount: 0,
      totalFileCount: 0,
      issues: [],
      lastSyncAt,
    });
    this.projectService.syncProjectMetadata();

    if (appState.project.backend === 'local') {
      appState.project.manifest = await this.projectService.loadProjectManifest();
    }

    this.logger.info('Hybrid sync finished: cloud -> local completed successfully', {
      downloaded: downloaded.length,
      deletedLocal: deletedLocal.length,
    });

    return {
      uploaded: [],
      downloaded,
      deletedLocal,
      deletedRemote: [],
      conflicts: options.includeConflicts ? prepared.plan.conflicts : [],
      unchanged: prepared.plan.unchanged,
      skipped: [],
    };
  }

  private async prepareSyncForLink(
    link: HybridLinkRecord,
    options: {
      readonly localHandle?: FileSystemDirectoryHandle;
      readonly promptForPermission: boolean;
      readonly forceCloudStatus?: boolean;
    }
  ): Promise<PreparedCurrentSync | null> {
    const localHandle =
      options.localHandle ??
      (await this.resolveLinkedLocalHandle(link, {
        promptForPermission: options.promptForPermission,
      }));

    if (!localHandle) {
      return null;
    }

    const [localManifest, cloudManifest] = await Promise.all([
      this.buildLocalManifest(localHandle),
      this.getCloudManifest(link.cloudProjectId),
    ]);
    const baseline = this.readBaseline(link);
    const plan = this.createSyncPlan(localManifest, cloudManifest, baseline);

    if (options.forceCloudStatus && baseline.size === 0) {
      return {
        link,
        localHandle,
        localManifest,
        cloudManifest,
        baseline,
        plan: {
          uploadToCloud: [],
          downloadToLocal: Array.from(cloudManifest.keys()),
          deleteFromCloud: [],
          deleteFromLocal: Array.from(localManifest.keys()).filter(filePath => {
            if (cloudManifest.has(filePath)) {
              return false;
            }

            return !this.isLocalMappingSeedPath(filePath);
          }),
          conflicts: [],
          unchanged: [],
        },
      };
    }

    return {
      link,
      localHandle,
      localManifest,
      cloudManifest,
      baseline,
      plan,
    };
  }

  private async resolveLinkedLocalHandle(
    link: HybridLinkRecord,
    options: { readonly promptForPermission: boolean }
  ): Promise<FileSystemDirectoryHandle | null> {
    const currentProjectId = appState.project.id;
    if (appState.project.backend === 'local' && currentProjectId === link.localSessionId) {
      return appState.project.directoryHandle;
    }

    const handle = await this.projectService.getPersistedProjectDirectoryHandle(
      link.localSessionId
    );
    if (!handle) {
      return null;
    }

    if (options.promptForPermission) {
      await this.fileSystem.ensurePermission(handle, 'readwrite');
      return handle;
    }

    const permission = await this.queryPermission(handle, 'read');
    return permission === 'granted' ? handle : null;
  }

  private async queryPermission(
    handle: FileSystemHandle,
    mode: 'read' | 'readwrite'
  ): Promise<'prompt' | 'granted' | 'denied' | 'unsupported'> {
    const permissionHandle = handle as FileSystemHandle & {
      queryPermission?: (descriptor: {
        mode: 'read' | 'readwrite';
      }) => Promise<'prompt' | 'granted' | 'denied'>;
    };

    if (typeof permissionHandle.queryPermission !== 'function') {
      return 'unsupported';
    }

    return permissionHandle.queryPermission({ mode });
  }

  private getCloudShareToken(projectId: string): string | undefined {
    if (appState.project.backend === 'cloud' && appState.project.id === projectId) {
      return appState.collaboration.shareToken ?? undefined;
    }

    return undefined;
  }

  private async getCloudManifest(projectId: string): Promise<Map<string, ManifestEntry>> {
    const { files } = await ApiClient.getManifestWithAccess(
      projectId,
      this.getCloudShareToken(projectId)
    );
    const manifest = new Map<string, ManifestEntry>();
    for (const entry of files) {
      if (entry.kind !== 'file' || this.shouldIgnorePath(entry.path)) {
        continue;
      }
      manifest.set(entry.path, entry);
    }
    return manifest;
  }

  private createSyncPlan(
    localManifest: Map<string, FileHashEntry>,
    cloudManifest: Map<string, ManifestEntry>,
    baseline: Map<string, string>
  ): SyncPlan {
    const plan: SyncPlan = {
      uploadToCloud: [],
      downloadToLocal: [],
      deleteFromCloud: [],
      deleteFromLocal: [],
      conflicts: [],
      unchanged: [],
    };

    const allPaths = new Set<string>([
      ...localManifest.keys(),
      ...cloudManifest.keys(),
      ...baseline.keys(),
    ]);

    for (const filePath of Array.from(allPaths).sort((a, b) => a.localeCompare(b))) {
      const localHash = localManifest.get(filePath)?.hash ?? null;
      const cloudHash = cloudManifest.get(filePath)?.hash ?? null;
      const baselineHash = baseline.get(filePath) ?? null;

      if (localHash === cloudHash) {
        if (localHash !== null) {
          plan.unchanged.push(filePath);
        }
        continue;
      }

      if (baselineHash === cloudHash) {
        if (localHash === null) {
          plan.deleteFromCloud.push(filePath);
        } else {
          plan.uploadToCloud.push(filePath);
        }
        continue;
      }

      if (baselineHash === localHash) {
        if (cloudHash === null) {
          plan.deleteFromLocal.push(filePath);
        } else {
          plan.downloadToLocal.push(filePath);
        }
        continue;
      }

      if (baselineHash === null) {
        if (localHash === null && cloudHash !== null) {
          plan.downloadToLocal.push(filePath);
          continue;
        }

        if (cloudHash === null && localHash !== null) {
          plan.uploadToCloud.push(filePath);
          continue;
        }
      }

      plan.conflicts.push(filePath);
    }

    return plan;
  }

  private getPlanStatus(
    plan: SyncPlan
  ): 'up-to-date' | 'local-changes' | 'cloud-changes' | 'conflict' {
    if (plan.conflicts.length > 0) {
      return 'conflict';
    }

    const localChanges = plan.uploadToCloud.length + plan.deleteFromCloud.length;
    const cloudChanges = plan.downloadToLocal.length + plan.deleteFromLocal.length;

    if (localChanges > 0) {
      return 'local-changes';
    }

    if (cloudChanges > 0) {
      return 'cloud-changes';
    }

    return 'up-to-date';
  }

  private resolveCurrentLink(): HybridLinkRecord | null {
    if (!appState.project.id) {
      return null;
    }

    if (appState.project.backend === 'cloud') {
      return this.getLinkRecordByCloudProjectId(appState.project.id);
    }

    const currentSessionId = appState.project.id;
    const manifestCloudProjectId = this.extractHybridCloudProjectId(appState.project.manifest);
    const existingLink =
      this.getLinkRecordByLocalSessionId(currentSessionId) ??
      (manifestCloudProjectId ? this.getLinkRecordByCloudProjectId(manifestCloudProjectId) : null);

    const cloudProjectId = manifestCloudProjectId ?? existingLink?.cloudProjectId ?? null;
    if (!cloudProjectId) {
      return null;
    }

    return this.upsertLinkRecord({
      cloudProjectId,
      localSessionId: currentSessionId,
      localProjectName:
        appState.project.projectName?.trim() || existingLink?.localProjectName || 'Pix3 Project',
      localAbsolutePath:
        appState.project.localAbsolutePath ?? existingLink?.localAbsolutePath ?? null,
      lastSyncAt: existingLink?.lastSyncAt ?? null,
    });
  }

  private async ensureCurrentCloudManifestLinked(projectId: string): Promise<void> {
    const current = this.extractHybridCloudProjectId(appState.project.manifest);
    if (current === projectId) {
      return;
    }

    const manifest = appState.project.manifest ?? (await this.projectService.loadProjectManifest());
    await this.projectService.saveProjectManifest({
      ...manifest,
      metadata: {
        ...(manifest.metadata ?? {}),
        [HYBRID_METADATA_KEY]: {
          cloudProjectId: projectId,
        },
      },
    });
  }

  private async writeLinkedCloudProjectId(cloudProjectId: string): Promise<void> {
    const manifest = appState.project.manifest ?? (await this.projectService.loadProjectManifest());
    await this.projectService.saveProjectManifest({
      ...manifest,
      metadata: {
        ...(manifest.metadata ?? {}),
        [HYBRID_METADATA_KEY]: {
          cloudProjectId,
        },
      },
    });
  }

  private extractHybridCloudProjectId(manifest: typeof appState.project.manifest): string | null {
    if (!manifest?.metadata || typeof manifest.metadata !== 'object') {
      return null;
    }

    const hybridMetadata = (manifest.metadata as Record<string, unknown>)[HYBRID_METADATA_KEY];
    if (!hybridMetadata || typeof hybridMetadata !== 'object') {
      return null;
    }

    const cloudProjectId = (hybridMetadata as Record<string, unknown>).cloudProjectId;
    return typeof cloudProjectId === 'string' && cloudProjectId.trim().length > 0
      ? cloudProjectId.trim()
      : null;
  }

  private applyHybridState(
    link: HybridLinkRecord | null,
    updates: Partial<typeof appState.project.hybridSync>
  ): void {
    appState.project.hybridSync.linkedCloudProjectId = link?.cloudProjectId ?? null;
    appState.project.hybridSync.linkedLocalSessionId = link?.localSessionId ?? null;
    appState.project.hybridSync.linkedLocalPath = link?.localAbsolutePath ?? null;
    appState.project.hybridSync.lastSyncAt =
      updates.lastSyncAt ?? link?.lastSyncAt ?? appState.project.hybridSync.lastSyncAt;
    appState.project.hybridSync.status = updates.status ?? appState.project.hybridSync.status;
    appState.project.hybridSync.localChangeCount =
      updates.localChangeCount ?? appState.project.hybridSync.localChangeCount;
    appState.project.hybridSync.cloudChangeCount =
      updates.cloudChangeCount ?? appState.project.hybridSync.cloudChangeCount;
    appState.project.hybridSync.conflictCount =
      updates.conflictCount ?? appState.project.hybridSync.conflictCount;
    appState.project.hybridSync.processedFileCount =
      updates.processedFileCount ?? appState.project.hybridSync.processedFileCount;
    appState.project.hybridSync.totalFileCount =
      updates.totalFileCount ?? appState.project.hybridSync.totalFileCount;
    appState.project.hybridSync.issues = updates.issues ?? appState.project.hybridSync.issues;
    appState.project.hybridSync.errorMessage =
      updates.errorMessage ?? appState.project.hybridSync.errorMessage;
  }

  private updateSyncProgress(link: HybridLinkRecord | null, progress: SyncProgressState): void {
    this.applyHybridState(link, {
      processedFileCount: progress.processedFileCount,
      totalFileCount: progress.totalFileCount,
    });
  }

  private readLinkRecords(): HybridLinkRecord[] {
    try {
      const raw = localStorage.getItem(HYBRID_LINKS_KEY);
      if (!raw) {
        return [];
      }

      const parsed = JSON.parse(raw) as HybridLinkRecord[];
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(entry => {
        return (
          entry &&
          typeof entry.cloudProjectId === 'string' &&
          typeof entry.localSessionId === 'string' &&
          typeof entry.localProjectName === 'string'
        );
      });
    } catch {
      return [];
    }
  }

  private saveLinkRecords(records: HybridLinkRecord[]): void {
    localStorage.setItem(HYBRID_LINKS_KEY, JSON.stringify(records));
  }

  private getLinkRecordByCloudProjectId(cloudProjectId: string): HybridLinkRecord | null {
    return this.readLinkRecords().find(entry => entry.cloudProjectId === cloudProjectId) ?? null;
  }

  private getLinkRecordByLocalSessionId(localSessionId: string): HybridLinkRecord | null {
    return this.readLinkRecords().find(entry => entry.localSessionId === localSessionId) ?? null;
  }

  private upsertLinkRecord(record: HybridLinkRecord): HybridLinkRecord {
    const records = this.readLinkRecords();
    const previous =
      records.find(entry => entry.cloudProjectId === record.cloudProjectId) ??
      records.find(entry => entry.localSessionId === record.localSessionId) ??
      null;

    if (previous && previous.localSessionId !== record.localSessionId) {
      const previousBaseline = this.readBaseline(previous);
      if (previousBaseline.size > 0) {
        this.writeBaseline(record, previousBaseline);
      }
    }

    const nextRecord: HybridLinkRecord = {
      ...record,
      lastSyncAt: record.lastSyncAt ?? previous?.lastSyncAt ?? null,
    };

    const nextRecords = records.filter(entry => {
      return (
        entry.cloudProjectId !== nextRecord.cloudProjectId &&
        entry.localSessionId !== nextRecord.localSessionId
      );
    });
    nextRecords.unshift(nextRecord);
    this.saveLinkRecords(nextRecords);
    return nextRecord;
  }

  private readBaseline(link: HybridLinkRecord): Map<string, string> {
    try {
      const raw = localStorage.getItem(this.getBaselineStorageKey(link));
      if (!raw) {
        return new Map();
      }

      const parsed = JSON.parse(raw) as Record<string, string>;
      return new Map(Object.entries(parsed).filter(([, value]) => typeof value === 'string'));
    } catch {
      return new Map();
    }
  }

  private writeBaseline(
    link: HybridLinkRecord,
    manifest: Map<string, FileHashEntry> | Map<string, string>
  ): void {
    const payload: Record<string, string> = {};
    for (const [path, value] of manifest) {
      payload[path] = typeof value === 'string' ? value : value.hash;
    }
    localStorage.setItem(this.getBaselineStorageKey(link), JSON.stringify(payload));
  }

  private getBaselineStorageKey(link: HybridLinkRecord): string {
    return `${HYBRID_BASELINE_PREFIX}${link.cloudProjectId}:${link.localSessionId}`;
  }

  private async buildLocalManifest(
    dirHandle: FileSystemDirectoryHandle,
    prefix = ''
  ): Promise<Map<string, FileHashEntry>> {
    const result = new Map<string, FileHashEntry>();
    const iterableDirHandle = dirHandle as FileSystemDirectoryHandle & {
      entries(): AsyncIterable<[string, FileSystemHandle]>;
    };

    for await (const [name, handle] of iterableDirHandle.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (this.shouldIgnorePath(path)) {
        continue;
      }

      if (handle.kind === 'directory') {
        const subManifest = await this.buildLocalManifest(
          handle as FileSystemDirectoryHandle,
          path
        );
        for (const [filePath, entry] of subManifest) {
          result.set(filePath, entry);
        }
        continue;
      }

      const file = await (handle as FileSystemFileHandle).getFile();
      const buffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      const hash = Array.from(new Uint8Array(hashBuffer))
        .map(value => value.toString(16).padStart(2, '0'))
        .join('');
      result.set(path, {
        hash,
        modified: file.lastModified,
        size: file.size,
      });
    }

    return result;
  }

  private shouldIgnorePath(path: string): boolean {
    const normalized = path.replace(/\\+/g, '/').replace(/^\/+/, '');
    const segments = normalized.split('/').filter(Boolean);
    const fileName = segments[segments.length - 1] ?? '';

    if (segments.some(segment => IGNORED_DIRECTORY_NAMES.has(segment))) {
      return true;
    }

    if (IGNORED_FILE_NAMES.has(fileName)) {
      return true;
    }

    if (fileName === '.env' || fileName.startsWith('.env.')) {
      return true;
    }

    if (fileName.startsWith('credentials')) {
      return true;
    }

    return false;
  }

  private uniqueSortedPaths(paths: string[]): string[] {
    return Array.from(new Set(paths)).sort((a, b) => a.localeCompare(b));
  }

  private excludeLocalMappingSeedEntries(
    manifest: Map<string, FileHashEntry>
  ): Map<string, FileHashEntry> {
    return new Map(
      Array.from(manifest.entries()).filter(([filePath]) => !this.isLocalMappingSeedPath(filePath))
    );
  }

  private isLocalMappingSeedPath(path: string): boolean {
    const normalized = path.replace(/\\+/g, '/').replace(/^\/+/, '');
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length !== 1) {
      return false;
    }

    return LOCAL_MAPPING_SEED_FILE_NAMES.has(segments[0] ?? '');
  }

  private getOversizeLocalEntries(
    localManifest: Map<string, FileHashEntry>,
    plan: SyncPlan
  ): SyncSkippedEntry[] {
    const oversizePaths = new Set<string>([...plan.uploadToCloud, ...plan.conflicts]);

    const entries: SyncSkippedEntry[] = [];
    for (const filePath of oversizePaths) {
      const entry = localManifest.get(filePath);
      if (!entry || entry.size <= PROJECT_UPLOAD_FILE_SIZE_LIMIT_BYTES) {
        continue;
      }

      entries.push({
        path: filePath,
        size: entry.size,
        reason: this.getUploadTooLargeMessage(filePath, entry.size),
      });
    }

    return entries;
  }

  private createBaselineForInitialCloudSync(
    localManifest: Map<string, FileHashEntry>,
    skipped: SyncSkippedEntry[]
  ): Map<string, string> {
    const skippedPaths = new Set(skipped.map(entry => entry.path));
    const baseline = new Map<string, string>();
    for (const [filePath, entry] of localManifest) {
      if (skippedPaths.has(filePath)) {
        continue;
      }
      baseline.set(filePath, entry.hash);
    }
    return baseline;
  }

  private createBaselineAfterLocalToCloud(
    prepared: PreparedCurrentSync,
    uploaded: string[],
    deletedRemote: string[]
  ): Map<string, string> {
    const baseline = new Map(prepared.baseline);

    for (const filePath of uploaded) {
      const entry = prepared.localManifest.get(filePath);
      if (entry) {
        baseline.set(filePath, entry.hash);
      }
    }

    for (const filePath of deletedRemote) {
      baseline.delete(filePath);
    }

    return baseline;
  }

  private isUploadTooLargeError(error: unknown): boolean {
    return error instanceof ApiClientError && error.status === 413;
  }

  private getUploadTooLargeMessage(filePath: string, size: number, error?: unknown): string {
    if (size > PROJECT_UPLOAD_FILE_SIZE_LIMIT_BYTES) {
      return `Skipped ${filePath} (${this.formatBytes(size)}): configured upload limit is ${formatUploadLimitBytes(PROJECT_UPLOAD_FILE_SIZE_LIMIT_BYTES)}.`;
    }

    if (this.isUploadTooLargeError(error)) {
      return `Skipped ${filePath} (${this.formatBytes(size)}): server rejected the upload with HTTP 413. Pix3 server limit is ${formatUploadLimitBytes(PROJECT_UPLOAD_FILE_SIZE_LIMIT_BYTES)}, so an upstream proxy such as nginx likely has a lower limit.`;
    }

    return `Skipped ${filePath} (${this.formatBytes(size)}): upload was rejected because it is too large.`;
  }

  private buildIssuesSummary(issues: SyncSkippedEntry[]): string | null {
    if (issues.length === 0) {
      return null;
    }

    const [first] = issues;
    if (!first) {
      return null;
    }

    if (issues.length === 1) {
      return first.reason;
    }

    return `${issues.length} file(s) need attention. First issue: ${first.reason}`;
  }

  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
  }

  private ensureCloudWriteAccess(): void {
    if (!appState.auth.isAuthenticated) {
      throw new Error('Sign in to synchronize this project with the cloud.');
    }

    if (appState.project.backend === 'cloud' && appState.collaboration.isReadOnly) {
      throw new Error('Hybrid sync requires edit access to the cloud project.');
    }
  }

  private async readLinkedCloudProjectIdFromHandle(
    handle: FileSystemDirectoryHandle
  ): Promise<string | null> {
    try {
      const manifestBuffer = await this.readFile(handle, PROJECT_MANIFEST_PATH);
      const manifest = parse(new TextDecoder().decode(manifestBuffer));
      if (!manifest || typeof manifest !== 'object') {
        return null;
      }

      const metadata = (manifest as { metadata?: unknown }).metadata;
      if (!metadata || typeof metadata !== 'object') {
        return null;
      }

      const hybridMetadata = (metadata as Record<string, unknown>)[HYBRID_METADATA_KEY];
      if (!hybridMetadata || typeof hybridMetadata !== 'object') {
        return null;
      }

      const cloudProjectId = (hybridMetadata as Record<string, unknown>).cloudProjectId;
      return typeof cloudProjectId === 'string' && cloudProjectId.trim().length > 0
        ? cloudProjectId.trim()
        : null;
    } catch {
      return null;
    }
  }

  private async writeFile(
    rootHandle: FileSystemDirectoryHandle,
    filePath: string,
    content: ArrayBuffer
  ): Promise<void> {
    const parts = filePath.split('/');
    let dir = rootHandle;
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  private async readFile(
    rootHandle: FileSystemDirectoryHandle,
    filePath: string
  ): Promise<ArrayBuffer> {
    const parts = filePath.split('/');
    let dir = rootHandle;
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part);
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
    const file = await fileHandle.getFile();
    return file.arrayBuffer();
  }

  private async deleteFile(rootHandle: FileSystemDirectoryHandle, filePath: string): Promise<void> {
    const parts = filePath.split('/');
    let dir = rootHandle;
    for (const part of parts.slice(0, -1)) {
      try {
        dir = await dir.getDirectoryHandle(part);
      } catch {
        return;
      }
    }

    try {
      await dir.removeEntry(parts[parts.length - 1]);
    } catch {
      // Ignore files that are already absent while converging to cloud state.
    }
  }
}
