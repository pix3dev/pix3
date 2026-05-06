import { subscribe } from 'valtio/vanilla';

import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { LayoutManagerService } from '@/core/LayoutManager';
import { OperationService } from '@/services/OperationService';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { CommandRegistry } from '@/services/CommandRegistry';
import { KeybindingService } from '@/services/KeybindingService';
import { FileWatchService } from '@/services/FileWatchService';
import { DialogService, type DialogInstance } from '@/services/DialogService';
import { AnimationAutoSliceDialogService, type AnimationAutoSliceDialogInstance } from '@/services';
import {
  BehaviorPickerService,
  type ComponentPickerInstance,
} from '@/services/BehaviorPickerService';
import { ScriptCreatorService, type ScriptCreationInstance } from '@/services/ScriptCreatorService';
import {
  ProjectSettingsService,
  type ProjectSettingsDialogInstance,
} from '@/services/ProjectSettingsService';
import { ProjectSyncService, type ProjectSyncDialogInstance } from '@/services/ProjectSyncService';
import {
  EditorSettingsService,
  type EditorSettingsDialogInstance,
} from '@/services/EditorSettingsService';
import {
  NodeTypePickerService,
  type NodeTypePickerInstance,
} from '@/services/NodeTypePickerService';
import { ScriptExecutionService } from '@/services/ScriptExecutionService';
import { AutoloadService } from '@/services/AutoloadService';
import { ProjectScriptLoaderService } from '@/services/ProjectScriptLoaderService';
import { ScriptCompilerService } from '@/services/ScriptCompilerService';
import { SaveActiveResourceCommand } from '@/features/editor/SaveActiveResourceCommand';
import { SaveAsSceneCommand } from '@/features/scene/SaveAsSceneCommand';
import { ReloadSceneCommand } from '@/features/scene/ReloadSceneCommand';
import { RefreshPrefabInstancesCommand } from '@/features/scene/RefreshPrefabInstancesCommand';
import { DeleteObjectCommand } from '@/features/scene/DeleteObjectCommand';
import { DuplicateNodesCommand } from '@/features/scene/DuplicateNodesCommand';
import { GroupSelectedNodesCommand } from '@/features/scene/GroupSelectedNodesCommand';
import { SaveAsPrefabCommand } from '@/features/scene/SaveAsPrefabCommand';
import { UndoCommand } from '@/features/history/UndoCommand';
import { RedoCommand } from '@/features/history/RedoCommand';
import { StartGameCommand } from '@/features/scripts/StartGameCommand';
import { StopGameCommand } from '@/features/scripts/StopGameCommand';
import { RestartGameCommand } from '@/features/scripts/RestartGameCommand';
import { OpenGamePopoutWindowCommand } from '@/features/scripts/OpenGamePopoutWindowCommand';
import { OpenProjectSettingsCommand } from '@/features/project/OpenProjectSettingsCommand';
import { OpenProjectSyncCommand } from '@/features/project/OpenProjectSyncCommand';
import { OpenProjectInIdeCommand } from '@/features/project/OpenProjectInIdeCommand';
import { BuildProjectCommand } from '@/features/project/BuildProjectCommand';
import { NewProjectCommand } from '@/features/project/NewProjectCommand';
import { CloseProjectCommand } from '@/features/project/CloseProjectCommand';
import { OpenEditorSettingsCommand } from '@/features/editor/OpenEditorSettingsCommand';
import { SetTransformModeCommand } from '@/features/viewport/SetTransformModeCommand';
import { ToggleGridCommand } from '@/features/viewport/ToggleGridCommand';
import { ToggleLayer2DCommand } from '@/features/viewport/ToggleLayer2DCommand';
import { ToggleLayer3DCommand } from '@/features/viewport/ToggleLayer3DCommand';
import { ZoomDefaultCommand } from '@/features/viewport/ZoomDefaultCommand';
import { ZoomAllCommand } from '@/features/viewport/ZoomAllCommand';
import { ToggleLightingCommand } from '@/features/viewport/ToggleLightingCommand';
import { ToggleNavigationModeCommand } from '@/features/viewport/ToggleNavigationModeCommand';
import { appState } from '@/state';
import { ProjectService } from '@/services';
import { GamePlaySessionService } from '@/services/GamePlaySessionService';
import { EditorTabService } from '@/services/EditorTabService';
import { RouterService } from '@/services/RouterService';
import { AuthService } from '@/services/AuthService';
import { CloudProjectService } from '@/services/CloudProjectService';
import { UpdateCheckService } from '@/services/UpdateCheckService';
import {
  ProjectLifecycleService,
  type CreateProjectDialogInstance,
} from '@/services/ProjectLifecycleService';
import './shared/pix3-toolbar';
import './shared/pix3-toolbar-button';
import './shared/pix3-main-menu';
import './shared/pix3-confirm-dialog';
import './shared/pix3-behavior-picker';
import './shared/pix3-script-creator';
import './shared/pix3-create-project-dialog';
import './shared/pix3-project-settings-dialog';
import './shared/pix3-project-sync-dialog';
import './shared/pix3-editor-settings-dialog';
import './shared/pix3-animation-auto-slice-dialog';
import './shared/pix3-node-type-picker';
import './shared/pix3-status-bar';
import './shared/pix3-background';
import './collab/collab-participants-strip';
import './collab/pix3-share-dialog';
import './welcome/pix3-welcome';
import './auth/pix3-auth-screen';
import './logs-view/logs-panel';
import './assets-preview/assets-preview-panel';
import './profiler/profiler-panel';
import './animation-editor/animation-panel';
import './viewport/game-tab';
import './pix3-editor-shell.ts.css';

@customElement('pix3-editor')
export class Pix3EditorShell extends ComponentBase {
  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  @inject(AuthService)
  private readonly authService!: AuthService;

  @inject(CloudProjectService)
  private readonly cloudProjectService!: CloudProjectService;

  @inject(ProjectLifecycleService)
  private readonly projectLifecycleService!: ProjectLifecycleService;

  @inject(UpdateCheckService)
  private readonly updateCheckService!: UpdateCheckService;

  @inject(OperationService)
  private readonly operationService!: OperationService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(CommandRegistry)
  private readonly commandRegistry!: CommandRegistry;

  @inject(KeybindingService)
  private readonly keybindingService!: KeybindingService;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @inject(GamePlaySessionService)
  private readonly gamePlaySessionService!: GamePlaySessionService;

  @inject(FileWatchService)
  private readonly fileWatchService!: FileWatchService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(BehaviorPickerService)
  private readonly behaviorPickerService!: BehaviorPickerService;

  @inject(AnimationAutoSliceDialogService)
  private readonly animationAutoSliceDialogService!: AnimationAutoSliceDialogService;

  @inject(ScriptCreatorService)
  private readonly scriptCreatorService!: ScriptCreatorService;

  @inject(RouterService)
  private readonly routerService!: RouterService;

  @inject(ProjectSettingsService)
  private readonly projectSettingsService!: ProjectSettingsService;

  @inject(ProjectSyncService)
  private readonly projectSyncService!: ProjectSyncService;

  @inject(EditorSettingsService)
  private readonly editorSettingsService!: EditorSettingsService;

  @inject(NodeTypePickerService)
  private readonly nodeTypePickerService!: NodeTypePickerService;

  @inject(ScriptExecutionService)
  private readonly scriptExecutionService!: ScriptExecutionService;

  @inject(ProjectScriptLoaderService)
  private readonly _projectScriptLoader!: ProjectScriptLoaderService; // Injected to ensure service initialization

  @inject(ScriptCompilerService)
  private readonly _scriptCompiler!: ScriptCompilerService; // Injected to ensure service initialization

  @inject(AutoloadService)
  private readonly _autoloadService!: AutoloadService; // Injected to ensure autoload lifecycle initialization

  // project open handled by <pix3-welcome>

  @state()
  private isAuthenticated = appState.auth.isAuthenticated;

  @state()
  private isLayoutReady = appState.ui.isLayoutReady;

  @state()
  private routerStatus = appState.router.status;

  @state()
  private currentHash =
    typeof window !== 'undefined' ? window.location.hash || '#editor' : '#editor';

  @state()
  private dialogs: DialogInstance[] = [];

  @state()
  private componentPickers: ComponentPickerInstance[] = [];

  @state()
  private scriptCreators: ScriptCreationInstance[] = [];

  @state()
  private activeProjectSettingsDialog: ProjectSettingsDialogInstance | null = null;

  @state()
  private activeProjectSyncDialog: ProjectSyncDialogInstance | null = null;

  @state()
  private activeEditorSettingsDialog: EditorSettingsDialogInstance | null = null;

  @state()
  private activeAnimationAutoSliceDialog: AnimationAutoSliceDialogInstance | null = null;

  @state()
  private activeNodeTypePicker: NodeTypePickerInstance | null = null;

  @state()
  private isAuthModalOpen = false;

  @state()
  private pendingAuthProjectId: string | null = null;

  @state()
  private activeCreateProjectDialog: CreateProjectDialogInstance | null = null;

  @state()
  private isAccountPopoverOpen = false;

  @property({ type: Boolean, reflect: true, attribute: 'shell-ready' })
  protected shellReady = false;

  private disposeAuthSubscription?: () => void;
  private disposeSubscription?: () => void;
  private disposeUiSubscription?: () => void;
  private disposeScenesSubscription?: () => void;
  private disposeProjectSubscription?: () => void;
  private disposeDialogsSubscription?: () => void;
  private disposeProjectSettingsSubscription?: () => void;
  private disposeProjectSyncSubscription?: () => void;
  private disposeEditorSettingsSubscription?: () => void;
  private disposeCreateProjectSubscription?: () => void;
  private disposeNodeTypePickerSubscription?: () => void;
  private disposeBehaviorPickerSubscription?: () => void;
  private disposeScriptCreatorSubscription?: () => void;
  private disposeAnimationAutoSliceSubscription?: () => void;
  private onWelcomeProjectReady?: (e: Event) => void;
  private keyboardHandler?: (e: KeyboardEvent) => void;
  private accountPopoverPointerHandler?: (e: PointerEvent) => void;
  private hashChangeHandler?: () => void;
  private watchedSceneIds = new Set<string>();
  private watchedScenePaths = new Map<string, string>();
  private tabsInitialized = false;
  private isResumingRouterTarget = false;
  private previousIsPlaying = appState.ui.isPlaying;
  private returnPanelAfterPlay: 'inspector' | 'profiler' | null = null;

  connectedCallback(): void {
    super.connectedCallback();

    // Register history commands and scene commands
    const saveCommand = new SaveActiveResourceCommand();
    const saveAsCommand = new SaveAsSceneCommand();
    const deleteCommand = new DeleteObjectCommand();
    const duplicateCommand = new DuplicateNodesCommand();
    const groupSelectedCommand = new GroupSelectedNodesCommand();
    const saveAsPrefabCommand = new SaveAsPrefabCommand();
    const undoCommand = new UndoCommand(this.operationService);
    const redoCommand = new RedoCommand(this.operationService);
    const startGameCommand = new StartGameCommand(
      this.editorTabService,
      this.gamePlaySessionService
    );
    const stopGameCommand = new StopGameCommand(this.editorTabService, this.gamePlaySessionService);
    const restartGameCommand = new RestartGameCommand(this.gamePlaySessionService);
    const openGamePopoutWindowCommand = new OpenGamePopoutWindowCommand(
      this.gamePlaySessionService
    );
    const projectSettingsCommand = new OpenProjectSettingsCommand();
    const projectSyncCommand = new OpenProjectSyncCommand();
    const openProjectInIdeCommand = new OpenProjectInIdeCommand();
    const buildProjectCommand = new BuildProjectCommand();
    const newProjectCommand = new NewProjectCommand();
    const closeProjectCommand = new CloseProjectCommand();
    const editorSettingsCommand = new OpenEditorSettingsCommand();

    // Register viewport commands
    const selectModeCommand = new SetTransformModeCommand('select');
    const translateModeCommand = new SetTransformModeCommand('translate');
    const rotateModeCommand = new SetTransformModeCommand('rotate');
    const scaleModeCommand = new SetTransformModeCommand('scale');
    const toggleGridCommand = new ToggleGridCommand();
    const toggleLayer2DCommand = new ToggleLayer2DCommand();
    const toggleLayer3DCommand = new ToggleLayer3DCommand();
    const zoomDefaultCommand = new ZoomDefaultCommand();
    const zoomAllCommand = new ZoomAllCommand();
    const toggleLightingCommand = new ToggleLightingCommand();
    const toggleNavigationModeCommand = new ToggleNavigationModeCommand();

    this.commandRegistry.registerMany(
      undoCommand,
      redoCommand,
      saveCommand,
      saveAsCommand,
      deleteCommand,
      duplicateCommand,
      groupSelectedCommand,
      saveAsPrefabCommand,
      startGameCommand,
      stopGameCommand,
      restartGameCommand,
      openGamePopoutWindowCommand,
      editorSettingsCommand,
      newProjectCommand,
      closeProjectCommand,
      projectSettingsCommand,
      projectSyncCommand,
      openProjectInIdeCommand,
      buildProjectCommand,
      selectModeCommand,
      translateModeCommand,
      rotateModeCommand,
      scaleModeCommand,
      toggleGridCommand,
      toggleLayer2DCommand,
      toggleLayer3DCommand,
      zoomDefaultCommand,
      zoomAllCommand,
      toggleLightingCommand,
      toggleNavigationModeCommand
    );

    // Subscribe to dialog changes
    this.disposeDialogsSubscription = this.dialogService.subscribe(dialogs => {
      this.dialogs = dialogs;
      this.requestUpdate();
    });

    // Subscribe to project settings dialog changes
    this.disposeProjectSettingsSubscription = this.projectSettingsService.subscribe(dialog => {
      this.activeProjectSettingsDialog = dialog;
      this.requestUpdate();
    });

    this.disposeProjectSyncSubscription = this.projectSyncService.subscribe(dialog => {
      this.activeProjectSyncDialog = dialog;
      this.requestUpdate();
    });

    this.disposeEditorSettingsSubscription = this.editorSettingsService.subscribe(dialog => {
      this.activeEditorSettingsDialog = dialog;
      this.requestUpdate();
    });

    this.disposeAnimationAutoSliceSubscription = this.animationAutoSliceDialogService.subscribe(
      dialog => {
        this.activeAnimationAutoSliceDialog = dialog;
        this.requestUpdate();
      }
    );

    this.disposeCreateProjectSubscription = this.projectLifecycleService.subscribe(dialog => {
      this.activeCreateProjectDialog = dialog;
      this.requestUpdate();
    });

    this.disposeNodeTypePickerSubscription = this.nodeTypePickerService.subscribe(picker => {
      this.activeNodeTypePicker = picker;
      this.requestUpdate();
    });

    // Touch injected services to avoid unused var lint error (they are singletons for side-effects)
    void this._projectScriptLoader;
    void this._scriptCompiler;
    void this._autoloadService;

    // Subscribe to component picker changes
    this.disposeBehaviorPickerSubscription = this.behaviorPickerService.subscribe(pickers => {
      this.componentPickers = pickers;
      this.requestUpdate();
    });

    // Subscribe to script creator changes
    this.disposeScriptCreatorSubscription = this.scriptCreatorService.subscribe(creators => {
      this.scriptCreators = creators;
      this.requestUpdate();
    });

    // Setup keyboard shortcuts
    this.keyboardHandler = this.handleKeyboardShortcuts.bind(this);
    window.addEventListener('keydown', this.keyboardHandler);

    this.accountPopoverPointerHandler = this.handleAccountPopoverPointerDown.bind(this);
    window.addEventListener('pointerdown', this.accountPopoverPointerHandler);

    // Initialize tab service early to catch session persistence
    this.editorTabService.initialize();
    this.gamePlaySessionService.initialize();
    this.updateCheckService.initialize();

    this.editorSettingsService.initialize();
    this.routerService.initialize();

    // Restore auth session on startup
    void this.authService.restoreSession();

    this.disposeAuthSubscription = subscribe(appState.auth, () => {
      this.isAuthenticated = appState.auth.isAuthenticated;
      if (
        this.isAuthenticated &&
        appState.router.status === 'authenticating' &&
        appState.router.targetParams &&
        !this.isResumingRouterTarget
      ) {
        this.isResumingRouterTarget = true;
        void this.routerService
          .resumeTargetSession()
          .catch(error => {
            console.error(
              '[Pix3EditorShell] Failed to resume routed session after auth restore',
              error
            );
          })
          .finally(() => {
            this.isResumingRouterTarget = false;
            this.requestUpdate();
          });
      }
      this.requestUpdate();
    });

    this.disposeSubscription = subscribe(appState.router, () => {
      this.routerStatus = appState.router.status;
      if (this.routerStatus === 'authenticating' && !this.isAuthModalOpen) {
        this.openAuthModal();
      }
      this.requestUpdate();
    });

    this.hashChangeHandler = () => {
      this.currentHash = window.location.hash || '#editor';
    };
    window.addEventListener('hashchange', this.hashChangeHandler);

    this.disposeUiSubscription = subscribe(appState.ui, () => {
      this.syncProfilerPanelFocusWithPlayMode();
      this.isLayoutReady = appState.ui.isLayoutReady;
      this.shellReady = this.isLayoutReady;
      this.requestUpdate();
    });
    // also subscribe to project state so we can initialize layout once a project is opened
    this.disposeProjectSubscription = subscribe(appState.project, () => {
      // We now initialize layout unconditionally or when ready
      const host = this.renderRoot.querySelector<HTMLDivElement>('.layout-host');
      if (host && !this.shellReady) {
        void this.layoutManager.initialize(host).then(async () => {
          this.shellReady = true;
          this.requestUpdate();

          // Restore previously open tabs from session storage.
          if (!this.tabsInitialized) {
            this.tabsInitialized = true;

            if (appState.project.id) {
              // Wait for project scripts to be compiled before restoring the session
              // to ensure custom components are available in the ScriptRegistry.
              await this.waitForScripts();
              await this.editorTabService.restoreProjectSession(appState.project.id);
            }
          }
        });
      }

      this.requestUpdate();
    });

    // Subscribe to scene descriptor changes to start/stop file watching
    this.disposeScenesSubscription = subscribe(appState.scenes, () => {
      this.updateSceneWatchers();

      // Notify script execution service of scene changes
      const activeSceneId = appState.scenes.activeSceneId;
      this.scriptExecutionService.onSceneChanged(activeSceneId);
    });

    // If the app was reloaded (HMR) and the URL indicates the editor, try to auto-open
    // the most recent project so the shell will initialize and avoid showing the welcome UI.
    try {
      if (typeof window !== 'undefined' && window.location.hash === '') {
        // Default to editor if no hash is set
        window.location.hash = '#editor';
      }

      this.currentHash = window.location.hash || '#editor';

      const isEditor = window.location.hash.startsWith('#editor');
      if (typeof window !== 'undefined' && isEditor) {
        const { currentParams } = appState.router;
        const noTargetFound = !currentParams.projectId && !currentParams.localSessionId;

        // If a project is not already open, attempt to open the most recent one (best-effort).
        if (noTargetFound && appState.project.status !== 'ready') {
          const recents = this.projectService.getRecentProjects();
          const preferredRecent =
            recents.find(entry => entry.backend === 'local') ??
            (this.isAuthenticated ? recents[0] : null);

          if (preferredRecent) {
            // Don't block the UI; attempt to open the most recent project in background.
            void this.projectService.openRecentProject(preferredRecent).catch(() => {
              // If auto-open fails (permission denied or no handle), redirect to welcome.
              window.location.hash = '#welcome';
            });
          } else {
            window.location.hash = '#welcome';
          }
        }
      }
    } catch {
      // ignore environment where window/history isn't available
    }

    // Check if we already have target params locally wait for router to naturally take over
    // if not, it will just drop into the empty screen below.

    // Listen for the welcome component signaling that project is ready so
    // the shell can switch to the editor route and let Lit reconcile the overlay.
    this.onWelcomeProjectReady = () => {
      this.syncEditorRoute();
    };
    this.addEventListener(
      'pix3-welcome:project-ready',
      this.onWelcomeProjectReady as EventListener
    );
  }

  disconnectedCallback(): void {
    this.disposeAuthSubscription?.();
    this.disposeAuthSubscription = undefined;
    this.disposeSubscription?.();
    this.disposeSubscription = undefined;
    this.disposeUiSubscription?.();
    this.disposeUiSubscription = undefined;
    this.disposeScenesSubscription?.();
    this.disposeScenesSubscription = undefined;
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = undefined;
    this.disposeDialogsSubscription?.();
    this.disposeDialogsSubscription = undefined;
    this.disposeProjectSettingsSubscription?.();
    this.disposeProjectSettingsSubscription = undefined;
    this.disposeProjectSyncSubscription?.();
    this.disposeProjectSyncSubscription = undefined;
    this.disposeEditorSettingsSubscription?.();
    this.disposeEditorSettingsSubscription = undefined;
    this.disposeCreateProjectSubscription?.();
    this.disposeCreateProjectSubscription = undefined;
    this.disposeNodeTypePickerSubscription?.();
    this.disposeNodeTypePickerSubscription = undefined;
    this.disposeBehaviorPickerSubscription?.();
    this.disposeBehaviorPickerSubscription = undefined;
    this.disposeScriptCreatorSubscription?.();
    this.disposeScriptCreatorSubscription = undefined;
    this.disposeAnimationAutoSliceSubscription?.();
    this.disposeAnimationAutoSliceSubscription = undefined;
    if (this.onWelcomeProjectReady) {
      this.removeEventListener(
        'pix3-welcome:project-ready',
        this.onWelcomeProjectReady as EventListener
      );
      this.onWelcomeProjectReady = undefined;
    }
    if (this.keyboardHandler) {
      window.removeEventListener('keydown', this.keyboardHandler);
      this.keyboardHandler = undefined;
    }
    if (this.accountPopoverPointerHandler) {
      window.removeEventListener('pointerdown', this.accountPopoverPointerHandler);
      this.accountPopoverPointerHandler = undefined;
    }
    if (this.hashChangeHandler) {
      window.removeEventListener('hashchange', this.hashChangeHandler);
      this.hashChangeHandler = undefined;
    }
    // Stop all file watchers
    this.fileWatchService.unwatchAll();
    // Stop script execution service
    this.scriptExecutionService.stop();
    super.disconnectedCallback();
  }

  private handleKeyboardShortcuts(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.isAccountPopoverOpen) {
      this.isAccountPopoverOpen = false;
      this.requestUpdate();
      return;
    }

    // Use KeybindingService to find matching command
    const commandId = this.keybindingService.handleKeyboardEvent(e);
    if (commandId) {
      e.preventDefault();
      void this.commandDispatcher.executeById(commandId);
    }
  }

  private syncProfilerPanelFocusWithPlayMode(): void {
    const isPlaying = appState.ui.isPlaying;
    if (isPlaying === this.previousIsPlaying) {
      return;
    }

    if (isPlaying) {
      const focusedPanelId = appState.ui.focusedPanelId;
      this.returnPanelAfterPlay =
        focusedPanelId === 'inspector' || focusedPanelId === 'profiler'
          ? focusedPanelId
          : 'inspector';
      this.layoutManager.focusPanel('profiler');
    } else {
      const panelToRestore = this.returnPanelAfterPlay ?? 'inspector';
      this.layoutManager.focusPanel(panelToRestore);
      this.returnPanelAfterPlay = null;
    }

    this.previousIsPlaying = isPlaying;
  }

  private handleAccountPopoverPointerDown(e: PointerEvent): void {
    if (!this.isAccountPopoverOpen) {
      return;
    }

    const path = e.composedPath();
    const clickedToolbarButton = path.some(
      target =>
        target instanceof HTMLElement &&
        target.tagName.toLowerCase() === 'pix3-toolbar-button' &&
        target.getAttribute('aria-label') === 'Open account menu'
    );
    const clickedPopover = path.some(
      target => target instanceof HTMLElement && target.classList.contains('account-popover')
    );

    if (!clickedToolbarButton && !clickedPopover) {
      this.isAccountPopoverOpen = false;
      this.requestUpdate();
    }
  }

  private onDialogConfirmed(e: CustomEvent): void {
    const dialogId = e.detail.dialogId;
    this.dialogService.confirm(dialogId);
  }

  private onDialogCancelled(e: CustomEvent): void {
    const dialogId = e.detail.dialogId;
    this.dialogService.cancel(dialogId);
  }

  /**
   * Update file watchers based on currently loaded scenes.
   * Starts watching new scenes with file handles, stops watching removed scenes.
   */
  private updateSceneWatchers(): void {
    const currentSceneIds = new Set(Object.keys(appState.scenes.descriptors));

    // Stop watching scenes that are no longer loaded
    for (const sceneId of this.watchedSceneIds) {
      if (!currentSceneIds.has(sceneId)) {
        const descriptor = appState.scenes.descriptors[sceneId];
        if (descriptor?.filePath) {
          this.fileWatchService.unwatch(descriptor.filePath);
        }
        this.watchedSceneIds.delete(sceneId);
        this.watchedScenePaths.delete(sceneId);
      }
    }

    // Start watching new scenes that have file handles
    for (const sceneId of currentSceneIds) {
      const descriptor = appState.scenes.descriptors[sceneId];
      const currentPath = descriptor?.filePath ?? '';
      const previousPath = this.watchedScenePaths.get(sceneId) ?? '';

      // If a scene's path changed (e.g., Save As inside project), rewire watchers.
      if (previousPath && currentPath && previousPath !== currentPath) {
        this.fileWatchService.unwatch(previousPath);
        this.watchedSceneIds.delete(sceneId);
        this.watchedScenePaths.delete(sceneId);
      }

      if (!this.watchedSceneIds.has(sceneId)) {
        if (descriptor?.fileHandle && currentPath) {
          // Only watch res:// paths (project files)
          if (currentPath.startsWith('res://')) {
            this.fileWatchService.watch(
              currentPath,
              descriptor.fileHandle,
              descriptor.lastModifiedTime,
              () => this.handleFileChanged(sceneId, currentPath)
            );
            this.watchedSceneIds.add(sceneId);
            this.watchedScenePaths.set(sceneId, currentPath);
          }
        }
      }
    }
  }

  /**
   * Handle external file change detection - reload the scene.
   */
  private handleFileChanged(sceneId: string, filePath: string): void {
    if (import.meta.env.DEV) {
      console.debug('[Pix3EditorShell] External scene file change detected', {
        sceneId,
        filePath,
      });
    }

    // Execute reload command
    const reloadCommand = new ReloadSceneCommand({ sceneId, filePath });
    void this.commandDispatcher.execute(reloadCommand).catch(error => {
      console.error('[Pix3EditorShell] Failed to reload scene from external change:', error);
    });

    const activeSceneId = appState.scenes.activeSceneId;
    if (activeSceneId && activeSceneId !== sceneId) {
      const refreshCommand = new RefreshPrefabInstancesCommand({
        sceneId: activeSceneId,
        changedPrefabPath: filePath,
      });
      void this.commandDispatcher.execute(refreshCommand).catch(error => {
        console.error('[Pix3EditorShell] Failed to refresh active scene prefab instances:', error);
      });
    }
  }

  private syncEditorRoute(): void {
    if (
      typeof window === 'undefined' ||
      appState.project.status !== 'ready' ||
      !appState.project.id
    ) {
      return;
    }

    const params = new URLSearchParams();
    if (appState.project.backend === 'cloud') {
      params.set('project', appState.project.id);
    } else {
      params.set('local', appState.project.id);
    }

    if (appState.scenes.activeSceneId) {
      params.set('scene', appState.scenes.activeSceneId);
    }

    if (appState.selection.primaryNodeId) {
      params.set('select', appState.selection.primaryNodeId);
    }

    const nextHash = params.toString() ? `#editor?${params.toString()}` : '#editor';
    this.currentHash = nextHash;

    if (window.location.hash !== nextHash) {
      history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${nextHash}`
      );
    }
  }

  protected async firstUpdated(): Promise<void> {
    const host = this.renderRoot.querySelector<HTMLDivElement>('.layout-host');
    if (!host) {
      return;
    }

    // Only initialize the Golden Layout if a project is already opened.
    if (appState.project.status === 'ready') {
      await this.layoutManager.initialize(host);
      this.shellReady = true;

      // Open startup scene when no tabs exist.
      if (!this.tabsInitialized) {
        this.tabsInitialized = true;
        if (appState.tabs.tabs.length === 0) {
          const pending = appState.scenes.pendingScenePaths[0];
          if (pending) {
            if (import.meta.env.DEV) {
              console.debug('[Pix3Editor] Opening startup scene tab', { pending });
            }
            await this.editorTabService.openResourceTab('scene', pending);
          }
        }
      }
    }
  }

  protected render() {
    return html`
      <div class="editor-shell" data-ready=${this.shellReady ? 'true' : 'false'}>
        <div class="toolbar-layer">${this.renderToolbar()} ${this.renderAccountPopover()}</div>
        <div class="workspace" role="presentation">
          <div class="layout-host" role="application" aria-busy=${!this.isLayoutReady}></div>
        </div>
        <pix3-status-bar></pix3-status-bar>
        ${this.renderWorkspaceOverlay()}
        <pix3-share-dialog @pix3-auth:request=${this.onAuthRequest}></pix3-share-dialog>
        ${this.renderDialogHost()} ${this.renderPickerHost()} ${this.renderScriptCreatorHost()}
        ${this.renderProjectSettingsHost()} ${this.renderProjectSyncHost()}
        ${this.renderEditorSettingsHost()} ${this.renderAnimationAutoSliceHost()}
        ${this.renderCreateProjectHost()} ${this.renderNodeTypePickerHost()}
        ${this.renderAuthModal()}
      </div>
    `;
  }

  private renderToolbar() {
    const isPlaying = appState.ui.isPlaying;
    return html`
      <pix3-toolbar aria-label="Editor toolbar">
        <pix3-main-menu slot="start"></pix3-main-menu>
        <div class="toolbar-content">
          <div class="toolbar-group">
            <pix3-toolbar-button
              icon=${isPlaying ? 'square' : 'play'}
              iconOnly
              label=${isPlaying ? 'Stop' : 'Play'}
              ?toggled=${isPlaying}
              @click=${() => this.togglePlayMode()}
              aria-label=${isPlaying ? 'Stop Scene' : 'Play Scene'}
            ></pix3-toolbar-button>
          </div>
          <span> Project: ${appState.project.projectName ?? 'No project open'} </span>
          <collab-participants-strip></collab-participants-strip>
        </div>
        <pix3-toolbar-button
          slot="actions"
          .icon=${this.isAuthenticated ? null : 'log-in'}
          label=${this.isAuthenticated ? 'Account' : 'Login'}
          ?iconOnly=${this.isAuthenticated}
          @click=${this.onAuthButtonClick}
          aria-label=${this.isAuthenticated ? 'Open account menu' : 'Open login'}
        >
          ${this.isAuthenticated
            ? html`<span class="account-avatar">${this.getUserInitials()}</span>`
            : 'Login'}
        </pix3-toolbar-button>
        <pix3-toolbar-button
          slot="actions"
          icon="share-2"
          label="Share Project"
          @click=${this.openShareDialog}
          aria-label="Share Project"
        >
          Share
        </pix3-toolbar-button>
      </pix3-toolbar>
    `;
  }

  private openShareDialog = (): void => {
    const dialog = this.renderRoot.querySelector('pix3-share-dialog');
    dialog?.openDialog();
  };

  private openAuthModal = (): void => {
    this.pendingAuthProjectId = null;
    this.isAuthModalOpen = true;
    this.isAccountPopoverOpen = false;
  };

  private closeAuthModal = (): void => {
    this.isAuthModalOpen = false;
    this.pendingAuthProjectId = null;
  };

  private onAuthRequest = (event: CustomEvent<{ projectId: string | null }>): void => {
    this.pendingAuthProjectId = event.detail.projectId ?? null;
    this.isAuthModalOpen = true;
    this.isAccountPopoverOpen = false;
  };

  private onAuthSuccess = async (): Promise<void> => {
    const pendingProjectId = this.pendingAuthProjectId;
    this.isAuthModalOpen = false;
    this.pendingAuthProjectId = null;

    await this.cloudProjectService.loadProjects();

    if (this.projectLifecycleService.hasPendingCloudCreation()) {
      await this.projectLifecycleService.resumePendingCloudCreation();
      return;
    }

    if (pendingProjectId) {
      await this.cloudProjectService.openProject(pendingProjectId);
    }
  };

  private onAuthButtonClick = (): void => {
    if (!this.isAuthenticated) {
      this.openAuthModal();
      return;
    }

    this.isAccountPopoverOpen = !this.isAccountPopoverOpen;
  };

  private onLogoutClick = async (): Promise<void> => {
    this.isAccountPopoverOpen = false;
    await this.projectLifecycleService.logout();
  };

  private renderWorkspaceOverlay() {
    if (appState.project.status === 'opening') {
      const progress = appState.project.openProgress;
      const progressValue =
        progress.totalBytes && progress.totalBytes > 0
          ? Math.min(100, Math.round(((progress.processedBytes ?? 0) / progress.totalBytes) * 100))
          : progress.totalFileCount > 0
            ? Math.min(
                100,
                Math.round((progress.processedFileCount / progress.totalFileCount) * 100)
              )
            : null;
      const metaLabel =
        progress.totalFileCount > 0
          ? `${progress.processedFileCount}/${progress.totalFileCount} file(s)`
          : 'Preparing project files';

      return html`
        <div class="collab-join-overlay">
          <div class="collab-join-card">
            <div class="collab-join-eyebrow">Pix3 Workspace</div>
            <h2 class="collab-join-title">Opening Cloud Project</h2>
            <p class="collab-join-copy">
              ${progress.message ?? 'Preparing project files for local access.'}
            </p>
            ${progressValue !== null
              ? html`
                  <div
                    class="loading-progress"
                    role="progressbar"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow=${String(progressValue)}
                  >
                    <div class="loading-progress__bar">
                      <div class="loading-progress__fill" style=${`width: ${progressValue}%`}></div>
                    </div>
                    <div class="loading-progress__meta">
                      <span>${metaLabel}</span>
                      <span>${progressValue}%</span>
                    </div>
                  </div>
                `
              : html`<div class="loading-label">Please wait...</div>`}
            ${progress.currentPath
              ? html`<div class="loading-progress__path">${progress.currentPath}</div>`
              : html``}
          </div>
        </div>
      `;
    }

    if (this.routerStatus !== 'idle') {
      let title = 'Connecting to Workspace';
      let message = 'Pix3 is loading your project setup...';

      if (this.routerStatus === 'reactivationRequired') {
        return html`
          <div class="collab-join-overlay">
            <div class="collab-join-card">
              <div class="collab-join-eyebrow">Local Project Backup</div>
              <h2 class="collab-join-title">Reactivate Project Access</h2>
              <p class="collab-join-copy">
                The browser requires permission to resume reading this local project folder.
              </p>
              <button
                class="primary-button"
                @click=${() => this.routerService.reactivateLocalSession()}
              >
                Restore Access
              </button>
            </div>
          </div>
        `;
      }

      if (this.routerStatus === 'loadingAssets') {
        title = 'Loading project data';
        message = 'Assets and scene hierarchies are being synchronized.';
      } else if (this.routerStatus === 'fetchingMetadata') {
        title = 'Negotiating connection';
        message = 'Establishing handshake and verifying access.';
      } else if (this.routerStatus === 'error') {
        title = 'Connection Failed';
        message = appState.router.errorMessage ?? 'An unknown error occurred.';
      }

      return html`
        <div class="collab-join-overlay">
          <div class="collab-join-card">
            <div class="collab-join-eyebrow">Pix3 Workspace</div>
            <h2 class="collab-join-title">${title}</h2>
            <p class="collab-join-copy">${message}</p>
            ${this.routerStatus !== 'error'
              ? html`<div class="loading-label">Please wait...</div>`
              : html`<div class="error-label">${message}</div>`}
          </div>
        </div>
      `;
    }

    if (this.currentHash === '#welcome' || appState.project.status !== 'ready') {
      return html` <pix3-welcome @pix3-auth:request=${this.onAuthRequest}></pix3-welcome> `;
    }

    // Default to editor mode, we no longer render welcome fallback here
    return html``;
  }

  private renderAuthModal() {
    if (!this.isAuthModalOpen) {
      return html``;
    }

    return html`
      <div class="auth-modal-backdrop" @click=${this.closeAuthModal}>
        <div class="auth-modal-shell" @click=${(event: Event) => event.stopPropagation()}>
          <pix3-auth-screen
            variant="modal"
            show-close
            @pix3-auth:close=${this.closeAuthModal}
            @pix3-auth:success=${async () => {
              await this.onAuthSuccess();
              if (appState.router.targetParams) {
                await this.routerService.resumeTargetSession();
              }
            }}
          ></pix3-auth-screen>
        </div>
      </div>
    `;
  }

  private renderAccountPopover() {
    if (!this.isAuthenticated || !this.isAccountPopoverOpen) {
      return html``;
    }

    return html`
      <div class="account-popover">
        <div class="account-popover__name">${appState.auth.user?.username ?? 'User'}</div>
        <div class="account-popover__email">${appState.auth.user?.email ?? ''}</div>
        <button class="account-popover__action" @click=${() => void this.onLogoutClick()}>
          Logout
        </button>
      </div>
    `;
  }

  private getUserInitials(): string {
    const username = appState.auth.user?.username?.trim() || 'U';
    const parts = username.split(/\s+/).filter(Boolean).slice(0, 2);
    return parts.map(part => part.charAt(0).toUpperCase()).join('') || 'U';
  }

  private togglePlayMode() {
    const commandId = appState.ui.isPlaying ? 'game.stop' : 'game.start';
    void this.commandDispatcher.executeById(commandId);
  }

  private renderPickerHost() {
    return html`
      <div
        class="picker-host"
        @component-selected=${(e: CustomEvent) => this.onComponentSelected(e)}
        @component-picker-cancelled=${(e: CustomEvent) => this.onComponentPickerCancelled(e)}
        @component-picker-create-new=${(e: CustomEvent) => this.onComponentPickerCreateNew(e)}
      >
        ${this.componentPickers.map(
          picker => html` <pix3-behavior-picker .pickerId=${picker.id}></pix3-behavior-picker> `
        )}
      </div>
    `;
  }

  private onComponentSelected(e: CustomEvent): void {
    const { pickerId, component } = e.detail;
    this.behaviorPickerService.select(pickerId, component);
  }

  private onComponentPickerCancelled(e: CustomEvent): void {
    const { pickerId } = e.detail;
    this.behaviorPickerService.cancel(pickerId);
  }

  private onComponentPickerCreateNew(e: CustomEvent): void {
    const { pickerId } = e.detail;
    // First cancel the picker
    this.behaviorPickerService.cancel(pickerId);
    // Then show the script creator - we'll handle the result in the inspector
    // This event will bubble up to the inspector which initiated the picker
    this.dispatchEvent(
      new CustomEvent('script-creator-requested', {
        detail: { pickerId },
        bubbles: true,
        composed: true,
      })
    );
  }

  private renderScriptCreatorHost() {
    return html`
      <div
        class="script-creator-host"
        @script-create-confirmed=${(e: CustomEvent) => this.onScriptCreateConfirmed(e)}
        @script-create-cancelled=${(e: CustomEvent) => this.onScriptCreateCancelled(e)}
      >
        ${this.scriptCreators.map(
          creator => html`
            <pix3-script-creator
              .dialogId=${creator.id}
              .defaultName=${creator.params.defaultName || creator.params.scriptName}
            ></pix3-script-creator>
          `
        )}
      </div>
    `;
  }

  private onScriptCreateConfirmed(e: CustomEvent): void {
    const { dialogId, scriptName } = e.detail;
    void this.scriptCreatorService.confirm(dialogId, scriptName);
  }

  private onScriptCreateCancelled(e: CustomEvent): void {
    const { dialogId } = e.detail;
    this.scriptCreatorService.cancel(dialogId);
  }

  private renderDialogHost() {
    return html`
      <div
        class="dialog-host"
        @dialog-confirmed=${(e: CustomEvent) => this.onDialogConfirmed(e)}
        @dialog-cancelled=${(e: CustomEvent) => this.onDialogCancelled(e)}
        @dialog-secondary=${(e: CustomEvent) => this.onDialogSecondary(e)}
      >
        ${this.dialogs.map(
          dialog => html`
            <pix3-confirm-dialog
              .dialogId=${dialog.id}
              .title=${dialog.options.title}
              .message=${dialog.options.message}
              .confirmLabel=${dialog.options.confirmLabel || 'Confirm'}
              .secondaryLabel=${dialog.options.secondaryLabel || ''}
              .cancelLabel=${dialog.options.cancelLabel || 'Cancel'}
              .isDangerous=${dialog.options.isDangerous || false}
              .secondaryIsDangerous=${dialog.options.secondaryIsDangerous || false}
              .requiredInputLabel=${dialog.options.requiredInputLabel || ''}
              .requiredInputValue=${dialog.options.requiredInputValue || ''}
              .requiredInputPlaceholder=${dialog.options.requiredInputPlaceholder || ''}
              .disclaimer=${dialog.options.disclaimer || ''}
            ></pix3-confirm-dialog>
          `
        )}
      </div>
    `;
  }

  private renderProjectSettingsHost() {
    if (!this.activeProjectSettingsDialog) {
      return null;
    }

    return html`
      <div class="project-settings-host">
        <pix3-project-settings-dialog></pix3-project-settings-dialog>
      </div>
    `;
  }

  private renderProjectSyncHost() {
    if (!this.activeProjectSyncDialog) {
      return null;
    }

    return html`
      <div class="project-sync-host" @pix3-auth:request=${this.onAuthRequest}>
        <pix3-project-sync-dialog></pix3-project-sync-dialog>
      </div>
    `;
  }

  private renderEditorSettingsHost() {
    if (!this.activeEditorSettingsDialog) {
      return null;
    }

    return html`
      <div class="editor-settings-host">
        <pix3-editor-settings-dialog></pix3-editor-settings-dialog>
      </div>
    `;
  }

  private renderAnimationAutoSliceHost() {
    if (!this.activeAnimationAutoSliceDialog) {
      return null;
    }

    return html`
      <div
        class="animation-auto-slice-host"
        @animation-auto-slice-confirmed=${(event: CustomEvent) =>
          this.onAnimationAutoSliceConfirmed(event)}
        @animation-auto-slice-cancelled=${(event: CustomEvent) =>
          this.onAnimationAutoSliceCancelled(event)}
      >
        <pix3-animation-auto-slice-dialog
          .dialogId=${this.activeAnimationAutoSliceDialog.id}
          .texturePath=${this.activeAnimationAutoSliceDialog.params.texturePath}
          .clipName=${this.activeAnimationAutoSliceDialog.params.clipName}
          .defaultColumns=${this.activeAnimationAutoSliceDialog.params.defaultColumns || 1}
          .defaultRows=${this.activeAnimationAutoSliceDialog.params.defaultRows || 1}
        ></pix3-animation-auto-slice-dialog>
      </div>
    `;
  }

  private onAnimationAutoSliceConfirmed(event: CustomEvent): void {
    const { dialogId, columns, rows } = event.detail as {
      dialogId?: string;
      columns?: number;
      rows?: number;
    };

    if (
      typeof dialogId !== 'string' ||
      !Number.isFinite(columns) ||
      !Number.isFinite(rows) ||
      columns <= 0 ||
      rows <= 0
    ) {
      return;
    }

    this.animationAutoSliceDialogService.confirm(dialogId, {
      columns: Math.max(1, Math.round(columns)),
      rows: Math.max(1, Math.round(rows)),
    });
  }

  private onAnimationAutoSliceCancelled(event: CustomEvent): void {
    const { dialogId } = event.detail as { dialogId?: string };
    if (typeof dialogId !== 'string') {
      return;
    }

    this.animationAutoSliceDialogService.cancel(dialogId);
  }

  private renderCreateProjectHost() {
    if (!this.activeCreateProjectDialog) {
      return null;
    }

    return html`
      <pix3-create-project-dialog
        .dialogId=${this.activeCreateProjectDialog.id}
        .initialBackend=${this.activeCreateProjectDialog.initialBackend}
        @pix3-auth:request=${this.onAuthRequest}
      ></pix3-create-project-dialog>
    `;
  }

  private renderNodeTypePickerHost() {
    if (!this.activeNodeTypePicker) {
      return null;
    }

    return html`
      <div
        class="node-type-picker-host"
        @node-type-selected=${(e: CustomEvent) => this.onNodeTypeSelected(e)}
        @node-type-picker-cancelled=${(e: CustomEvent) => this.onNodeTypePickerCancelled(e)}
      >
        <pix3-node-type-picker .pickerId=${this.activeNodeTypePicker.id}></pix3-node-type-picker>
      </div>
    `;
  }

  private onNodeTypeSelected(e: CustomEvent): void {
    const { pickerId, nodeTypeId } = e.detail as {
      pickerId?: string;
      nodeTypeId?: string;
    };

    if (typeof pickerId !== 'string' || typeof nodeTypeId !== 'string') {
      return;
    }

    this.nodeTypePickerService.select(pickerId, nodeTypeId);
  }

  private onNodeTypePickerCancelled(e: CustomEvent): void {
    const { pickerId } = e.detail as { pickerId?: string };
    if (typeof pickerId !== 'string') {
      return;
    }

    this.nodeTypePickerService.cancel(pickerId);
  }

  /**
   * Waits for project scripts to reach 'ready' or 'error' state.
   */
  private async waitForScripts(): Promise<void> {
    if (appState.project.scriptsStatus === 'ready' || appState.project.scriptsStatus === 'error') {
      return;
    }

    return new Promise(resolve => {
      const unsub = subscribe(appState.project, () => {
        if (
          appState.project.scriptsStatus === 'ready' ||
          appState.project.scriptsStatus === 'error'
        ) {
          unsub();
          resolve();
        }
      });
    });
  }

  private onDialogSecondary(e: CustomEvent): void {
    const { dialogId } = e.detail;
    this.dialogService.secondary(dialogId);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-editor': Pix3EditorShell;
  }
}
