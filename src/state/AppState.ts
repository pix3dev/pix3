import type { ProjectManifest } from '@/core/ProjectManifest';
import type { AnimationResource } from '@pix3/runtime';

export const THEME_IDS = ['dark', 'light', 'high-contrast'] as const;

export type ThemeName = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeName = 'dark';

export type SceneLoadState = 'idle' | 'loading' | 'ready' | 'error';
export type AnimationLoadState = 'idle' | 'loading' | 'ready' | 'error';

export type EditorTabType = 'scene' | 'prefab' | 'script' | 'texture' | 'animation' | 'game';

export interface CameraState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  zoom?: number;
}

export interface TabSelectionState {
  nodeIds: string[];
  primaryNodeId: string | null;
}

export interface EditorTab {
  /** Unique tab id. Recommended: `${type}:${resourceId}`. */
  id: string;
  /** Resource identifier (e.g. `res://scenes/level.pix3scene`). */
  resourceId: string;
  type: EditorTabType;
  title: string;
  isDirty: boolean;
  /** Optional type-specific state (camera, selection, scroll position, etc.). */
  contextState?: {
    camera?: CameraState;
    selection?: TabSelectionState;
    [key: string]: unknown;
  };
}

export interface TabsState {
  tabs: EditorTab[];
  activeTabId: string | null;
}

export interface SceneDescriptor {
  id: string;
  /** File-system path relative to the project root, e.g. `res://scenes/level-1.pix3scene`. */
  filePath: string;
  name: string;
  version: string;
  isDirty: boolean;
  lastSavedAt: number | null;
  /** File system handle for opened scene files (from File System Access API). */
  fileHandle?: FileSystemFileHandle | null;
  /** Last known modification time of the file (ms), for change detection polling. */
  lastModifiedTime?: number | null;
}

export interface SceneHierarchyState {
  version: string | null;
  description: string | null;
  rootNodes: unknown[]; // NodeBase instances (avoiding circular dependency)
  metadata: Record<string, unknown>;
}

export interface ScenesState {
  /** Currently focused scene identifier. */
  activeSceneId: string | null;
  /** Map of all scene descriptors currently loaded into memory. */
  descriptors: Record<string, SceneDescriptor>;
  /** Parsed hierarchy data keyed by scene id for UI consumption. */
  hierarchies: Record<string, SceneHierarchyState>;
  loadState: SceneLoadState;
  loadError: string | null;
  /** Timestamp (ms) when the most recent scene finished loading. */
  lastLoadedAt: number | null;
  /** FIFO queue of scene file paths scheduled for loading. */
  pendingScenePaths: string[];
  /** Counter incremented when node data (properties, scripts) changes but hierarchy remains unchanged. */
  nodeDataChangeSignal: number;

  /** Per-scene camera state keyed by scene id. */
  cameraStates: Record<string, CameraState>;
  /** Per-scene camera node used for the viewport preview inset. */
  previewCameraNodeIds: Record<string, string | null>;
}

export interface AnimationDescriptor {
  id: string;
  filePath: string;
  name: string;
  version: string;
  isDirty: boolean;
  lastSavedAt: number | null;
  lastModifiedTime?: number | null;
}

export interface AnimationsState {
  /** Currently focused animation document identifier. */
  activeAnimationId: string | null;
  /** Map of animation document descriptors currently loaded into memory. */
  descriptors: Record<string, AnimationDescriptor>;
  /** Parsed animation resources keyed by animation document id. */
  resources: Record<string, AnimationResource>;
  loadState: AnimationLoadState;
  loadError: string | null;
  /** Timestamp (ms) when the most recent animation finished loading. */
  lastLoadedAt: number | null;
}

export type ProjectStatus = 'idle' | 'selecting' | 'opening' | 'ready' | 'error';
export type ProjectBackend = 'local' | 'cloud';
export type HybridSyncStatus =
  | 'unlinked'
  | 'checking'
  | 'up-to-date'
  | 'local-changes'
  | 'cloud-changes'
  | 'conflict'
  | 'syncing'
  | 'auth-required'
  | 'error';

export type ScriptLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export type ProjectOpenPhase =
  | 'idle'
  | 'fetching-access'
  | 'loading-manifest'
  | 'hydrating-cache'
  | 'connecting-collaboration'
  | 'compiling-scripts'
  | 'opening-scene';

export interface ProjectOpenProgressState {
  phase: ProjectOpenPhase;
  message: string | null;
  currentPath: string | null;
  processedFileCount: number;
  totalFileCount: number;
  processedBytes: number | null;
  totalBytes: number | null;
}

export interface ProjectHybridSyncState {
  linkedCloudProjectId: string | null;
  linkedLocalSessionId: string | null;
  linkedLocalPath: string | null;
  status: HybridSyncStatus;
  lastSyncAt: number | null;
  localChangeCount: number;
  cloudChangeCount: number;
  conflictCount: number;
  processedFileCount: number;
  totalFileCount: number;
  issues: Array<{
    path: string;
    size: number | null;
    reason: string;
  }>;
  errorMessage: string | null;
}

export interface ProjectState {
  /** Unique ID for the project (used for persistence). */
  id: string | null;
  /** Active project storage backend. */
  backend: ProjectBackend;
  /** Active project directory handle retrieved via the File System Access API. */
  directoryHandle: FileSystemDirectoryHandle | null;
  projectName: string | null;
  /** Absolute path on the local file system (e.g. /home/user/project). Used for VS Code integration. */
  localAbsolutePath: string | null;
  status: ProjectStatus;
  errorMessage: string | null;
  /** Recently opened project identifiers (storage implementation TBD). */
  recentProjects: string[];
  /** Last opened scene file relative to the project root. */
  lastOpenedScenePath: string | null;
  /** Asset browser expanded folder paths (persisted per project). */
  assetBrowserExpandedPaths: string[];
  /** Asset browser selected path (persisted per project). */
  assetBrowserSelectedPath: string | null;
  /** Current status of script compilation and loading. */
  scriptsStatus: ScriptLoadStatus;
  /** Signal counter incremented when project files change (triggers asset explorer refresh). */
  fileRefreshSignal: number;
  /** Signal counter incremented when scripts are recompiled. */
  scriptRefreshSignal: number;
  /** Directory path that was modified (e.g., 'Scenes' or 'Assets'). Used to refresh only affected folders. */
  lastModifiedDirectoryPath: string | null;
  /** Project manifest loaded from pix3project.yaml. */
  manifest: ProjectManifest | null;
  /** Progress of the current project opening/hydration pipeline. */
  openProgress: ProjectOpenProgressState;
  /** Hybrid sync state between the local folder and linked cloud project. */
  hybridSync: ProjectHybridSyncState;
}

export interface SelectionState {
  /** Nodes currently selected in the scene tree. */
  nodeIds: string[];
  /** Primary node (e.g., manipulator focus). */
  primaryNodeId: string | null;
  /** Node hovered by cursor-driven affordances. */
  hoveredNodeId: string | null;
}

export type FocusedArea = 'viewport' | 'scene-tree' | 'inspector' | 'assets' | null;

/**
 * Editor context state for keyboard shortcut execution context ("when" clauses).
 * Tracks which area of the editor is focused for context-sensitive shortcuts.
 */
export interface EditorContextState {
  /** Currently focused editor area/panel. */
  focusedArea: FocusedArea;
  /** True if an input element (input, textarea, contenteditable) has focus. */
  isInputFocused: boolean;
  /** True if a modal dialog is currently open. */
  isModalOpen: boolean;
}

export interface PanelVisibilityState {
  sceneTree: boolean;
  viewport: boolean;
  inspector: boolean;
  profiler: boolean;
  assetBrowser: boolean;
  assetsPreview: boolean;
  animation: boolean;
  logs: boolean;
}

export type NavigationMode = '2d' | '3d';
export type EditorCameraProjection = 'perspective' | 'orthographic';

export interface Navigation2DSettings {
  /** Pan sensitivity for mouse/trackpad scrolling in 2D mode */
  panSensitivity: number;
  /** Zoom sensitivity for mouse wheel/trackpad pinch in 2D mode */
  zoomSensitivity: number;
}

export type GameAspectRatio = 'free' | '16:9-landscape' | '16:9-portrait' | '4:3';

export interface UIState {
  theme: ThemeName;
  isLayoutReady: boolean;
  focusedPanelId: string | null;
  commandPaletteOpen: boolean;
  panelVisibility: PanelVisibilityState;
  navigationMode: NavigationMode;
  /** 2D navigation settings (pan/zoom sensitivity) */
  navigation2D: Navigation2DSettings;
  /** Toggle for showing the 2D orthographic layer overlay */
  showLayer2D: boolean;
  /** Toggle for showing the 3D perspective layer */
  showLayer3D: boolean;
  /** Projection mode of the editor-controlled 3D camera */
  editorCameraProjection: EditorCameraProjection;
  /** Toggle for showing the 3D grid helper */
  showGrid: boolean;
  /** Toggle for editor fallback lighting used when the scene has no explicit light sources */
  showLighting: boolean;
  /** Warn before leaving the page with unsaved changes */
  warnOnUnsavedUnload: boolean;
  /** Pause rendering when the window is unfocused for battery economy */
  pauseRenderingOnUnfocus: boolean;
  /** Preferred aspect ratio for the runtime preview surface */
  gameAspectRatio: GameAspectRatio;
  /** True when the scene is in play mode (scripts running) */
  isPlaying: boolean;
  /** True when a dedicated external game preview window is open */
  isGamePopoutOpen: boolean;
  playModeStatus: 'stopped' | 'playing' | 'paused';
}

export interface OperationState {
  /** True while a command/operation is executing. */
  isExecuting: boolean;
  /** Count of pending commands queued for execution. */
  pendingCommandCount: number;
  /** Identifier/name of the most recently executed command. */
  lastCommandId: string | null;
  /** Identifier of the last command that produced undo data. */
  lastUndoableCommandId: string | null;
}

export interface CollabRemoteUser {
  clientId: number;
  name: string;
  color: string;
  selection: string[];
}

export interface CollabParticipant {
  clientId: number | null;
  name: string;
  color: string;
}

export type CollabConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'synced';
export type CollabAccessMode = 'local' | 'cloud-edit' | 'cloud-view';
export type CollabAuthSource = 'none' | 'member' | 'share-token';
export type CollabRole = 'owner' | 'editor' | 'viewer' | null;

export interface CollaborationState {
  connectionStatus: CollabConnectionStatus;
  roomName: string | null;
  remoteUsers: CollabRemoteUser[];
  localUser: CollabParticipant | null;
  accessMode: CollabAccessMode;
  authSource: CollabAuthSource;
  role: CollabRole;
  isReadOnly: boolean;
  shareToken: string | null;
  shareEnabled: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  is_admin: boolean;
  token?: string;
}

export interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export interface TelemetryState {
  lastEventName: string | null;
  unsentEventCount: number;
}

export type RouterStatus =
  | 'idle'
  | 'authenticating'
  | 'fetchingMetadata'
  | 'loadingAssets'
  | 'reactivationRequired'
  | 'error';

export interface RouteParams {
  projectId: string | null;
  sceneId: string | null;
  nodeId: string | null;
  localSessionId: string | null;
  shareToken: string | null;
}

export interface RouterState {
  status: RouterStatus;
  currentParams: RouteParams;
  targetParams: RouteParams | null;
  errorMessage: string | null;
}

export interface AppState {
  auth: AuthState;
  router: RouterState;
  project: ProjectState;
  scenes: ScenesState;
  animations: AnimationsState;
  tabs: TabsState;
  selection: SelectionState;
  editorContext: EditorContextState;
  ui: UIState;
  operations: OperationState;
  collaboration: CollaborationState;
  telemetry: TelemetryState;
}

export const createInitialHybridSyncState = (): ProjectHybridSyncState => ({
  linkedCloudProjectId: null,
  linkedLocalSessionId: null,
  linkedLocalPath: null,
  status: 'unlinked',
  lastSyncAt: null,
  localChangeCount: 0,
  cloudChangeCount: 0,
  conflictCount: 0,
  processedFileCount: 0,
  totalFileCount: 0,
  issues: [],
  errorMessage: null,
});

export const createInitialProjectOpenProgressState = (): ProjectOpenProgressState => ({
  phase: 'idle',
  message: null,
  currentPath: null,
  processedFileCount: 0,
  totalFileCount: 0,
  processedBytes: null,
  totalBytes: null,
});

export const createInitialAppState = (): AppState => ({
  auth: {
    user: null,
    isAuthenticated: false,
    isLoading: true,
  },
  router: {
    status: 'idle',
    currentParams: {
      projectId: null,
      sceneId: null,
      nodeId: null,
      localSessionId: null,
      shareToken: null,
    },
    targetParams: null,
    errorMessage: null,
  },
  project: {
    id: null,
    backend: 'local',
    directoryHandle: null,
    projectName: null,
    localAbsolutePath: null,
    status: 'idle',
    errorMessage: null,
    recentProjects: [],
    lastOpenedScenePath: null,
    assetBrowserExpandedPaths: [],
    assetBrowserSelectedPath: null,
    scriptsStatus: 'idle',
    fileRefreshSignal: 0,
    scriptRefreshSignal: 0,
    lastModifiedDirectoryPath: null,
    manifest: null,
    openProgress: createInitialProjectOpenProgressState(),
    hybridSync: createInitialHybridSyncState(),
  },
  scenes: {
    activeSceneId: null,
    descriptors: {},
    hierarchies: {},
    loadState: 'idle',
    loadError: null,
    lastLoadedAt: null,
    pendingScenePaths: [],
    nodeDataChangeSignal: 0,
    cameraStates: {},
    previewCameraNodeIds: {},
  },
  animations: {
    activeAnimationId: null,
    descriptors: {},
    resources: {},
    loadState: 'idle',
    loadError: null,
    lastLoadedAt: null,
  },
  tabs: {
    tabs: [],
    activeTabId: null,
  },
  selection: {
    nodeIds: [],
    primaryNodeId: null,
    hoveredNodeId: null,
  },
  editorContext: {
    focusedArea: null,
    isInputFocused: false,
    isModalOpen: false,
  },
  ui: {
    theme: DEFAULT_THEME,
    isLayoutReady: false,
    focusedPanelId: null,
    commandPaletteOpen: false,
    panelVisibility: {
      sceneTree: true,
      viewport: true,
      inspector: true,
      profiler: true,
      assetBrowser: true,
      assetsPreview: true,
      animation: true,
      logs: true,
    },
    navigationMode: '3d',
    navigation2D: {
      panSensitivity: 0.75,
      zoomSensitivity: 0.001,
    },
    showLayer2D: true,
    showLayer3D: true,
    editorCameraProjection: 'perspective',
    showGrid: true,
    showLighting: true,
    warnOnUnsavedUnload: true,
    pauseRenderingOnUnfocus: true,
    gameAspectRatio: 'free',
    isPlaying: false,
    isGamePopoutOpen: false,
    playModeStatus: 'stopped',
  },
  operations: {
    isExecuting: false,
    pendingCommandCount: 0,
    lastCommandId: null,
    lastUndoableCommandId: null,
  },
  collaboration: {
    connectionStatus: 'disconnected',
    roomName: null,
    remoteUsers: [],
    localUser: null,
    accessMode: 'local',
    authSource: 'none',
    role: null,
    isReadOnly: false,
    shareToken: null,
    shareEnabled: false,
  },
  telemetry: {
    lastEventName: null,
    unsentEventCount: 0,
  },
});
