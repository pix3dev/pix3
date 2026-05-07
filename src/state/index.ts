import { proxy, snapshot, type Snapshot } from 'valtio/vanilla';

import type { AppState } from './AppState';
import { createInitialAppState } from './AppState';

export const appState = proxy<AppState>(createInitialAppState());

export type AppStateSnapshot = Snapshot<AppState>;

export const getAppStateSnapshot = (): AppStateSnapshot => snapshot(appState);

/**
 * Clears the application state back to its default snapshot. Use sparingly—ideally
 * only from bootstrapping flows or test fixtures—so that commands remain the
 * primary mutation mechanism in production code.
 */
export const resetAppState = (): void => {
  const defaults = createInitialAppState();
  appState.auth = defaults.auth;
  appState.project = defaults.project;
  appState.scenes = defaults.scenes;
  appState.animations = defaults.animations;
  appState.tabs = defaults.tabs;
  appState.selection = defaults.selection;
  appState.ui = defaults.ui;
  appState.operations = defaults.operations;
  appState.collaboration = defaults.collaboration;
  appState.telemetry = defaults.telemetry;
  appState.router = defaults.router;
};

export {
  DEFAULT_THEME,
  THEME_IDS,
  createInitialAppState,
  createInitialHybridSyncState,
  createInitialProjectOpenProgressState,
} from './AppState';

export type {
  AnimationDescriptor,
  AnimationLoadState,
  AnimationsState,
  AppState,
  CameraState,
  CodeEditorContextState,
  CodeEditorSelectionState,
  CollabConnectionStatus,
  CollabRemoteUser,
  CollaborationState,
  EditorCameraProjection,
  EditorTab,
  HybridSyncStatus,
  EditorTabType,
  NavigationMode,
  OperationState,
  PanelVisibilityState,
  ProjectBackend,
  ProjectHybridSyncState,
  ProjectOpenPhase,
  ProjectOpenProgressState,
  ProjectState,
  ProjectStatus,
  SceneDescriptor,
  SceneHierarchyState,
  SceneLoadState,
  ScenesState,
  SelectionState,
  TabsState,
  TelemetryState,
  ThemeName,
  UIState,
  RouterState,
  RouterStatus,
  RouteParams,
} from './AppState';
