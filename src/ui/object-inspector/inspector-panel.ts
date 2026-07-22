import { ComponentBase, customElement, html, state, subscribe, inject } from '@/fw';
import {
  getNodePropertySchema,
  getRuntimeSceneRoot,
  AnimatedSprite2D,
  NodeBase,
  Sprite2D,
} from '@pix3/runtime';
import { SceneManager } from '@pix3/runtime';
import { appState } from '@/state';
import type { PropertySchema, PropertyDefinition } from '@/fw';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import { UpdateSprite2DSizeCommand } from '@/features/properties/UpdateSprite2DSizeCommand';
import { CreateAndBindAnimationAssetCommand } from '@/features/scene/CreateAndBindAnimationAssetCommand';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { BehaviorPickerService } from '@/services/editor/BehaviorPickerService';
import { EffectPickerService } from '@/services/editor/EffectPickerService';
import { ScriptCreatorService } from '@/services/scripting/ScriptCreatorService';
import { ScriptRegistry } from '@pix3/runtime';
import { IconService } from '@/services/editor/IconService';
import { DialogService } from '@/services/editor/DialogService';
import { FileSystemAPIService } from '@/services/project/FileSystemAPIService';
import { AnimationEditorService } from '@/services/animation/AnimationEditorService';
import {
  AssetsPreviewService,
  type AssetPreviewItem,
} from '@/services/assets/AssetsPreviewService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  LibrarySelectionService,
  type LibrarySelection,
} from '@/services/library/LibrarySelectionService';
import type {
  AnimationInspectorController,
  AnimationInspectorSnapshot,
} from '@/services/animation/AnimationEditorService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { AddComponentCommand } from '@/features/scripts/AddComponentCommand';
import { UpdateComponentPropertyCommand } from '@/features/scripts/UpdateComponentPropertyCommand';
import { normalizeAnimationAssetPath } from '@/features/scene/animation-asset-utils';
import { InspectorResourcePreview } from './inspector-resource-preview';
import { InspectorSectionRenderers } from './inspector-section-renderers';
import {
  InspectorPropertyRenderers,
  getComponentPropertyKey,
  getPropertyDisplayValue,
} from './inspector-property-renderers';

import '../shared/pix3-panel';
import '../asset-library/library-inspector';
import './inspector-panel.ts.css';
import './model-asset-preview';
import './property-editors';

/**
 * Poll cadence for the play-mode live read-out (~12.5 Hz). Fast enough to feel
 * "live" without re-rendering the inspector on every animation frame.
 */
const LIVE_REFRESH_INTERVAL_MS = 80;

interface PropertyUIState {
  value: string;
  isValid: boolean;
}

const DEFAULT_ANIMATION_ASSET_DIRECTORY = 'res://animations';

@customElement('pix3-inspector-panel')
export class InspectorPanel extends ComponentBase {
  @inject(SceneManager)
  readonly sceneManager!: SceneManager;

  @inject(CommandDispatcher)
  readonly commandDispatcher!: CommandDispatcher;

  @inject(BehaviorPickerService)
  readonly behaviorPickerService!: BehaviorPickerService;

  @inject(EffectPickerService)
  readonly effectPickerService!: EffectPickerService;

  @inject(ScriptCreatorService)
  private readonly scriptCreatorService!: ScriptCreatorService;

  @inject(ScriptRegistry)
  readonly scriptRegistry!: ScriptRegistry;

  @inject(IconService)
  readonly iconService!: IconService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(FileSystemAPIService)
  readonly fileSystemAPI!: FileSystemAPIService;

  @inject(ProjectStorageService)
  readonly projectStorage!: ProjectStorageService;

  @inject(EditorTabService)
  readonly editorTabService!: EditorTabService;

  @inject(AssetsPreviewService)
  private readonly assetsPreviewService!: AssetsPreviewService;

  @inject(AnimationEditorService)
  readonly animationEditorService!: AnimationEditorService;

  @inject(ViewportRendererService)
  readonly viewportService!: ViewportRendererService;

  @inject(LocalizationEditorService)
  readonly localizationEditorService!: LocalizationEditorService;

  @inject(LibrarySelectionService)
  private readonly librarySelectionService!: LibrarySelectionService;

  /**
   * Selected library item. When set, the inspector shows library-item details instead of node
   * properties (the Library panel writes it; selecting a scene node clears it — last-pick wins).
   */
  @state()
  private librarySelection: LibrarySelection | null = null;

  @state()
  selectedNodes: NodeBase[] = [];

  @state()
  primaryNode: NodeBase | null = null;

  /**
   * True while play mode is active AND the selected node resolves to its live
   * runtime-clone counterpart. Drives the "LIVE" badge variant and live value
   * mirroring; the read-only gate itself keys off play mode (`isPlaying`).
   */
  @state()
  isLivePlayMode = false;

  /**
   * Whether play mode is active. Reactive so the inspector can render its
   * read-only play-mode badge/tint, and used to detect transitions on the
   * (noisy) appState.ui subscription. Two-way editing during play is out of scope.
   */
  @state()
  isPlaying = appState.ui.isPlaying;

  /** Interval that re-reads live values off the runtime clone while playing. */
  private liveRefreshTimer: number | null = null;

  @state()
  propertySchema: PropertySchema | null = null;

  @state()
  propertyValues: Record<string, PropertyUIState> = {};

  @state()
  componentPropertyValues: Record<string, PropertyUIState> = {};

  @state()
  selectedAssetItem: AssetPreviewItem | null = null;

  @state()
  creatingAnimationPropertyName: string | null = null;

  @state()
  activePreviewAnimation: string | null = null;

  @state()
  newGroupName: string = '';

  @state()
  newGroupError: string | null = null;

  @state()
  isGroupsEditorOpen = false;

  @state()
  activeAnimationState: AnimationInspectorSnapshot | null = null;

  private disposeSelectionSubscription?: () => void;
  private disposeSceneSubscription?: () => void;
  private disposeUiSubscription?: () => void;
  private disposeLocalizationSubscription?: () => void;
  private disposeLibrarySelectionSubscription?: () => void;
  private disposeAssetPreviewSubscription?: () => void;
  private disposeAnimationEditorSubscription?: () => void;
  disposeAnimationControllerSubscription?: () => void;
  private scriptCreatorRequestedHandler?: (e: Event) => void;
  activeAnimationController: AnimationInspectorController | null = null;

  readonly resourcePreview = new InspectorResourcePreview(this);
  readonly sectionRenderers = new InspectorSectionRenderers(this);
  readonly propertyRenderers = new InspectorPropertyRenderers(this);
  private readonly propertyPreviewStartValues = new Map<string, unknown>();
  private readonly componentPropertyPreviewStartValues = new Map<string, unknown>();

  private readonly onDocumentPointerDown = (event: PointerEvent) => {
    if (!this.isGroupsEditorOpen) {
      return;
    }

    if (!event.composedPath().includes(this)) {
      this.isGroupsEditorOpen = false;
    }
  };

  connectedCallback() {
    super.connectedCallback();
    // Anchor the transition detector to the play state at mount time — the panel
    // may be lazily mounted (Golden Layout) while a game is already running.
    this.isPlaying = appState.ui.isPlaying;
    this.disposeSelectionSubscription = subscribe(appState.selection, () => {
      // Selecting a scene node takes the inspector back to node properties (last pick wins).
      if (appState.selection.nodeIds.length > 0) {
        this.librarySelectionService.clear();
      }
      this.updateSelectedNodes();
    });
    this.disposeSceneSubscription = subscribe(appState.scenes, () => {
      this.updateSelectedNodes();
    });
    this.disposeUiSubscription = subscribe(appState.ui, () => {
      if (this.isPlaying !== appState.ui.isPlaying) {
        this.isPlaying = appState.ui.isPlaying;
        this.onPlayModeChanged();
      }
    });
    // Re-render the localization-key editor's status/preview when the preview
    // locale switches or a locale table is edited.
    this.disposeLocalizationSubscription = subscribe(appState.localization, () => {
      this.requestUpdate();
    });
    this.librarySelection = this.librarySelectionService.getSelection();
    this.disposeLibrarySelectionSubscription = this.librarySelectionService.subscribe(() => {
      this.librarySelection = this.librarySelectionService.getSelection();
    });
    this.disposeAssetPreviewSubscription = this.assetsPreviewService.subscribe(snapshot => {
      this.selectedAssetItem = snapshot.selectedItem;
      if (snapshot.selectedItem?.previewType === 'model') {
        this.assetsPreviewService.requestThumbnail(snapshot.selectedItem.path);
      }
      this.requestUpdate();
    });
    this.disposeAnimationEditorSubscription = this.animationEditorService.subscribe(() => {
      this.sectionRenderers.syncActiveAnimationContext();
    });
    this.updateSelectedNodes();
    this.sectionRenderers.syncActiveAnimationContext();
    if (appState.ui.isPlaying) {
      this.startLiveTimer();
    }

    // Track focus for context-aware shortcuts
    this.addEventListener('focusin', () => {
      appState.editorContext.focusedArea = 'inspector';
    });

    // Resource editors (texture/audio/model/animation) emit `locate-resource`
    // when the user clicks "Locate"; reveal the file in the Asset Browser and
    // Assets Preview.
    this.addEventListener('locate-resource', this.onLocateResource as EventListener);

    // Listen for script creator requested event from editor shell
    this.scriptCreatorRequestedHandler = (_e: Event) => {
      void this.handleScriptCreatorRequested();
    };
    window.addEventListener(
      'script-creator-requested',
      this.scriptCreatorRequestedHandler as EventListener
    );
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
  }

  /**
   * Reveal the resource behind a `locate-resource` event in the Asset Browser
   * (expand + select the file, which also drives the Assets Preview). Works from
   * any resource editor (texture / audio / model / animation).
   */
  private readonly onLocateResource = (event: Event): void => {
    const detail = (event as CustomEvent<{ url?: string }>).detail;
    const url = detail?.url?.trim();
    if (!url) {
      return;
    }
    // res:// resource URL → project-relative path (matches Asset Browser paths).
    const path = this.fileSystemAPI.normalizeResourcePath(url);
    // syncFromAssetSelection updates the Assets Preview even when the Asset
    // Browser panel is not mounted; the reveal-path event drives the Asset
    // Browser tree (expand + select) when it is — the same channel the Assets
    // Preview uses to reveal a folder in the tree.
    void this.assetsPreviewService.syncFromAssetSelection(path, 'file');
    window.dispatchEvent(new CustomEvent('assets-preview:reveal-path', { detail: { path } }));
  };

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disposeSelectionSubscription?.();
    this.disposeSelectionSubscription = undefined;
    this.disposeSceneSubscription?.();
    this.disposeSceneSubscription = undefined;
    this.disposeUiSubscription?.();
    this.disposeUiSubscription = undefined;
    this.disposeLocalizationSubscription?.();
    this.disposeLocalizationSubscription = undefined;
    this.disposeLibrarySelectionSubscription?.();
    this.disposeLibrarySelectionSubscription = undefined;
    this.stopLiveTimer();
    // Reset live-mirror UI state so a reused Lit instance starts clean even if it
    // was detached mid-play and play stopped while it was disconnected.
    this.isLivePlayMode = false;
    this.disposeAssetPreviewSubscription?.();
    this.disposeAssetPreviewSubscription = undefined;
    this.disposeAnimationEditorSubscription?.();
    this.disposeAnimationEditorSubscription = undefined;
    this.disposeAnimationControllerSubscription?.();
    this.disposeAnimationControllerSubscription = undefined;
    if (this.scriptCreatorRequestedHandler) {
      window.removeEventListener(
        'script-creator-requested',
        this.scriptCreatorRequestedHandler as EventListener
      );
      this.scriptCreatorRequestedHandler = undefined;
    }
    this.removeEventListener('locate-resource', this.onLocateResource as EventListener);
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);

    this.resourcePreview.dispose();
  }

  private toUrlSafeClassName(name: string): string {
    let cleaned = name;

    // Remove invalid characters (keep only alphanumeric and spaces)
    cleaned = cleaned.replace(/[^a-zA-Z0-9_\s]/g, '');

    // Convert to PascalCase:
    // 1. Split by spaces and underscores
    // 2. Capitalize first letter of each word
    // 3. Join together
    const words = cleaned.split(/[\s_]+/).filter(w => w.length > 0);
    const pascalCase = words
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');

    // If result is empty, use default
    return pascalCase || 'New';
  }

  private async checkIfScriptFileExists(fileName: string): Promise<boolean> {
    try {
      const entries = await this.fileSystemAPI.listDirectory('scripts');
      return entries.some(e => e.kind === 'file' && e.name === fileName);
    } catch {
      // Directory might not exist yet
      console.log('[InspectorPanel] scripts directory does not exist yet');
      return false;
    }
  }

  private async handleScriptCreatorRequested(): Promise<void> {
    if (!this.primaryNode) return;

    const defaultName = this.primaryNode.name || 'NewScript';
    const urlSafeBaseName = this.toUrlSafeClassName(defaultName);
    const fullClassName = `${urlSafeBaseName}`;
    const fileName = `${fullClassName}.ts`;

    // Check if file already exists
    const fileExists = await this.checkIfScriptFileExists(fileName);
    if (fileExists) {
      await this.dialogService.showConfirmation({
        title: 'Script Already Exists',
        message: `A script file named "${fileName}" already exists in the scripts/ folder. Please choose a different name.`,
        confirmLabel: 'OK',
        cancelLabel: 'Cancel',
        isDangerous: false,
      });
      return;
    }

    const scriptName = await this.scriptCreatorService.showCreator({
      scriptName: urlSafeBaseName,
    });

    if (scriptName) {
      // Wait a bit for compilation to complete
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Find the newly created script in the registry
      const scriptId = `user:${scriptName}`;

      const componentType = this.scriptRegistry.getComponentType(scriptId);
      if (componentType) {
        const componentId = `${componentType.id}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const command = new AddComponentCommand({
          nodeId: this.primaryNode.nodeId,
          componentType: componentType.id,
          componentId,
        });
        void this.commandDispatcher.execute(command);
      }
    }
  }

  async handleCopyResourceUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch (err) {
      console.error('Failed to copy resource URL:', err);
    }
  }

  private updateSelectedNodes(): void {
    const previousPrimaryNodeId = this.primaryNode?.nodeId ?? null;
    const { nodeIds, primaryNodeId } = appState.selection;
    const activeSceneId = appState.scenes.activeSceneId;

    if (nodeIds.length > 0 && this.selectedAssetItem) {
      this.assetsPreviewService.clearSelectedItem();
    }

    if (!activeSceneId) {
      this.selectedNodes = [];
      this.primaryNode = null;
      this.propertySchema = null;
      return;
    }

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      this.selectedNodes = [];
      this.primaryNode = null;
      this.propertySchema = null;
      return;
    }

    // Find selected nodes
    this.selectedNodes = nodeIds
      .map(nodeId => this.findNodeById(nodeId, sceneGraph.rootNodes))
      .filter((node): node is NodeBase => node !== null);

    // Find primary node
    this.primaryNode = primaryNodeId
      ? this.findNodeById(primaryNodeId, sceneGraph.rootNodes)
      : this.selectedNodes.length > 0
        ? this.selectedNodes[0]
        : null;

    const nextPrimaryNodeId = this.primaryNode?.nodeId ?? null;
    if (previousPrimaryNodeId !== nextPrimaryNodeId) {
      this.propertyPreviewStartValues.clear();
      this.componentPropertyPreviewStartValues.clear();
      this.isGroupsEditorOpen = false;
    }

    // Reset animation preview when selection changes
    const newPrimaryId = primaryNodeId ?? nodeIds[0] ?? null;
    if (previousPrimaryNodeId !== newPrimaryId && this.activePreviewAnimation !== null) {
      if (previousPrimaryNodeId) {
        this.viewportService.setPreviewAnimation(previousPrimaryNodeId, null);
      }
      this.activePreviewAnimation = null;
    }

    this.syncValuesFromNode();

    // While playing, immediately mirror the freshly selected node's live runtime
    // values so the panel doesn't flash authored values until the next poll tick.
    if (appState.ui.isPlaying) {
      this.refreshLiveValues();
    }
  }

  private findNodeById(nodeId: string, nodes: NodeBase[]): NodeBase | null {
    for (const node of nodes) {
      if (node.nodeId === nodeId) {
        return node;
      }
      const found = this.findNodeById(nodeId, node.children);
      if (found) {
        return found;
      }
    }
    return null;
  }

  /**
   * Refresh the cached property/component display values.
   *
   * `valueSource` lets the play-mode live read-out feed values from the running
   * runtime clone while the schema (and everything else) stays bound to the
   * authored `primaryNode`. The clone is the same concrete class, so its schema
   * is identical; only the live `getValue(target)` results differ. When omitted,
   * values come from the authored node (normal edit-mode behaviour).
   */
  syncValuesFromNode(valueSource?: NodeBase): void {
    if (!this.primaryNode) {
      this.propertySchema = null;
      this.propertyValues = {};
      this.componentPropertyValues = {};
      this.propertyPreviewStartValues.clear();
      this.componentPropertyPreviewStartValues.clear();
      this.isGroupsEditorOpen = false;
      return;
    }

    // Get the schema for this node
    this.propertySchema = getNodePropertySchema(this.primaryNode);
    this.newGroupError = null;

    const source = valueSource ?? this.primaryNode;

    // Initialize UI values from node properties
    const values: Record<string, PropertyUIState> = {};
    for (const prop of this.propertySchema.properties) {
      if (prop.ui?.hidden) {
        continue;
      }
      const displayValue = getPropertyDisplayValue(source, prop);
      values[prop.name] = {
        value: displayValue,
        isValid: true,
      };
    }
    this.propertyValues = values;
    this.syncComponentValuesFromNode(valueSource);
  }

  private syncComponentValuesFromNode(valueSource?: NodeBase): void {
    if (!this.primaryNode) {
      this.componentPropertyValues = {};
      return;
    }

    // Render keys off the authored components (what the template iterates), but
    // read live values from the matching runtime-clone component (same index +
    // type) when a live value source is provided.
    const liveComponents = valueSource?.components;
    const values: Record<string, PropertyUIState> = {};
    this.primaryNode.components.forEach((component, index) => {
      const schema = this.scriptRegistry.getComponentPropertySchema(component.type);
      if (!schema) {
        return;
      }
      const liveComponent = liveComponents?.[index];
      const valueComponent =
        liveComponent && liveComponent.type === component.type ? liveComponent : component;
      for (const prop of schema.properties) {
        if (prop.ui?.hidden) {
          continue;
        }
        const key = getComponentPropertyKey(component.id, prop.name);
        values[key] = {
          value: getPropertyDisplayValue(valueComponent, prop),
          isValid: true,
        };
      }
    });
    this.componentPropertyValues = values;
  }

  /**
   * Resolve the runtime-clone counterpart of the currently-selected node.
   *
   * Play mode runs an isolated clone in SceneRunner's own THREE.Scene; the
   * scene root's direct children are the runtime NodeBase roots. The clone
   * preserves authored nodeIds, so we match by id. Returns null when not
   * playing, when the runtime scene is gone, or when the node has no 1:1 clone
   * (e.g. nodes nested inside a prefab instance whose ids were remapped).
   */
  private resolveLiveNode(): NodeBase | null {
    const id = this.primaryNode?.nodeId;
    if (!id) {
      return null;
    }
    const root = getRuntimeSceneRoot() as { children?: unknown[] } | null;
    if (!root || !Array.isArray(root.children)) {
      return null;
    }
    for (const child of root.children) {
      if (child instanceof NodeBase) {
        const hit = child.findById(id);
        if (hit) {
          return hit;
        }
      }
    }
    return null;
  }

  /** Re-read live values off the runtime clone and reflect them in the inspector. */
  private refreshLiveValues(): void {
    if (!appState.ui.isPlaying) {
      this.setLivePlayMode(false);
      return;
    }
    const live = this.resolveLiveNode();
    this.setLivePlayMode(live !== null);
    if (live) {
      this.syncValuesFromNode(live);
    }
  }

  /** Toggle the live-mirror UI state, restoring authored values when leaving live mode. */
  private setLivePlayMode(active: boolean): void {
    if (this.isLivePlayMode === active) {
      return;
    }
    this.isLivePlayMode = active;
    if (!active) {
      // Restore the authored node's values now that the live mirror is gone.
      this.syncValuesFromNode();
    }
  }

  private startLiveTimer(): void {
    if (this.liveRefreshTimer !== null) {
      return;
    }
    this.liveRefreshTimer = window.setInterval(
      () => this.refreshLiveValues(),
      LIVE_REFRESH_INTERVAL_MS
    );
    this.refreshLiveValues();
  }

  private stopLiveTimer(): void {
    if (this.liveRefreshTimer !== null) {
      window.clearInterval(this.liveRefreshTimer);
      this.liveRefreshTimer = null;
    }
  }

  private onPlayModeChanged(): void {
    if (appState.ui.isPlaying) {
      this.startLiveTimer();
    } else {
      this.stopLiveTimer();
      this.setLivePlayMode(false);
    }
  }

  onTextureResourceDrop(propertyName: string, event: DragEvent): void {
    const textureUrl = this.resourcePreview.getDroppedTextureResource(event);
    if (!textureUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, { type: 'texture', url: textureUrl });
  }

  onAudioResourceDrop(propertyName: string, event: DragEvent): void {
    const audioUrl = this.resourcePreview.getDroppedAudioResource(event);
    if (!audioUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, audioUrl);
  }

  onModelResourceDrop(propertyName: string, event: DragEvent): void {
    const modelUrl = this.resourcePreview.getDroppedModelResource(event);
    if (!modelUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, modelUrl);
  }

  onAnimationResourceDrop(propertyName: string, event: DragEvent): void {
    const animationUrl = this.resourcePreview.getDroppedAnimationResource(event);
    if (!animationUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, animationUrl);
  }

  onOpenAnimationResource(resourcePath: string): void {
    const trimmedResourcePath = resourcePath.trim();
    if (!trimmedResourcePath) {
      return;
    }

    void this.editorTabService.focusOrOpenAnimation(trimmedResourcePath);
  }

  canCreateAnimationResource(propertyName: string, value: string, readOnly: boolean): boolean {
    return (
      !readOnly &&
      propertyName === 'animationResourcePath' &&
      this.primaryNode instanceof AnimatedSprite2D &&
      value.trim().length === 0
    );
  }

  async onCreateAnimationResource(propertyName: string): Promise<void> {
    if (
      this.creatingAnimationPropertyName ||
      propertyName !== 'animationResourcePath' ||
      !(this.primaryNode instanceof AnimatedSprite2D)
    ) {
      return;
    }

    const nodeId = this.primaryNode.nodeId;
    this.creatingAnimationPropertyName = propertyName;

    try {
      const assetPath = await this.getAvailableAnimationAssetPath(this.primaryNode.name);

      const didMutate = await this.commandDispatcher.execute(
        new CreateAndBindAnimationAssetCommand({
          nodeId,
          assetPath,
          propertyPath: propertyName,
          texturePath: '',
          initialClipName: 'idle',
        })
      );

      if (!didMutate) {
        return;
      }

      await this.editorTabService.openResourceTab('animation', assetPath);
    } catch (error) {
      console.error('[InspectorPanel] Failed to create animation resource', error);
    } finally {
      this.creatingAnimationPropertyName = null;
    }
  }

  private async getAvailableAnimationAssetPath(nodeName: string): Promise<string> {
    const baseStem = this.getAnimationAssetStem(nodeName);
    let suffix = 0;

    while (true) {
      const assetPath = normalizeAnimationAssetPath(
        suffix === 0
          ? `${DEFAULT_ANIMATION_ASSET_DIRECTORY}/${baseStem}`
          : `${DEFAULT_ANIMATION_ASSET_DIRECTORY}/${baseStem}-${suffix + 1}`
      );

      if (!(await this.animationAssetExists(assetPath))) {
        return assetPath;
      }

      suffix += 1;
    }
  }

  private getAnimationAssetStem(nodeName: string): string {
    const sanitized = nodeName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return sanitized || 'animated-sprite';
  }

  private async animationAssetExists(assetPath: string): Promise<boolean> {
    try {
      await this.projectStorage.readTextFile(assetPath);
      return true;
    } catch {
      return false;
    }
  }

  onComponentAudioResourceDrop(
    componentId: string,
    prop: PropertyDefinition,
    event: DragEvent
  ): void {
    const audioUrl = this.resourcePreview.getDroppedAudioResource(event);
    if (!audioUrl) {
      return;
    }

    void this.applyComponentPropertyChange(componentId, prop, audioUrl);
  }

  onComponentModelResourceDrop(
    componentId: string,
    prop: PropertyDefinition,
    event: DragEvent
  ): void {
    const modelUrl = this.resourcePreview.getDroppedModelResource(event);
    if (!modelUrl) {
      return;
    }

    void this.applyComponentPropertyChange(componentId, prop, modelUrl);
  }

  async handlePropertyInput(propName: string, e: Event) {
    const input = e.target as HTMLInputElement;
    const rawValue = input.value;

    const propDef = this.propertySchema?.properties.find(p => p.name === propName);
    const expectsNumber = propDef?.type === 'number' || input.type === 'number';

    const numericValue = parseFloat(rawValue);
    const parsedValue: unknown = expectsNumber ? numericValue : rawValue;
    const isValid = expectsNumber ? !isNaN(numericValue) : true;

    // Update local state
    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value: rawValue, isValid },
    };

    if (isValid) {
      await this.previewPropertyChange(propName, parsedValue);
    }
  }

  async handlePropertyBlur(propName: string, e: Event) {
    const input = e.target as HTMLInputElement;
    let value = input.value;

    // For number inputs, format the value
    if (input.type === 'number') {
      let num = parseFloat(value);
      if (isNaN(num)) num = 0;
      value = parseFloat(num.toFixed(4)).toString();
    }

    // Update local state
    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value, isValid: true },
    };

    await this.commitPropertyChange(propName, value);
  }

  private normalizeColorValue(value: string): string | null {
    const normalized = value.trim().toLowerCase();
    const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!hexMatch) {
      return null;
    }

    const hex = hexMatch[1];
    if (hex.length === 3) {
      return `#${hex
        .split('')
        .map(char => `${char}${char}`)
        .join('')}`;
    }

    return `#${hex}`;
  }

  getColorPickerValue(rawValue: string): string {
    return this.normalizeColorValue(rawValue) ?? '#ffffff';
  }

  async handleColorPickerInput(propName: string, nextColor: string): Promise<void> {
    const normalized = this.normalizeColorValue(nextColor);
    if (!normalized) {
      return;
    }

    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value: normalized, isValid: true },
    };

    await this.previewPropertyChange(propName, normalized);
  }

  async handleColorPickerCommit(propName: string, nextColor: string): Promise<void> {
    const normalized = this.normalizeColorValue(nextColor);
    if (!normalized) {
      return;
    }

    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value: normalized, isValid: true },
    };

    await this.commitPropertyChange(propName, normalized);
  }

  async handleSliderPreview(propName: string, nextValue: number): Promise<void> {
    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value: String(nextValue), isValid: true },
    };

    await this.previewPropertyChange(propName, nextValue);
  }

  async handleSliderCommit(propName: string, nextValue: number): Promise<void> {
    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value: String(nextValue), isValid: true },
    };

    await this.commitPropertyChange(propName, nextValue);
  }

  async previewPropertyChange(propertyName: string, value: unknown): Promise<void> {
    if (!this.primaryNode || !this.propertySchema) {
      return;
    }

    const propDef = this.propertySchema.properties.find(p => p.name === propertyName);
    if (!propDef) {
      return;
    }

    if (!this.propertyPreviewStartValues.has(propertyName)) {
      this.propertyPreviewStartValues.set(propertyName, propDef.getValue(this.primaryNode));
    }

    const command = new UpdateObjectPropertyCommand({
      nodeId: this.primaryNode.nodeId,
      propertyPath: propertyName,
      value,
      historyMode: 'preview',
    });

    try {
      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to preview property', propertyName, error);
      const displayValue = getPropertyDisplayValue(this.primaryNode, propDef);
      this.propertyValues = {
        ...this.propertyValues,
        [propertyName]: { value: displayValue, isValid: true },
      };
      this.propertyPreviewStartValues.delete(propertyName);
    }
  }

  async commitPropertyChange(propertyName: string, value: unknown): Promise<void> {
    if (!this.primaryNode || !this.propertySchema) {
      return;
    }

    const hasPreviousValueOverride = this.propertyPreviewStartValues.has(propertyName);
    const previousValue = this.propertyPreviewStartValues.get(propertyName);
    this.propertyPreviewStartValues.delete(propertyName);

    await this.applyPropertyChange(propertyName, value, previousValue, hasPreviousValueOverride);
  }

  async applyPropertyChange(
    propertyName: string,
    value: unknown,
    previousValue?: unknown,
    hasPreviousValueOverride: boolean = false
  ) {
    if (!this.primaryNode || !this.propertySchema) return;

    // Find the property definition
    const propDef = this.propertySchema.properties.find(p => p.name === propertyName);
    if (!propDef) return;

    const command = new UpdateObjectPropertyCommand({
      nodeId: this.primaryNode.nodeId,
      propertyPath: propertyName,
      value,
      ...(hasPreviousValueOverride ? { previousValue } : {}),
      historyMode: 'commit',
    });

    try {
      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to update property', propertyName, error);
      // Revert UI state on error
      const displayValue = getPropertyDisplayValue(this.primaryNode, propDef);
      this.propertyValues = {
        ...this.propertyValues,
        [propertyName]: { value: displayValue, isValid: true },
      };
    }
  }

  async applySpriteSizeChange(
    width: number,
    height: number,
    aspectRatioLocked?: boolean
  ): Promise<void> {
    if (!(this.primaryNode instanceof Sprite2D)) {
      return;
    }

    const command = new UpdateSprite2DSizeCommand({
      nodeId: this.primaryNode.nodeId,
      width,
      height,
      aspectRatioLocked,
    });

    try {
      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to update Sprite2D size', error);
      this.syncValuesFromNode();
      this.requestUpdate();
    }
  }

  async handleComponentPropertyInput(componentId: string, prop: PropertyDefinition, e: Event) {
    const input = e.target as HTMLInputElement;
    const rawValue = input.value;
    const key = getComponentPropertyKey(componentId, prop.name);

    const expectsNumber = prop.type === 'number' || input.type === 'number';
    const numericValue = parseFloat(rawValue);
    const parsedValue: unknown = expectsNumber ? numericValue : rawValue;
    const isValid = expectsNumber ? !Number.isNaN(numericValue) : true;

    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: rawValue, isValid },
    };

    if (isValid) {
      await this.previewComponentPropertyChange(componentId, prop, parsedValue);
    }
  }

  async handleComponentPropertyBlur(componentId: string, prop: PropertyDefinition, e: Event) {
    const input = e.target as HTMLInputElement;
    let value = input.value;
    const key = getComponentPropertyKey(componentId, prop.name);

    if (input.type === 'number') {
      let num = parseFloat(value);
      if (Number.isNaN(num)) num = 0;
      value = parseFloat(num.toFixed(4)).toString();
    }

    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value, isValid: true },
    };

    await this.commitComponentPropertyChange(componentId, prop, value);
  }

  async previewComponentPropertyChange(
    componentId: string,
    propDef: PropertyDefinition,
    value: unknown
  ): Promise<void> {
    if (!this.primaryNode) return;

    const component = this.primaryNode.components.find(c => c.id === componentId);
    if (!component) {
      return;
    }

    const key = getComponentPropertyKey(componentId, propDef.name);
    if (!this.componentPropertyPreviewStartValues.has(key)) {
      this.componentPropertyPreviewStartValues.set(key, propDef.getValue(component));
    }

    const command = new UpdateComponentPropertyCommand({
      nodeId: this.primaryNode.nodeId,
      componentId,
      propertyName: propDef.name,
      value,
      historyMode: 'preview',
    });

    try {
      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to preview component property', propDef.name, error);
      this.componentPropertyValues = {
        ...this.componentPropertyValues,
        [key]: {
          value: getPropertyDisplayValue(component, propDef),
          isValid: true,
        },
      };
      this.componentPropertyPreviewStartValues.delete(key);
    }
  }

  async commitComponentPropertyChange(
    componentId: string,
    propDef: PropertyDefinition,
    value: unknown
  ): Promise<void> {
    const key = getComponentPropertyKey(componentId, propDef.name);
    const hasPreviousValueOverride = this.componentPropertyPreviewStartValues.has(key);
    const previousValue = this.componentPropertyPreviewStartValues.get(key);
    this.componentPropertyPreviewStartValues.delete(key);

    await this.applyComponentPropertyChange(
      componentId,
      propDef,
      value,
      previousValue,
      hasPreviousValueOverride
    );
  }

  async handleComponentSliderPreview(
    componentId: string,
    propDef: PropertyDefinition,
    nextValue: number
  ): Promise<void> {
    const key = getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: String(nextValue), isValid: true },
    };

    await this.previewComponentPropertyChange(componentId, propDef, nextValue);
  }

  async handleComponentSliderCommit(
    componentId: string,
    propDef: PropertyDefinition,
    nextValue: number
  ): Promise<void> {
    const key = getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: String(nextValue), isValid: true },
    };

    await this.commitComponentPropertyChange(componentId, propDef, nextValue);
  }

  async handleComponentColorPickerInput(
    componentId: string,
    propDef: PropertyDefinition,
    nextColor: string
  ): Promise<void> {
    const normalized = this.normalizeColorValue(nextColor);
    if (!normalized) {
      return;
    }

    const key = getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: normalized, isValid: true },
    };

    await this.previewComponentPropertyChange(componentId, propDef, normalized);
  }

  async handleComponentColorPickerCommit(
    componentId: string,
    propDef: PropertyDefinition,
    nextColor: string
  ): Promise<void> {
    const normalized = this.normalizeColorValue(nextColor);
    if (!normalized) {
      return;
    }

    const key = getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: normalized, isValid: true },
    };

    await this.commitComponentPropertyChange(componentId, propDef, normalized);
  }

  async applyComponentPropertyChange(
    componentId: string,
    propDef: PropertyDefinition,
    value: unknown,
    previousValue?: unknown,
    hasPreviousValueOverride: boolean = false
  ): Promise<void> {
    if (!this.primaryNode) return;

    const command = new UpdateComponentPropertyCommand({
      nodeId: this.primaryNode.nodeId,
      componentId,
      propertyName: propDef.name,
      value,
      ...(hasPreviousValueOverride ? { previousValue } : {}),
      historyMode: 'commit',
    });

    try {
      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to update component property', propDef.name, error);
      const component = this.primaryNode.components.find(c => c.id === componentId);
      if (!component) {
        return;
      }
      const key = getComponentPropertyKey(componentId, propDef.name);
      this.componentPropertyValues = {
        ...this.componentPropertyValues,
        [key]: {
          value: getPropertyDisplayValue(component, propDef),
          isValid: true,
        },
      };
    }
  }

  protected render() {
    // A selected library item takes over the inspector with its details; selecting a scene node
    // clears it (see the selection subscription) and restores the node property view.
    if (this.librarySelection) {
      return html`
        <pix3-panel
          panel-role="form"
          panel-description="Details for the selected library item."
          actions-label="Inspector actions"
        >
          <pix3-library-inspector .selection=${this.librarySelection}></pix3-library-inspector>
        </pix3-panel>
      `;
    }

    const hasSelection = this.selectedNodes.length > 0;
    const hasAnimationSelection = this.activeAnimationState !== null;
    const hasAssetSelection = this.selectedAssetItem !== null && !hasAnimationSelection;

    return html`
      <pix3-panel
        panel-role="form"
        panel-description="Adjust properties for the currently selected node."
        actions-label="Inspector actions"
      >
        <div class="inspector-body ${this.isPlaying ? 'is-play-mode' : ''}">
          ${hasAnimationSelection
            ? this.sectionRenderers.renderAnimationProperties()
            : hasAssetSelection
              ? this.sectionRenderers.renderAssetProperties()
              : hasSelection
                ? this.propertyRenderers.renderProperties()
                : ''}
        </div>
      </pix3-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-inspector-panel': InspectorPanel;
  }
}
