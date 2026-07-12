export {
  FileSystemAPIService,
  type FileSystemAPIErrorCode,
  FileSystemAPIError,
  type FileDescriptor,
  type FileSystemAPIServiceOptions,
  type ReadSceneResult,
  resolveFileSystemAPIService,
} from './FileSystemAPIService';
export {
  TemplateService as BaseTemplateService,
  DEFAULT_TEMPLATE_SCENE_ID,
  type TemplateScheme,
} from './TemplateService';
export { ResourceManager, type ReadResourceOptions } from './ResourceManager';
export { FocusRingService, type FocusRingServiceOptions } from './FocusRingService';
export { ProjectService, resolveProjectService } from './ProjectService';
export {
  ProjectLifecycleService,
  ProjectAuthRequiredError,
  type CreateProjectDialogInstance,
  type CreateProjectParams,
} from './ProjectLifecycleService';
export { ProjectStorageService, resolveProjectStorageService } from './ProjectStorageService';
export { BrowserProjectStorageService } from './BrowserProjectStorageService';
export { EditorSettingsService } from './EditorSettingsService';
export { ProjectSettingsService } from './ProjectSettingsService';
export { AssetFileActivationService, type AssetActivation } from './AssetFileActivationService';
export { AnimationEditorService } from './AnimationEditorService';
export {
  AnimationAutoSliceDialogService,
  type AnimationAutoSliceDialogInstance,
  type AnimationAutoSliceDialogParams,
  type AnimationAutoSliceDialogResult,
} from './AnimationAutoSliceDialogService';
export {
  AssetImportService,
  type AssetImportResult,
  type AssetImportFailure,
} from './AssetImportService';
export {
  AssetImportDialogService,
  type AssetImportDialogInstance,
  type AssetImportDialogParams,
  type AssetImportDialogResult,
} from './AssetImportDialogService';
export {
  SaveGeneratedAssetDialogService,
  type SaveGeneratedAssetDialogInstance,
  type SaveGeneratedAssetDialogParams,
  type SaveGeneratedAssetDialogResult,
} from './SaveGeneratedAssetDialogService';
export { GeneratedAssetDropService } from './GeneratedAssetDropService';
export { CommandDispatcher, resolveCommandDispatcher } from './CommandDispatcher';
export { LoggingService, type LogLevel, type LogEntry, type LogListener } from './LoggingService';
export { CommandRegistry, type CommandMenuItem, type MenuSection } from './CommandRegistry';
export { KeybindingService } from './KeybindingService';
export { FileWatchService } from './FileWatchService';
export {
  CodeDocumentService,
  type CodeDocumentEvent,
  type CodeDocumentEventReason,
  type CodeDocumentLanguage,
  type CodeDocumentSnapshot,
} from './CodeDocumentService';
export { LocalSyncService, type SyncResult } from './LocalSyncService';
export { ProjectSyncService, type ProjectSyncDialogInstance } from './ProjectSyncService';
export {
  DialogService,
  type DialogOptions,
  type DialogInstance,
  resolveDialogService,
} from './DialogService';
export { EditorTabService } from './EditorTabService';
export { GamePlaySessionService } from './GamePlaySessionService';
export {
  ProfilerSessionService,
  type ProfilerHistorySnapshot,
  type ProfilerSessionSnapshot,
  type ProfilerSessionStatus,
  type ProfilerPerformanceSnapshot,
  type ProfilerCountersSnapshot,
  type ProfilerFrameImpactSnapshot,
  type ProfilerFrameImpactEntrySnapshot,
  type ProfilerAudioSnapshot,
  type ProfilerAudioFileSnapshot,
} from './ProfilerSessionService';
export {
  RemotePreviewTelemetryService,
  type RemotePlayerTelemetry,
} from './RemotePreviewTelemetryService';
export { IconService, IconSize, type IconSizeValue } from './IconService';
export { ScriptRegistry } from '@pix3/runtime';
export { ScriptExecutionService } from './ScriptExecutionService';
export { AutoloadService } from './AutoloadService';
export { ProjectScriptLoaderService } from './ProjectScriptLoaderService';
export { MonacoIntelliSenseService } from './MonacoIntelliSenseService';
export { BehaviorPickerService } from './BehaviorPickerService';
export { NodeTypePickerService, type NodeTypePickerInstance } from './NodeTypePickerService';
export {
  PlayableExportDialogService,
  type PlayableExportDialogInstance,
  type PlayableExportDialogOptions,
} from './PlayableExportDialogService';
export {
  AssetsPreviewService,
  type AssetPreviewItem,
  type AssetThumbnailStatus,
  type AssetPreviewType,
  type AssetsPreviewSnapshot,
} from './AssetsPreviewService';
export { ThumbnailCacheService } from './ThumbnailCacheService';
export { ThumbnailGenerator } from './ThumbnailGenerator';
export { SceneThumbnailGenerator } from './SceneThumbnailGenerator';
export {
  ScriptCreatorService,
  type ScriptCreationParams,
  type ScriptCreationInstance,
} from './ScriptCreatorService';
export {
  ScriptCompilerService,
  type CompilationResult,
  type CompilationError,
  type VirtualBundleOptions,
} from './ScriptCompilerService';
export { ProjectBuildService, type ProjectBuildResult } from './ProjectBuildService';
export {
  PlayableHtmlBuildService,
  type PlayableHtmlBuildOptions,
  type PlayableHtmlBuildArtifact,
} from './PlayableHtmlBuildService';
export { Navigation2DController } from './Navigation2DController';
export {
  CollaborationService,
  type CollabConnectionStatus,
  type CollabUserInfo,
} from './CollaborationService';
export { AssetUploadService, type AssetUploadResult } from './AssetUploadService';
export { SceneCRDTBinding } from './SceneCRDTBinding';
export { CollabViewportOverlayService } from './CollabViewportOverlayService';
export { CollabJoinService, type CollabJoinParams } from './CollabJoinService';
export { CollabSessionService } from './CollabSessionService';
export {
  UpdateCheckService,
  compareEditorVersions,
  type UpdateCheckState,
  type UpdateCheckStatus,
  type UpdateCheckListener,
} from './UpdateCheckService';
export { LlmProviderRegistry } from './llm/LlmProviderRegistry';
export {
  LlmError,
  formatPricingHint,
  type ChatParams,
  type LlmContentBlock,
  type LlmMessage,
  type LlmModel,
  type LlmModelPricing,
  type LlmProvider,
  type LlmRequestContext,
  type LlmResult,
  type LlmStopReason,
  type LlmToolDefinition,
} from './llm/LlmTypes';
export { AgentSettingsService, type AgentPreferences } from './AgentSettingsService';
export {
  AgentToolRegistry,
  type AgentToolDefinition,
  type AgentToolSpec,
} from './agent/AgentToolRegistry';
export {
  AgentChatService,
  type AgentChatState,
  type AgentChatStatus,
} from './agent/AgentChatService';
export { AgentChatHistoryStore, type AgentConversationRecord } from './agent/AgentChatHistoryStore';
export { AssetLibraryService } from './AssetLibraryService';
export { PublishToLibraryService, type PublishNodeParams } from './PublishToLibraryService';
export {
  LibraryInsertService,
  type InsertedBundle,
  type LibraryInsertPlacement,
} from './LibraryInsertService';
export {
  type LibraryScope,
  type LibraryItemType,
  type LibraryItemSource,
  type LibraryItem,
  type LibraryItemManifest,
  type LibraryBundle,
  type LibraryProvider,
  LIBRARY_ITEM_TYPES,
  LIBRARY_SCOPES,
  LIBRARY_SCOPE_LABELS,
  categoryForItemType,
  inferItemTypeFromPath,
} from './library/library-types';
export {
  type LibraryFilter,
  slugify,
  uniqueSlug,
  matchesFilter,
  filterItems,
  collectTags,
} from './library/library-search';
