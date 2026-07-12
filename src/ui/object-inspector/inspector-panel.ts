import { ComponentBase, customElement, html, state, subscribe, inject } from '@/fw';
import {
  getNodePropertySchema,
  getPropertiesByGroup,
  getPropertyDisplayValue,
  getRuntimeSceneRoot,
  AnimatedSprite2D,
  GeometryMesh,
  MeshInstance,
  NodeBase,
  Node2D,
  Sprite2D,
} from '@pix3/runtime';
import { SceneManager } from '@pix3/runtime';
import { appState } from '@/state';
import type { ScriptComponent } from '@pix3/runtime';
import type { PropertySchema, PropertyDefinition } from '@/fw';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import { UpdateSprite2DSizeCommand } from '@/features/properties/UpdateSprite2DSizeCommand';
import { CreateAndBindAnimationAssetCommand } from '@/features/scene/CreateAndBindAnimationAssetCommand';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { BehaviorPickerService } from '@/services/BehaviorPickerService';
import { EffectPickerService } from '@/services/EffectPickerService';
import { ScriptCreatorService } from '@/services/ScriptCreatorService';
import { ScriptRegistry } from '@pix3/runtime';
import { IconService } from '@/services/IconService';
import { DialogService } from '@/services/DialogService';
import { FileSystemAPIService } from '@/services/FileSystemAPIService';
import {
  AnimationEditorService,
  AssetsPreviewService,
  ProjectStorageService,
  type AssetPreviewItem,
} from '@/services';
import type {
  AnimationInspectorController,
  AnimationInspectorSnapshot,
} from '@/services/AnimationEditorService';
import { EditorTabService } from '@/services/EditorTabService';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { AddComponentCommand } from '@/features/scripts/AddComponentCommand';
import { RemoveComponentCommand } from '@/features/scripts/RemoveComponentCommand';
import { AddEffectCommand } from '@/features/effects/AddEffectCommand';
import { RemoveEffectCommand } from '@/features/effects/RemoveEffectCommand';
import { ToggleScriptEnabledCommand } from '@/features/scripts/ToggleScriptEnabledCommand';
import { UpdateComponentPropertyCommand } from '@/features/scripts/UpdateComponentPropertyCommand';
import { normalizeAnimationAssetPath } from '@/features/scene/animation-asset-utils';
import { AddNodeToGroupCommand } from '@/features/scene/AddNodeToGroupCommand';
import { RemoveNodeFromGroupCommand } from '@/features/scene/RemoveNodeFromGroupCommand';
import { getNodeVisuals } from '@/ui/scene-tree/node-visuals.helper';
import {
  findPrefabInstanceRoot,
  getPrefabMetadata,
  isInstancePlacementProperty,
  isPrefabChildNode,
  isPrefabNode,
  type PrefabMetadata,
} from '@/features/scene/prefab-utils';
import { analyzeAudioBlob } from '@/services/audio-preview-utils';
import type { AnimationPlaybackMode } from '@pix3/runtime';

import '../shared/pix3-panel';
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

interface SelectOption {
  value: string;
  label: string;
}

interface TextureResourceValue {
  type: 'texture';
  url: string;
}

interface AudioPreviewState {
  readonly previewUrl: string;
  readonly waveformUrl: string;
  readonly durationSeconds: number | null;
  readonly channelCount: number | null;
  readonly sampleRate: number | null;
  readonly size: number;
}

interface TextAssetPreviewState {
  readonly content: string;
  readonly lineCount: number | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

type ReadOnlyValue = boolean | ((target: unknown) => boolean) | undefined;
type PropertySectionOptions = {
  className?: string;
  hideTitle?: boolean;
};

const ASSET_RESOURCE_MIME = 'application/x-pix3-asset-resource';
const ASSET_PATH_MIME = 'application/x-pix3-asset-path';
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'tif',
  'tiff',
  'avif',
]);
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'ogg']);
const MODEL_EXTENSIONS = new Set(['glb', 'gltf']);
const ANIMATION_EXTENSIONS = new Set(['pix3anim']);
const DEFAULT_ANIMATION_ASSET_DIRECTORY = 'res://animations';
const PROPERTY_GROUP_ORDER = [
  'Transform',
  'Patch',
  'Size',
  'Slice',
  'Tile',
  'Anchor',
  'Style',
  'Sprite',
  'Animation',
];
const PROPERTY_GROUP_ORDER_INDEX = new Map(
  PROPERTY_GROUP_ORDER.map((groupName, index) => [groupName, index])
);

@customElement('pix3-inspector-panel')
export class InspectorPanel extends ComponentBase {
  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(BehaviorPickerService)
  private readonly behaviorPickerService!: BehaviorPickerService;

  @inject(EffectPickerService)
  private readonly effectPickerService!: EffectPickerService;

  @inject(ScriptCreatorService)
  private readonly scriptCreatorService!: ScriptCreatorService;

  @inject(ScriptRegistry)
  private readonly scriptRegistry!: ScriptRegistry;

  @inject(IconService)
  private readonly iconService!: IconService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(FileSystemAPIService)
  private readonly fileSystemAPI!: FileSystemAPIService;

  @inject(ProjectStorageService)
  private readonly projectStorage!: ProjectStorageService;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @inject(AssetsPreviewService)
  private readonly assetsPreviewService!: AssetsPreviewService;

  @inject(AnimationEditorService)
  private readonly animationEditorService!: AnimationEditorService;

  @inject(ViewportRendererService)
  private readonly viewportService!: ViewportRendererService;

  @state()
  private selectedNodes: NodeBase[] = [];

  @state()
  private primaryNode: NodeBase | null = null;

  /**
   * True while play mode is active AND the selected node resolves to its live
   * runtime-clone counterpart. Drives the "LIVE" badge variant and live value
   * mirroring; the read-only gate itself keys off play mode (`isPlaying`).
   */
  @state()
  private isLivePlayMode = false;

  /**
   * Whether play mode is active. Reactive so the inspector can render its
   * read-only play-mode badge/tint, and used to detect transitions on the
   * (noisy) appState.ui subscription. Two-way editing during play is out of scope.
   */
  @state()
  private isPlaying = appState.ui.isPlaying;

  /** Interval that re-reads live values off the runtime clone while playing. */
  private liveRefreshTimer: number | null = null;

  @state()
  private propertySchema: PropertySchema | null = null;

  @state()
  private propertyValues: Record<string, PropertyUIState> = {};

  @state()
  private componentPropertyValues: Record<string, PropertyUIState> = {};

  @state()
  private selectedAssetItem: AssetPreviewItem | null = null;

  @state()
  private creatingAnimationPropertyName: string | null = null;

  @state()
  private activePreviewAnimation: string | null = null;

  @state()
  private newGroupName: string = '';

  @state()
  private newGroupError: string | null = null;

  @state()
  private isGroupsEditorOpen = false;

  @state()
  private activeAnimationState: AnimationInspectorSnapshot | null = null;

  private disposeSelectionSubscription?: () => void;
  private disposeSceneSubscription?: () => void;
  private disposeUiSubscription?: () => void;
  private disposeAssetPreviewSubscription?: () => void;
  private disposeAnimationEditorSubscription?: () => void;
  private disposeAnimationControllerSubscription?: () => void;
  private scriptCreatorRequestedHandler?: (e: Event) => void;
  private activeAnimationController: AnimationInspectorController | null = null;

  private readonly texturePreviewUrls = new Map<string, string>();
  private readonly texturePreviewMetadata = new Map<
    string,
    { width: number; height: number; size: number }
  >();
  private readonly texturePreviewLoads = new Set<string>();
  private readonly audioPreviewUrls = new Map<string, string>();
  private readonly audioPreviewMetadata = new Map<
    string,
    {
      waveformUrl: string;
      durationSeconds: number | null;
      channelCount: number | null;
      sampleRate: number | null;
      size: number;
    }
  >();
  private readonly audioPreviewLoads = new Set<string>();
  private readonly textAssetPreviewContent = new Map<
    string,
    { content: string; lineCount: number; isTruncated: boolean }
  >();
  private readonly textAssetPreviewLoads = new Set<string>();
  private readonly textAssetPreviewErrors = new Map<string, string>();
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
    this.disposeAssetPreviewSubscription = this.assetsPreviewService.subscribe(snapshot => {
      this.selectedAssetItem = snapshot.selectedItem;
      if (snapshot.selectedItem?.previewType === 'model') {
        this.assetsPreviewService.requestThumbnail(snapshot.selectedItem.path);
      }
      this.requestUpdate();
    });
    this.disposeAnimationEditorSubscription = this.animationEditorService.subscribe(() => {
      this.syncActiveAnimationContext();
    });
    this.updateSelectedNodes();
    this.syncActiveAnimationContext();
    if (appState.ui.isPlaying) {
      this.startLiveTimer();
    }

    // Track focus for context-aware shortcuts
    this.addEventListener('focusin', () => {
      appState.editorContext.focusedArea = 'inspector';
    });

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

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disposeSelectionSubscription?.();
    this.disposeSelectionSubscription = undefined;
    this.disposeSceneSubscription?.();
    this.disposeSceneSubscription = undefined;
    this.disposeUiSubscription?.();
    this.disposeUiSubscription = undefined;
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
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);

    for (const previewUrl of this.texturePreviewUrls.values()) {
      URL.revokeObjectURL(previewUrl);
    }
    this.texturePreviewUrls.clear();
    this.texturePreviewMetadata.clear();
    this.texturePreviewLoads.clear();
    for (const previewUrl of this.audioPreviewUrls.values()) {
      URL.revokeObjectURL(previewUrl);
    }
    this.audioPreviewUrls.clear();
    this.audioPreviewMetadata.clear();
    this.audioPreviewLoads.clear();
    this.textAssetPreviewContent.clear();
    this.textAssetPreviewLoads.clear();
    this.textAssetPreviewErrors.clear();
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

  private async handleCopyResourceUrl(url: string) {
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
  private syncValuesFromNode(valueSource?: NodeBase): void {
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
        const key = this.getComponentPropertyKey(component.id, prop.name);
        values[key] = {
          value: this.getPropertyDisplayValue(valueComponent, prop),
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

  private getPropertyDisplayValue(target: unknown, prop: PropertyDefinition): string {
    const value = prop.getValue(target);

    if (prop.type === 'number') {
      const num = Number(value);
      if (Number.isNaN(num)) return '0';
      const precision = prop.ui?.precision ?? 2;
      return parseFloat(num.toFixed(precision)).toString();
    }

    if (prop.type === 'boolean') {
      return String(value === true);
    }

    if (
      prop.type === 'vector2' ||
      prop.type === 'vector3' ||
      prop.type === 'vector4' ||
      prop.type === 'euler' ||
      prop.type === 'object'
    ) {
      return JSON.stringify(value);
    }

    return String(value ?? '');
  }

  private getComponentPropertyKey(componentId: string, propertyName: string): string {
    return `${componentId}:${propertyName}`;
  }

  private toTextureResourceValue(rawValue: unknown): TextureResourceValue {
    if (typeof rawValue === 'object' && rawValue !== null) {
      const value = rawValue as { type?: unknown; url?: unknown };
      if (value.type === 'texture' && typeof value.url === 'string') {
        return { type: 'texture', url: value.url };
      }
      if (typeof value.url === 'string') {
        return { type: 'texture', url: value.url };
      }
    }

    if (typeof rawValue === 'string') {
      try {
        const parsed = JSON.parse(rawValue) as unknown;
        return this.toTextureResourceValue(parsed);
      } catch {
        return { type: 'texture', url: rawValue };
      }
    }

    return { type: 'texture', url: '' };
  }

  private getTexturePreviewUrl(textureUrl: string): string {
    const resourceUrl = textureUrl.trim();
    if (!resourceUrl || !this.isImageResource(resourceUrl)) {
      return '';
    }

    if (resourceUrl.startsWith('http://') || resourceUrl.startsWith('https://')) {
      return resourceUrl;
    }

    const cached = this.texturePreviewUrls.get(resourceUrl);
    if (cached) {
      return cached;
    }

    if (resourceUrl.startsWith('res://') && !this.texturePreviewLoads.has(resourceUrl)) {
      this.texturePreviewLoads.add(resourceUrl);
      void (async () => {
        try {
          const blob = await this.fileSystemAPI.readBlob(resourceUrl);
          const objectUrl = URL.createObjectURL(blob);

          // Get image dimensions
          const dimensions = await new Promise<{ width: number; height: number }>(resolve => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve({ width: 0, height: 0 });
            img.src = objectUrl;
          });

          this.texturePreviewUrls.set(resourceUrl, objectUrl);
          this.texturePreviewMetadata.set(resourceUrl, {
            ...dimensions,
            size: blob.size,
          });
          this.requestUpdate();
        } catch {
          // Keep empty preview when read fails.
        } finally {
          this.texturePreviewLoads.delete(resourceUrl);
        }
      })();
    }

    return '';
  }

  private isImageResource(path: string): boolean {
    return this.hasSupportedExtension(path, IMAGE_EXTENSIONS);
  }

  private getTextAssetPreview(
    assetPath: string,
    fallbackText: string | null
  ): TextAssetPreviewState {
    const normalizedPath = assetPath.trim();
    if (!normalizedPath) {
      return {
        content: '',
        lineCount: null,
        isLoading: false,
        error: null,
      };
    }

    const cached = this.textAssetPreviewContent.get(normalizedPath);
    if (!cached && !this.textAssetPreviewLoads.has(normalizedPath)) {
      this.textAssetPreviewLoads.add(normalizedPath);
      void (async () => {
        try {
          const rawText = await this.projectStorage.readTextFile(normalizedPath);
          const normalizedText = rawText.replace(/\r\n/g, '\n');
          const lineCount = normalizedText.length === 0 ? 0 : normalizedText.split('\n').length;
          const maxLength = 24000;
          const isTruncated = normalizedText.length > maxLength;
          const content = isTruncated
            ? `${normalizedText.slice(0, maxLength)}\n\n... Preview truncated`
            : normalizedText;

          this.textAssetPreviewContent.set(normalizedPath, {
            content: content || 'Empty file',
            lineCount,
            isTruncated,
          });
          this.textAssetPreviewErrors.delete(normalizedPath);
        } catch (error) {
          this.textAssetPreviewErrors.set(
            normalizedPath,
            error instanceof Error ? error.message : 'Failed to load file content.'
          );
        } finally {
          this.textAssetPreviewLoads.delete(normalizedPath);
          this.requestUpdate();
        }
      })();
    }

    return {
      content: cached?.content ?? fallbackText ?? '',
      lineCount: cached?.lineCount ?? null,
      isLoading: this.textAssetPreviewLoads.has(normalizedPath),
      error: this.textAssetPreviewErrors.get(normalizedPath) ?? null,
    };
  }

  private getAudioPreview(resourceUrl: string): AudioPreviewState {
    const normalizedUrl = resourceUrl.trim();
    if (!normalizedUrl || !this.isAudioResource(normalizedUrl)) {
      return {
        previewUrl: '',
        waveformUrl: '',
        durationSeconds: null,
        channelCount: null,
        sampleRate: null,
        size: 0,
      };
    }

    const previewUrl =
      normalizedUrl.startsWith('http://') || normalizedUrl.startsWith('https://')
        ? normalizedUrl
        : (this.audioPreviewUrls.get(normalizedUrl) ?? '');
    const metadata = this.audioPreviewMetadata.get(normalizedUrl);

    if (normalizedUrl.startsWith('res://') && !this.audioPreviewLoads.has(normalizedUrl)) {
      const hasLoadedPreview = previewUrl.length > 0 || metadata !== undefined;
      if (!hasLoadedPreview) {
        this.audioPreviewLoads.add(normalizedUrl);
        void (async () => {
          try {
            const blob = await this.fileSystemAPI.readBlob(normalizedUrl);
            const objectUrl = URL.createObjectURL(blob);
            const analysis = await analyzeAudioBlob(blob);

            this.audioPreviewUrls.set(normalizedUrl, objectUrl);
            this.audioPreviewMetadata.set(normalizedUrl, {
              waveformUrl: analysis.waveformUrl ?? '',
              durationSeconds: analysis.durationSeconds,
              channelCount: analysis.channelCount,
              sampleRate: analysis.sampleRate,
              size: blob.size,
            });
            this.requestUpdate();
          } catch {
            // Keep empty preview when read fails.
          } finally {
            this.audioPreviewLoads.delete(normalizedUrl);
          }
        })();
      }
    }

    return {
      previewUrl,
      waveformUrl: metadata?.waveformUrl ?? '',
      durationSeconds: metadata?.durationSeconds ?? null,
      channelCount: metadata?.channelCount ?? null,
      sampleRate: metadata?.sampleRate ?? null,
      size: metadata?.size ?? 0,
    };
  }

  private isAudioResource(path: string): boolean {
    return this.hasSupportedExtension(path, AUDIO_EXTENSIONS);
  }

  private isModelResource(path: string): boolean {
    return this.hasSupportedExtension(path, MODEL_EXTENSIONS);
  }

  private isAnimationResource(path: string): boolean {
    return this.hasSupportedExtension(path, ANIMATION_EXTENSIONS);
  }

  private hasSupportedExtension(path: string, extensions: ReadonlySet<string>): boolean {
    const cleaned = path.split('?')[0].split('#')[0];
    const extension = cleaned.includes('.') ? (cleaned.split('.').pop()?.toLowerCase() ?? '') : '';
    return extensions.has(extension);
  }

  private normalizeDroppedResource(
    rawValue: string,
    isSupportedResource: (path: string) => boolean
  ): string | null {
    const value = rawValue.trim();
    if (!value) {
      return null;
    }

    if (value.startsWith('res://') || value.startsWith('http://') || value.startsWith('https://')) {
      return isSupportedResource(value) ? value : null;
    }

    if (value.includes('://')) {
      return null;
    }

    const normalized = value.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\\+/g, '/');
    const resourcePath = `res://${normalized}`;
    return isSupportedResource(resourcePath) ? resourcePath : null;
  }

  private getDroppedResource(
    event: DragEvent,
    isSupportedResource: (path: string) => boolean
  ): string | null {
    const transfer = event.dataTransfer;
    if (!transfer) {
      return null;
    }

    const fromResource = transfer.getData(ASSET_RESOURCE_MIME);
    const normalizedResource = this.normalizeDroppedResource(fromResource, isSupportedResource);
    if (normalizedResource) {
      return normalizedResource;
    }

    const fromPath = transfer.getData(ASSET_PATH_MIME);
    const normalizedPath = this.normalizeDroppedResource(fromPath, isSupportedResource);
    if (normalizedPath) {
      return normalizedPath;
    }

    const fromUriList = transfer.getData('text/uri-list');
    const normalizedUriList = this.normalizeDroppedResource(fromUriList, isSupportedResource);
    if (normalizedUriList) {
      return normalizedUriList;
    }

    const plain = transfer.getData('text/plain');
    return this.normalizeDroppedResource(plain, isSupportedResource);
  }

  private getDroppedTextureResource(event: DragEvent): string | null {
    return this.getDroppedResource(event, path => this.isImageResource(path));
  }

  private getDroppedAudioResource(event: DragEvent): string | null {
    return this.getDroppedResource(event, path => this.isAudioResource(path));
  }

  private getDroppedModelResource(event: DragEvent): string | null {
    return this.getDroppedResource(event, path => this.isModelResource(path));
  }

  private getDroppedAnimationResource(event: DragEvent): string | null {
    return this.getDroppedResource(event, path => this.isAnimationResource(path));
  }

  private onTextureResourceDrop(propertyName: string, event: DragEvent): void {
    const textureUrl = this.getDroppedTextureResource(event);
    if (!textureUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, { type: 'texture', url: textureUrl });
  }

  private onAudioResourceDrop(propertyName: string, event: DragEvent): void {
    const audioUrl = this.getDroppedAudioResource(event);
    if (!audioUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, audioUrl);
  }

  private onModelResourceDrop(propertyName: string, event: DragEvent): void {
    const modelUrl = this.getDroppedModelResource(event);
    if (!modelUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, modelUrl);
  }

  private onAnimationResourceDrop(propertyName: string, event: DragEvent): void {
    const animationUrl = this.getDroppedAnimationResource(event);
    if (!animationUrl) {
      return;
    }

    void this.applyPropertyChange(propertyName, animationUrl);
  }

  private onOpenAnimationResource(resourcePath: string): void {
    const trimmedResourcePath = resourcePath.trim();
    if (!trimmedResourcePath) {
      return;
    }

    void this.editorTabService.focusOrOpenAnimation(trimmedResourcePath);
  }

  private canCreateAnimationResource(
    propertyName: string,
    value: string,
    readOnly: boolean
  ): boolean {
    return (
      !readOnly &&
      propertyName === 'animationResourcePath' &&
      this.primaryNode instanceof AnimatedSprite2D &&
      value.trim().length === 0
    );
  }

  private async onCreateAnimationResource(propertyName: string): Promise<void> {
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

  private onComponentAudioResourceDrop(
    componentId: string,
    prop: PropertyDefinition,
    event: DragEvent
  ): void {
    const audioUrl = this.getDroppedAudioResource(event);
    if (!audioUrl) {
      return;
    }

    void this.applyComponentPropertyChange(componentId, prop, audioUrl);
  }

  private onComponentModelResourceDrop(
    componentId: string,
    prop: PropertyDefinition,
    event: DragEvent
  ): void {
    const modelUrl = this.getDroppedModelResource(event);
    if (!modelUrl) {
      return;
    }

    void this.applyComponentPropertyChange(componentId, prop, modelUrl);
  }

  private async handlePropertyInput(propName: string, e: Event) {
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

  private async handlePropertyBlur(propName: string, e: Event) {
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

  private getColorPickerValue(rawValue: string): string {
    return this.normalizeColorValue(rawValue) ?? '#ffffff';
  }

  private async handleColorPickerInput(propName: string, nextColor: string): Promise<void> {
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

  private async handleColorPickerCommit(propName: string, nextColor: string): Promise<void> {
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

  private async handleSliderPreview(propName: string, nextValue: number): Promise<void> {
    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value: String(nextValue), isValid: true },
    };

    await this.previewPropertyChange(propName, nextValue);
  }

  private async handleSliderCommit(propName: string, nextValue: number): Promise<void> {
    this.propertyValues = {
      ...this.propertyValues,
      [propName]: { value: String(nextValue), isValid: true },
    };

    await this.commitPropertyChange(propName, nextValue);
  }

  private async previewPropertyChange(propertyName: string, value: unknown): Promise<void> {
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

  private async commitPropertyChange(propertyName: string, value: unknown): Promise<void> {
    if (!this.primaryNode || !this.propertySchema) {
      return;
    }

    const hasPreviousValueOverride = this.propertyPreviewStartValues.has(propertyName);
    const previousValue = this.propertyPreviewStartValues.get(propertyName);
    this.propertyPreviewStartValues.delete(propertyName);

    await this.applyPropertyChange(propertyName, value, previousValue, hasPreviousValueOverride);
  }

  private async applyPropertyChange(
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

  private async applySpriteSizeChange(
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

  private async handleComponentPropertyInput(
    componentId: string,
    prop: PropertyDefinition,
    e: Event
  ) {
    const input = e.target as HTMLInputElement;
    const rawValue = input.value;
    const key = this.getComponentPropertyKey(componentId, prop.name);

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

  private async handleComponentPropertyBlur(
    componentId: string,
    prop: PropertyDefinition,
    e: Event
  ) {
    const input = e.target as HTMLInputElement;
    let value = input.value;
    const key = this.getComponentPropertyKey(componentId, prop.name);

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

  private async previewComponentPropertyChange(
    componentId: string,
    propDef: PropertyDefinition,
    value: unknown
  ): Promise<void> {
    if (!this.primaryNode) return;

    const component = this.primaryNode.components.find(c => c.id === componentId);
    if (!component) {
      return;
    }

    const key = this.getComponentPropertyKey(componentId, propDef.name);
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
          value: this.getPropertyDisplayValue(component, propDef),
          isValid: true,
        },
      };
      this.componentPropertyPreviewStartValues.delete(key);
    }
  }

  private async commitComponentPropertyChange(
    componentId: string,
    propDef: PropertyDefinition,
    value: unknown
  ): Promise<void> {
    const key = this.getComponentPropertyKey(componentId, propDef.name);
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

  private async handleComponentSliderPreview(
    componentId: string,
    propDef: PropertyDefinition,
    nextValue: number
  ): Promise<void> {
    const key = this.getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: String(nextValue), isValid: true },
    };

    await this.previewComponentPropertyChange(componentId, propDef, nextValue);
  }

  private async handleComponentSliderCommit(
    componentId: string,
    propDef: PropertyDefinition,
    nextValue: number
  ): Promise<void> {
    const key = this.getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: String(nextValue), isValid: true },
    };

    await this.commitComponentPropertyChange(componentId, propDef, nextValue);
  }

  private async handleComponentColorPickerInput(
    componentId: string,
    propDef: PropertyDefinition,
    nextColor: string
  ): Promise<void> {
    const normalized = this.normalizeColorValue(nextColor);
    if (!normalized) {
      return;
    }

    const key = this.getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: normalized, isValid: true },
    };

    await this.previewComponentPropertyChange(componentId, propDef, normalized);
  }

  private async handleComponentColorPickerCommit(
    componentId: string,
    propDef: PropertyDefinition,
    nextColor: string
  ): Promise<void> {
    const normalized = this.normalizeColorValue(nextColor);
    if (!normalized) {
      return;
    }

    const key = this.getComponentPropertyKey(componentId, propDef.name);
    this.componentPropertyValues = {
      ...this.componentPropertyValues,
      [key]: { value: normalized, isValid: true },
    };

    await this.commitComponentPropertyChange(componentId, propDef, normalized);
  }

  private async applyComponentPropertyChange(
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
      const key = this.getComponentPropertyKey(componentId, propDef.name);
      this.componentPropertyValues = {
        ...this.componentPropertyValues,
        [key]: {
          value: this.getPropertyDisplayValue(component, propDef),
          isValid: true,
        },
      };
    }
  }

  protected render() {
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
            ? this.renderAnimationProperties()
            : hasAssetSelection
              ? this.renderAssetProperties()
              : hasSelection
                ? this.renderProperties()
                : ''}
        </div>
      </pix3-panel>
    `;
  }

  private syncActiveAnimationContext(): void {
    const controller = this.animationEditorService.getActiveController();
    if (controller !== this.activeAnimationController) {
      this.disposeAnimationControllerSubscription?.();
      this.disposeAnimationControllerSubscription = undefined;
      this.activeAnimationController = controller;

      if (controller) {
        this.disposeAnimationControllerSubscription = controller.subscribeInspector(() => {
          this.activeAnimationState = controller.getInspectorSnapshot();
        });
      }
    }

    this.activeAnimationState = controller?.getInspectorSnapshot() ?? null;
  }

  private renderAnimationProperties() {
    const controller = this.activeAnimationController;
    const animationState = this.activeAnimationState;
    if (!controller || !animationState) {
      return '';
    }

    const assetPath = animationState.assetPath;
    const clips = animationState.clips;
    const activeClip = animationState.activeClip;
    const selectedFrame = animationState.selectedFrame;
    const texturePath = animationState.resource?.texturePath?.trim() ?? '';

    return html`
      <div class="property-section">
        <div class="section-header">
          <h3 class="section-title">Animation Inspector</h3>
          <p class="node-type">PIX3ANIM</p>
        </div>

        ${assetPath
          ? html`
              <div class="property-group-section asset-section">
                <h4 class="group-title">Resource</h4>
                <div class="property-group">
                  <span class="property-label">Name</span>
                  <span class="asset-value">${this.getAnimationAssetTitle(assetPath)}</span>
                </div>
                <div class="property-group">
                  <span class="property-label">Path</span>
                  <span class="asset-value asset-path">${assetPath}</span>
                </div>
              </div>
            `
          : null}

        <div class="property-group-section asset-section">
          <div class="section-header">
            <h4 class="group-title">Spritesheet Import</h4>
            ${texturePath ? html`<span class="animation-chip">Source</span>` : null}
          </div>
          <label class="field">
            <span>Import Source</span>
            <input
              type="text"
              .value=${texturePath}
              placeholder="res://textures/spritesheet.png"
              @change=${(event: Event) =>
                void controller.updateTexturePath((event.target as HTMLInputElement).value.trim())}
            />
          </label>
          <div class="toolbar-row">
            <button
              class="primary-button"
              type="button"
              ?disabled=${texturePath.length === 0 || !animationState.activeClipName}
              @click=${() => void controller.openTextureSlicer()}
            >
              Generate Frames...
            </button>
            <button
              class="mini-button"
              type="button"
              ?disabled=${texturePath.length === 0}
              @click=${() => void controller.updateTexturePath('')}
            >
              Clear Texture
            </button>
          </div>
          <div class="panel-note">
            Use this only as a one-time import source. The editor stores sequence frames as separate
            files after slicing.
          </div>
        </div>

        <div class="property-group-section asset-section">
          <div class="section-header">
            <h4 class="group-title">Clips</h4>
            <div class="animation-clip-actions">
              <button
                class="btn-icon"
                type="button"
                title="Add Clip"
                aria-label="Add clip"
                @click=${() => void controller.addClip()}
              >
                ${this.iconService.getIcon('plus', 14)}
              </button>
              <button
                class="btn-icon"
                type="button"
                title="Remove"
                aria-label="Remove active clip"
                ?disabled=${!activeClip}
                @click=${() => void controller.removeClip()}
              >
                ${this.iconService.getIcon('trash-2', 14)}
              </button>
            </div>
          </div>
          <div class="animation-clip-list">
            ${clips.map(
              clip => html`
                <button
                  class="animation-clip-button ${clip.name === animationState.activeClipName
                    ? 'is-active'
                    : ''}"
                  type="button"
                  @click=${() => void controller.selectClip(clip.name)}
                >
                  <span class="animation-clip-name">${clip.name}</span>
                  <span class="animation-clip-meta">${clip.frames.length}</span>
                </button>
              `
            )}
          </div>
        </div>

        ${activeClip
          ? html`
              <div class="property-group-section asset-section">
                <div class="section-header">
                  <h4 class="group-title">Clip</h4>
                  <span class="animation-chip"
                    >${selectedFrame
                      ? `Frame ${animationState.selectedFrameIndex + 1}`
                      : 'Clip'}</span
                  >
                </div>
                <div class="field-grid">
                  <label class="field">
                    <span>Name</span>
                    <input
                      type="text"
                      .value=${activeClip.name}
                      @change=${(event: Event) =>
                        void controller.renameClip((event.target as HTMLInputElement).value.trim())}
                    />
                  </label>
                </div>
                <div class="row">
                  <label class="field">
                    <span>FPS</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      .value=${String(activeClip.fps)}
                      @change=${(event: Event) =>
                        void controller.updateClipFps(
                          Number((event.target as HTMLInputElement).value)
                        )}
                    />
                  </label>
                  <label class="field">
                    <span>Playback</span>
                    <select
                      .value=${activeClip.playbackMode}
                      @change=${(event: Event) =>
                        void controller.updateClipPlaybackMode(
                          (event.target as HTMLSelectElement).value as AnimationPlaybackMode
                        )}
                    >
                      <option value="normal">Normal</option>
                      <option value="ping-pong">Ping-Pong</option>
                    </select>
                  </label>
                </div>
                <label class="field-toggle">
                  <input
                    type="checkbox"
                    .checked=${activeClip.loop}
                    @change=${(event: Event) =>
                      void controller.updateClipLoop((event.target as HTMLInputElement).checked)}
                  />
                  <span>Loop clip</span>
                </label>
              </div>
            `
          : html`
              <div class="property-group-section asset-section">
                <div class="asset-text-preview-state">No active clip selected.</div>
              </div>
            `}
        ${selectedFrame
          ? html`
              <div class="property-group-section asset-section">
                <div class="section-header">
                  <h4 class="group-title">Frame</h4>
                  <span class="frame-chip">${animationState.selectedFrameIndex + 1}</span>
                </div>
                <div class="field-grid">
                  <label class="field">
                    <span>Duration Multiplier</span>
                    <input
                      type="number"
                      min="0.05"
                      step="0.05"
                      .value=${String(selectedFrame.durationMultiplier)}
                      @change=${(event: Event) =>
                        void controller.updateSelectedFrameDurationMultiplier(
                          Number((event.target as HTMLInputElement).value)
                        )}
                    />
                  </label>
                  <label class="field">
                    <span>Texture Override</span>
                    <input
                      type="text"
                      .value=${selectedFrame.texturePath}
                      placeholder="Optional per-frame texture"
                      @change=${(event: Event) =>
                        void controller.updateSelectedFrameTexturePath(
                          (event.target as HTMLInputElement).value.trim()
                        )}
                    />
                  </label>
                </div>
                <div class="row">
                  <label class="field">
                    <span>Anchor X</span>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      .value=${selectedFrame.anchor.x.toFixed(2)}
                      @change=${(event: Event) =>
                        void controller.updateSelectedFrameAnchor(
                          'x',
                          Number((event.target as HTMLInputElement).value)
                        )}
                    />
                  </label>
                  <label class="field">
                    <span>Anchor Y</span>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      .value=${selectedFrame.anchor.y.toFixed(2)}
                      @change=${(event: Event) =>
                        void controller.updateSelectedFrameAnchor(
                          'y',
                          Number((event.target as HTMLInputElement).value)
                        )}
                    />
                  </label>
                </div>
                <div class="field-grid">
                  <div class="inspector-section-title inspector-section-title--subtle">
                    Bounding Box
                  </div>
                </div>
                <div class="row">
                  <label class="field">
                    <span>X</span>
                    <input
                      type="number"
                      step="1"
                      .value=${String(selectedFrame.boundingBox.x)}
                      @change=${(event: Event) =>
                        void controller.updateSelectedFrameBoundingBox(
                          'x',
                          Number((event.target as HTMLInputElement).value)
                        )}
                    />
                  </label>
                  <label class="field">
                    <span>Y</span>
                    <input
                      type="number"
                      step="1"
                      .value=${String(selectedFrame.boundingBox.y)}
                      @change=${(event: Event) =>
                        void controller.updateSelectedFrameBoundingBox(
                          'y',
                          Number((event.target as HTMLInputElement).value)
                        )}
                    />
                  </label>
                </div>
                <div class="row">
                  <label class="field">
                    <span>Width</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      .value=${String(selectedFrame.boundingBox.width)}
                      @change=${(event: Event) =>
                        void controller.updateSelectedFrameBoundingBox(
                          'width',
                          Number((event.target as HTMLInputElement).value)
                        )}
                    />
                  </label>
                  <label class="field">
                    <span>Height</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      .value=${String(selectedFrame.boundingBox.height)}
                      @change=${(event: Event) =>
                        void controller.updateSelectedFrameBoundingBox(
                          'height',
                          Number((event.target as HTMLInputElement).value)
                        )}
                    />
                  </label>
                </div>
                <div class="field-grid">
                  <div class="inspector-section-title inspector-section-title--subtle">
                    Collision Polygon
                  </div>
                  <div class="panel-note">
                    ${selectedFrame.collisionPolygon.length
                      ? `${selectedFrame.collisionPolygon.length} vertices authored.`
                      : 'No collision polygon authored yet.'}
                  </div>
                </div>
                <div class="toolbar-row">
                  <button
                    class="mini-button"
                    type="button"
                    @click=${() => void controller.addPolygonVertex()}
                  >
                    Add Vertex
                  </button>
                  <button
                    class="mini-button"
                    type="button"
                    @click=${() => void controller.clearPolygon()}
                  >
                    Clear Polygon
                  </button>
                  <button
                    class="mini-button"
                    type="button"
                    @click=${() => void controller.resetBoundingBox()}
                  >
                    Reset Box
                  </button>
                </div>
              </div>
            `
          : html`
              <div class="property-group-section asset-section">
                <div class="asset-text-preview-state">
                  Pick a frame in the timeline to edit delay, anchor, bounding box, and polygon
                  data.
                </div>
              </div>
            `}
      </div>
    `;
  }

  private getAnimationAssetTitle(assetPath: string): string {
    const segments = assetPath.replace(/\\/g, '/').split('/').filter(Boolean);
    return segments[segments.length - 1] ?? assetPath;
  }

  private renderAssetProperties() {
    if (!this.selectedAssetItem) {
      return '';
    }

    const asset = this.selectedAssetItem;
    const isImage = asset.previewType === 'image' && asset.thumbnailUrl !== null;
    const isModel = asset.previewType === 'model';
    const isAudio = asset.previewType === 'audio';
    const isText = asset.previewType === 'text';
    const textPreview = isText ? this.getTextAssetPreview(asset.path, asset.previewText) : null;
    const resourceUrl = asset.path === '.' ? 'res://' : `res://${asset.path}`;

    return html`
      <div class="property-section">
        <div class="section-header">
          <h3 class="section-title">Asset Inspector</h3>
          <p class="node-type">${asset.extension ? asset.extension.toUpperCase() : 'FILE'}</p>
        </div>

        <div class="property-group-section asset-section">
          <h4 class="group-title">Preview</h4>
          ${isModel
            ? html`
                <pix3-model-asset-preview
                  .resourcePath=${resourceUrl}
                  .assetName=${asset.name}
                  .fallbackImageUrl=${asset.thumbnailUrl ?? ''}
                  .thumbnailStatus=${asset.thumbnailStatus}
                ></pix3-model-asset-preview>
              `
            : isAudio
              ? html`
                  <pix3-audio-resource-editor
                    .resourceUrl=${resourceUrl}
                    .previewUrl=${asset.previewUrl ?? ''}
                    .waveformUrl=${asset.thumbnailUrl ?? ''}
                    .durationSeconds=${asset.durationSeconds ?? 0}
                    .channelCount=${asset.channelCount ?? 0}
                    .sampleRate=${asset.sampleRate ?? 0}
                    .fileSize=${asset.sizeBytes ?? 0}
                    .showResourceControls=${false}
                  ></pix3-audio-resource-editor>
                `
              : isText
                ? html`
                    <div class="asset-text-preview-shell">
                      ${textPreview?.isLoading && !textPreview.content
                        ? html`<div class="asset-text-preview-state">Loading content...</div>`
                        : textPreview?.error
                          ? html`<div
                              class="asset-text-preview-state asset-text-preview-state--error"
                            >
                              ${textPreview.error}
                            </div>`
                          : html`<pre class="asset-text-preview">
${textPreview?.content || 'Empty file'}</pre
                            >`}
                    </div>
                  `
                : isImage
                  ? html`
                      <div class="asset-image-preview checker-bg">
                        <img src=${asset.thumbnailUrl!} alt=${asset.name} />
                      </div>
                    `
                  : html`
                      <div class="asset-file-icon">
                        ${this.iconService.getIcon(asset.iconName, 42)}
                      </div>
                    `}
        </div>

        <div class="property-group-section asset-section">
          <h4 class="group-title">Properties</h4>
          <div class="property-group">
            <span class="property-label">Name</span>
            <span class="asset-value">${asset.name}</span>
          </div>

          <div class="property-group">
            <span class="property-label" title="Resource URL (res://)">Resource</span>
            <div class="asset-value-wrapper">
              <span class="asset-value asset-path">${resourceUrl}</span>
              <button
                class="btn-copy-resource"
                title="Copy Resource URL"
                @click=${() => this.handleCopyResourceUrl(resourceUrl)}
              >
                ${this.iconService.getIcon('copy', 14)}
              </button>
            </div>
          </div>

          <div class="property-group">
            <span class="property-label">Path</span>
            <span class="asset-value asset-path">${asset.path}</span>
          </div>
          ${asset.width !== null && asset.height !== null
            ? html`
                <div class="property-group">
                  <span class="property-label">Resolution</span>
                  <span class="asset-value">${asset.width} x ${asset.height}</span>
                </div>
              `
            : ''}
          ${isAudio && asset.durationSeconds !== null
            ? html`
                <div class="property-group">
                  <span class="property-label">Duration</span>
                  <span class="asset-value">${this.formatDuration(asset.durationSeconds)}</span>
                </div>
              `
            : ''}
          ${isAudio && asset.channelCount !== null
            ? html`
                <div class="property-group">
                  <span class="property-label">Channels</span>
                  <span class="asset-value">${asset.channelCount}</span>
                </div>
              `
            : ''}
          ${isAudio && asset.sampleRate !== null
            ? html`
                <div class="property-group">
                  <span class="property-label">Sample Rate</span>
                  <span class="asset-value">${this.formatSampleRate(asset.sampleRate)}</span>
                </div>
              `
            : ''}
          ${isText && textPreview !== null && textPreview.lineCount !== null
            ? html`
                <div class="property-group">
                  <span class="property-label">Lines</span>
                  <span class="asset-value">${textPreview.lineCount}</span>
                </div>
              `
            : ''}
          <div class="property-group">
            <span class="property-label">Size</span>
            <span class="asset-value">${this.formatFileSize(asset.sizeBytes)}</span>
          </div>
        </div>
      </div>
    `;
  }

  private formatFileSize(sizeBytes: number | null): string {
    if (sizeBytes === null) {
      return '-';
    }
    if (sizeBytes < 1024) {
      return `${sizeBytes} B`;
    }
    const kb = sizeBytes / 1024;
    if (kb < 1024) {
      return `${kb.toFixed(1)} KB`;
    }
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  private formatDuration(durationSeconds: number | null): string {
    if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
      return '-';
    }

    const totalSeconds = Math.round(durationSeconds);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private formatSampleRate(sampleRate: number | null): string {
    if (sampleRate === null || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      return '-';
    }

    const khz = sampleRate / 1000;
    return `${khz % 1 === 0 ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
  }

  private renderProperties() {
    if (!this.primaryNode || !this.propertySchema) {
      return '';
    }

    const groupedProps = getPropertiesByGroup(this.propertySchema);
    const baseProps = groupedProps.get('Base') ?? [];
    const editorProps = groupedProps.get('Editor') ?? [];
    const summaryPropertyNames = new Set(['id', 'name', 'type', 'groups']);
    const editorFlagNames = new Set(['visible', 'locked']);

    const supplementaryProps = [...baseProps, ...editorProps].filter(
      prop =>
        !summaryPropertyNames.has(prop.name) && !editorFlagNames.has(prop.name) && !prop.ui?.hidden
    );

    const sortedGroups = Array.from(groupedProps.entries())
      // 'Effect: *' groups come from the instance schema and are rendered as
      // cards by renderEffectsSection, not as plain property groups.
      .filter(
        ([groupName]) =>
          groupName !== 'Base' && groupName !== 'Editor' && !groupName.startsWith('Effect: ')
      )
      .sort(([nameA], [nameB]) => {
        const orderA = PROPERTY_GROUP_ORDER_INDEX.get(nameA) ?? PROPERTY_GROUP_ORDER.length;
        const orderB = PROPERTY_GROUP_ORDER_INDEX.get(nameB) ?? PROPERTY_GROUP_ORDER.length;

        if (orderA !== orderB) {
          return orderA - orderB;
        }

        return nameA.localeCompare(nameB);
      });

    return html`
      <div class="property-section property-section--object">
        ${this.renderInspectorSummary()} ${this.renderEditorFlagsRow()}
        ${supplementaryProps.length > 0
          ? html`
              <div class="property-group-section property-group-section--compact">
                ${supplementaryProps.map(prop => this.renderPropertyInput(prop))}
              </div>
            `
          : ''}
        ${sortedGroups.map(([groupName, props]) => this.renderPropertyGroup(groupName, props))}
        ${this.renderAnimationsSection()} ${this.renderEffectsSection()}
        ${this.renderScriptsSection()}
      </div>
    `;
  }

  private renderInspectorSummary() {
    if (!this.primaryNode) {
      return '';
    }

    const { icon, color } = getNodeVisuals(this.primaryNode);
    const nameState = this.propertyValues['name'];
    const groups = Array.from(this.primaryNode.groups).sort((a, b) => a.localeCompare(b));
    const nameProp = this.propertySchema?.properties.find(prop => prop.name === 'name');
    // Renaming a prefab instance child breaks the effectiveLocalId keys that
    // property overrides are stored under, so lock it. The instance root keeps an
    // editable name (it is serialized on the `instance:` definition).
    const nameReadOnly =
      this.isPropertyReadOnly(nameProp?.ui?.readOnly, this.primaryNode) ||
      isPrefabChildNode(this.primaryNode);

    return html`
      <div class="inspector-summary">
        <div class="inspector-summary-main">
          <div class="inspector-type-icon" style=${`--node-type-color: ${color};`}>
            ${this.iconService.getIcon(icon, 18)}
          </div>
          <div class="inspector-summary-text">
            <input
              type="text"
              class="property-input property-input--text inspector-name-input ${nameState?.isValid ===
              false
                ? 'property-input--invalid'
                : ''}"
              .value=${nameState?.value ?? this.primaryNode.name}
              ?disabled=${nameReadOnly}
              @input=${(e: Event) => this.handlePropertyInput('name', e)}
              @blur=${(e: Event) => this.handlePropertyBlur('name', e)}
            />
            <div class="inspector-summary-meta">
              <span class="inspector-summary-type">${this.primaryNode.type}</span>
              <span class="inspector-summary-meta-separator"></span>
              <span class="inspector-summary-id">${this.primaryNode.nodeId}</span>
              ${this.isPlaying
                ? html`
                    <span class="inspector-summary-meta-separator"></span>
                    <span
                      class="inspector-live-badge ${this.isLivePlayMode
                        ? ''
                        : 'inspector-live-badge--static'}"
                      title=${this.isLivePlayMode
                        ? 'Read-only live values from the running game (play mode)'
                        : 'Read-only during play mode — no live runtime counterpart for this node'}
                      >${this.isLivePlayMode ? '● PLAY · LIVE' : 'PLAY · READ-ONLY'}</span
                    >
                  `
                : ''}
              ${this.selectedNodes.length > 1
                ? html`
                    <span class="inspector-summary-meta-separator"></span>
                    <span class="selection-info">
                      ${this.selectedNodes.length} objects selected
                    </span>
                  `
                : ''}
            </div>
            ${groups.length > 0
              ? html`
                  <div class="group-chip-list group-chip-list--summary">
                    ${groups.map(
                      group => html`<span class="group-chip group-chip--readonly">${group}</span>`
                    )}
                  </div>
                `
              : ''}
          </div>
        </div>

        <div class="inspector-summary-actions">
          <button
            class="summary-toolbar-button ${this.isGroupsEditorOpen ? 'is-open' : ''}"
            type="button"
            title="Edit groups"
            aria-expanded=${String(this.isGroupsEditorOpen)}
            @click=${(event: Event) => this.toggleGroupsEditor(event)}
          >
            ${this.iconService.getIcon('grid', 14)}
            <span>Groups</span>
            ${this.iconService.getIcon('chevron-down-caret', 12)}
          </button>
          ${this.isGroupsEditorOpen ? this.renderGroupsPopover() : ''}
        </div>
      </div>
    `;
  }

  private renderGroupsPopover() {
    if (!this.primaryNode) {
      return '';
    }

    const groups = Array.from(this.primaryNode.groups).sort((a, b) => a.localeCompare(b));
    return html`
      <div class="groups-popover" @click=${(event: Event) => event.stopPropagation()}>
        <div class="groups-popover-list">
          ${groups.length === 0
            ? html`<div class="groups-empty">No groups assigned</div>`
            : groups.map(
                group => html`
                  <div class="groups-popover-item">
                    <span class="group-chip group-chip--readonly">${group}</span>
                    <button
                      class="btn-icon"
                      type="button"
                      title="Remove from group"
                      @click=${() => this.removeFromGroup(group)}
                    >
                      ${this.iconService.getIcon('x', 14)}
                    </button>
                  </div>
                `
              )}
        </div>
        <div class="group-add-row group-add-row--popover">
          <input
            class="property-input property-input--text group-input"
            .value=${this.newGroupName}
            placeholder="group_name"
            @input=${(e: Event) => this.onGroupNameInput(e)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void this.addToGroup();
              }
            }}
          />
          <button class="btn-add-group" type="button" @click=${() => this.addToGroup()}>Add</button>
        </div>
        ${this.newGroupError ? html`<div class="groups-error">${this.newGroupError}</div>` : ''}
      </div>
    `;
  }

  private toggleGroupsEditor(event: Event): void {
    event.stopPropagation();
    this.isGroupsEditorOpen = !this.isGroupsEditorOpen;
  }

  private renderEditorFlagsRow() {
    if (!this.primaryNode) {
      return '';
    }

    const visible = this.propertyValues['visible']?.value === 'true';
    const locked = this.propertyValues['locked']?.value === 'true';
    // Play mode is a read-only live mirror — gate these flags like every other
    // property editor so they can't silently mutate the authored node.
    const readOnly = appState.collaboration.isReadOnly || appState.ui.isPlaying;

    return html`
      <div class="property-group-section property-group-section--flags">
        <div class="editor-flags-row">
          <button
            class="editor-flag-button ${visible ? 'is-active' : ''}"
            type="button"
            ?disabled=${readOnly}
            aria-pressed=${String(visible)}
            @click=${() => this.applyPropertyChange('visible', !visible)}
          >
            ${this.iconService.getIcon('eye', 14)}
            <span>Visible</span>
          </button>
          <button
            class="editor-flag-button ${locked ? 'is-active' : ''}"
            type="button"
            ?disabled=${readOnly}
            aria-pressed=${String(locked)}
            @click=${() => this.applyPropertyChange('locked', !locked)}
          >
            ${this.iconService.getIcon(locked ? 'lock' : 'unlock', 14)}
            <span>Locked</span>
          </button>
        </div>
      </div>
    `;
  }

  private renderAnimationsSection() {
    if (!(this.primaryNode instanceof MeshInstance)) return '';
    const clips = this.primaryNode.animations;
    if (clips.length === 0) return '';
    const initialAnimation = this.primaryNode.initialAnimation;

    return html`
      <div class="property-group-section animations-section">
        <h4 class="group-title">Animations</h4>
        <div class="animation-list">
          ${clips.map(clip => {
            const isActive = this.activePreviewAnimation === clip.name;
            const isDefault = initialAnimation === clip.name;
            return html`
              <div class="animation-item ${isActive ? 'animation-item--active' : ''}">
                <button
                  class="animation-preview-btn"
                  @click=${() => this.toggleAnimation(clip.name)}
                  title=${isActive ? 'Stop preview animation' : 'Play preview animation'}
                >
                  <span class="animation-play-icon">${isActive ? '⏹' : '▶'}</span>
                  <span class="animation-name">${clip.name}</span>
                  <span class="animation-duration">${clip.duration.toFixed(2)}s</span>
                </button>
                <button
                  class="animation-default-btn ${isDefault ? 'animation-default-btn--active' : ''}"
                  @click=${() => this.setInitialAnimation(clip.name)}
                  title=${isDefault
                    ? 'Default startup animation'
                    : 'Set as default startup animation'}
                >
                  ${isDefault ? 'Default' : 'Set Default'}
                </button>
              </div>
            `;
          })}
        </div>
        <div class="animation-default-row">
          <button
            class="animation-default-clear"
            @click=${() => this.setInitialAnimation(null)}
            ?disabled=${initialAnimation === null}
            title="Clear default startup animation (fallback to first clip)"
          >
            Clear Default
          </button>
        </div>
      </div>
    `;
  }

  private setInitialAnimation(name: string | null): void {
    const value = name ?? '';
    void this.applyPropertyChange('initialAnimation', value);
  }

  private toggleAnimation(name: string) {
    if (!this.primaryNode) return;
    const next = this.activePreviewAnimation === name ? null : name;
    this.activePreviewAnimation = next;
    this.viewportService.setPreviewAnimation(this.primaryNode.nodeId, next);
  }

  private onGroupNameInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.newGroupName = input.value;
    this.newGroupError = null;
  }

  private async addToGroup(): Promise<void> {
    if (!this.primaryNode) {
      return;
    }

    const groupName = this.newGroupName.trim();
    if (!/^[A-Za-z0-9_]+$/.test(groupName)) {
      this.newGroupError = 'Use letters, numbers, and underscores only.';
      return;
    }

    const command = new AddNodeToGroupCommand({
      nodeId: this.primaryNode.nodeId,
      group: groupName,
    });
    const didMutate = await this.commandDispatcher.execute(command);
    if (!didMutate) {
      this.newGroupError = 'Group update failed. Check project/scene state and duplicate names.';
      return;
    }

    this.newGroupName = '';
    this.newGroupError = null;
  }

  private async removeFromGroup(group: string): Promise<void> {
    if (!this.primaryNode) {
      return;
    }
    const command = new RemoveNodeFromGroupCommand({
      nodeId: this.primaryNode.nodeId,
      group,
    });
    await this.commandDispatcher.execute(command);
  }

  private renderScriptsSection() {
    if (!this.primaryNode) return '';

    const components = this.primaryNode.components || [];
    // Components on a prefab instance node are not serialized as overrides, so
    // adding/removing/toggling them here would be silently lost on save. Lock the
    // structural actions on every node of an instance (root included).
    const structureLocked = isPrefabNode(this.primaryNode);
    const lockedTitle = 'Managed by the prefab — open the prefab to edit its components';

    return html`
      <div class="property-group-section scripts-section">
        <div class="group-header">
          <h4 class="group-title">Components</h4>
          <div class="group-actions">
            <button
              class="btn-add-behavior"
              @click=${this.onAddBehavior}
              ?disabled=${structureLocked}
              title=${structureLocked ? lockedTitle : 'Add Component'}
            >
              ${this.iconService.getIcon('plus', 14)}
              <span>Add</span>
            </button>
          </div>
        </div>

        <div class="scripts-list">
          ${components.map(
            component => html`
              <div class="component-block ${component.enabled ? '' : 'component-block--disabled'}">
                <div class="script-item component-item">
                  <div class="script-icon">
                    ${this.iconService.getIcon(this.getComponentIconName(component.type), 16)}
                  </div>
                  <div class="script-info">
                    <div class="script-name">${component.type}</div>
                  </div>
                  <div class="script-actions">
                    <button
                      class="component-action-link"
                      type="button"
                      ?disabled=${structureLocked}
                      title=${structureLocked ? lockedTitle : ''}
                      @click=${() => this.onToggleComponent(component.id, !component.enabled)}
                    >
                      ${component.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      class="component-action-link component-action-link--danger"
                      type="button"
                      ?disabled=${structureLocked}
                      title=${structureLocked ? lockedTitle : ''}
                      @click=${() => this.onRemoveComponent(component.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                ${this.renderComponentProperties(component)}
              </div>
            `
          )}
          ${components.length === 0
            ? html`<div class="no-scripts">No components attached</div>`
            : ''}
        </div>
      </div>
    `;
  }

  private renderComponentProperties(component: ScriptComponent) {
    const schema = this.scriptRegistry.getComponentPropertySchema(component.type);
    if (!schema || schema.properties.length === 0) {
      return html`<div class="script-props-empty">No editable properties</div>`;
    }

    const groupedProps = getPropertiesByGroup(schema);
    const sortedGroups = Array.from(groupedProps.entries()).sort(([groupA], [groupB]) =>
      groupA.localeCompare(groupB)
    );

    return html`
      <div class="script-props">
        ${sortedGroups.map(([groupName, props]) => {
          const groupDef = schema.groups?.[groupName];
          const label = groupDef?.label ?? groupName;
          const visibleProps = props.filter(prop => !prop.ui?.hidden);
          if (visibleProps.length === 0) {
            return '';
          }
          return html`
            <div class="script-prop-group">
              <div class="script-prop-group-title">${label}</div>
              ${visibleProps.map(prop => this.renderComponentPropertyInput(component, prop))}
            </div>
          `;
        })}
      </div>
    `;
  }

  private getComponentIconName(componentType: string): string {
    if (componentType.startsWith('user:')) {
      return 'code';
    }
    return 'zap';
  }

  private async onAddBehavior() {
    if (!this.primaryNode) return;

    const component = await this.behaviorPickerService.showPicker();
    if (component) {
      const componentId = `${component.id}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const command = new AddComponentCommand({
        nodeId: this.primaryNode.nodeId,
        componentType: component.id,
        componentId,
      });
      void this.commandDispatcher.execute(command);
    }
  }

  private onRemoveComponent(componentId: string) {
    if (!this.primaryNode) return;

    const command = new RemoveComponentCommand({
      nodeId: this.primaryNode.nodeId,
      componentId,
    });
    void this.commandDispatcher.execute(command);
  }

  private onToggleComponent(componentId: string, enabled: boolean) {
    if (!this.primaryNode) return;

    const command = new ToggleScriptEnabledCommand({
      nodeId: this.primaryNode.nodeId,
      componentId,
      enabled,
    });
    void this.commandDispatcher.execute(command);
  }

  private renderEffectsSection() {
    const node = this.primaryNode;
    if (!(node instanceof GeometryMesh)) return '';

    const effects = node.getAttachedEffects();
    // Effect attach/remove/toggle on a prefab instance is not serialized as an
    // override, so lock the structural actions (mirrors the components section).
    const structureLocked = isPrefabNode(node);
    const lockedTitle = 'Managed by the prefab — open the prefab to edit its effects';
    const groupedProps = this.propertySchema
      ? getPropertiesByGroup(this.propertySchema)
      : new Map<string, PropertyDefinition[]>();

    return html`
      <div class="property-group-section scripts-section">
        <div class="group-header">
          <h4 class="group-title">Effects</h4>
          <div class="group-actions">
            <button
              class="btn-add-behavior"
              @click=${() => this.onAddEffect()}
              ?disabled=${structureLocked}
              title=${structureLocked ? lockedTitle : 'Add Effect'}
            >
              ${this.iconService.getIcon('plus', 14)}
              <span>Add</span>
            </button>
          </div>
        </div>

        <div class="scripts-list">
          ${effects.map(effect => {
            const group = `Effect: ${effect.info.displayName}`;
            const params = (groupedProps.get(group) ?? []).filter(
              p => p.name !== `fx.${effect.info.key}.enabled` && !p.ui?.hidden
            );
            return html`
              <div class="component-block ${effect.enabled ? '' : 'component-block--disabled'}">
                <div class="script-item component-item">
                  <div class="script-icon">${this.iconService.getIcon('zap', 16)}</div>
                  <div class="script-info">
                    <div class="script-name">${effect.info.displayName}</div>
                  </div>
                  <div class="script-actions">
                    <button
                      class="component-action-link"
                      type="button"
                      ?disabled=${structureLocked}
                      title=${structureLocked ? lockedTitle : ''}
                      @click=${() => this.onToggleEffect(effect.type, !effect.enabled)}
                    >
                      ${effect.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      class="component-action-link component-action-link--danger"
                      type="button"
                      ?disabled=${structureLocked}
                      title=${structureLocked ? lockedTitle : ''}
                      @click=${() => this.onRemoveEffect(effect.type)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                ${params.length > 0
                  ? html`<div class="script-props">
                      ${params.map(p => this.renderPropertyInput(p))}
                    </div>`
                  : html`<div class="script-props-empty">No editable properties</div>`}
              </div>
            `;
          })}
          ${effects.length === 0 ? html`<div class="no-scripts">No effects attached</div>` : ''}
        </div>
      </div>
    `;
  }

  private async onAddEffect() {
    const node = this.primaryNode;
    if (!(node instanceof GeometryMesh)) return;
    const exclude = node.getAttachedEffects().map(e => e.type);
    const effectType = await this.effectPickerService.showPicker(exclude);
    if (effectType) {
      void this.commandDispatcher.execute(
        new AddEffectCommand({ nodeId: node.nodeId, effectType })
      );
    }
  }

  private onRemoveEffect(effectType: string) {
    if (!this.primaryNode) return;
    void this.commandDispatcher.execute(
      new RemoveEffectCommand({ nodeId: this.primaryNode.nodeId, effectType })
    );
  }

  private onToggleEffect(effectType: string, enabled: boolean) {
    const node = this.primaryNode;
    if (!(node instanceof GeometryMesh)) return;
    const effect = node.getAttachedEffects().find(e => e.type === effectType);
    if (!effect) return;
    void this.applyPropertyChange(`fx.${effect.info.key}.enabled`, enabled);
  }

  private renderPropertyGroup(groupName: string, props: PropertyDefinition[]) {
    const groupDef = this.propertySchema?.groups?.[groupName];
    const label = groupDef?.label || groupName;

    const visibleProps = props.filter(p => !p.ui?.hidden);

    if (visibleProps.length === 0) {
      return '';
    }

    if (groupName === 'Transform') {
      return this.renderTransformGroup(label, visibleProps);
    }

    if (groupName === 'Anchor' && this.primaryNode instanceof Node2D) {
      return this.renderAnchorGroup('Align', visibleProps);
    }

    if (groupName === 'Size') {
      return this.renderSizeGroup(label, visibleProps);
    }

    return this.renderPropertySection(
      label,
      visibleProps.map(prop => this.renderPropertyInput(prop)),
      {
        hideTitle: groupName === 'Style' && visibleProps.length === 1,
      }
    );
  }

  private renderAnchorGroup(label: string, _props: PropertyDefinition[]) {
    if (!this.primaryNode || !(this.primaryNode instanceof Node2D)) {
      return '';
    }

    const enabled =
      this.propertyValues['layoutEnabled']?.value === 'true' || this.primaryNode.layoutEnabled;
    // Play mode is a read-only live mirror — gate the anchor toggle/edges/mode
    // buttons so they can't silently mutate the authored node during play.
    const readOnly = appState.collaboration.isReadOnly || appState.ui.isPlaying;
    const horizontal =
      this.propertyValues['horizontalAlign']?.value ?? this.primaryNode.horizontalAlign;
    const vertical = this.propertyValues['verticalAlign']?.value ?? this.primaryNode.verticalAlign;
    const previewClass = `anchor-preview anchor-preview--h-${horizontal} anchor-preview--v-${vertical}`;

    return this.renderPropertySection(
      label,
      html`
        <div class="anchor-section-header">
          <h4 class="group-title">${label}</h4>
          <button
            class=${`anchor-toggle-button ${enabled ? 'is-active' : ''}`}
            type="button"
            title=${enabled ? 'Disable anchor layout' : 'Enable anchor layout'}
            aria-label=${enabled ? 'Disable anchor layout' : 'Enable anchor layout'}
            ?disabled=${readOnly}
            @click=${() => this.applyPropertyChange('layoutEnabled', !enabled)}
          >
            ${this.iconService.getIcon('anchor', 14)}
            <span>${enabled ? 'Enabled' : 'Disabled'}</span>
          </button>
        </div>
        ${enabled
          ? html`
              <div class="anchor-visual-editor">
                <div class="anchor-preview-shell">
                  <div class="anchor-preview-frame">
                    <div class=${previewClass}></div>
                    ${this.renderAnchorPreviewEdge('left', horizontal, vertical, readOnly)}
                    ${this.renderAnchorPreviewEdge('right', horizontal, vertical, readOnly)}
                    ${this.renderAnchorPreviewEdge('top', horizontal, vertical, readOnly)}
                    ${this.renderAnchorPreviewEdge('bottom', horizontal, vertical, readOnly)}
                    ${this.renderAnchorPreviewEdge('center', horizontal, vertical, readOnly)}
                  </div>
                </div>
                <div class="anchor-controls">
                  <div class="anchor-control-row">
                    <span class="anchor-axis-label">H</span>
                    <div class="anchor-mode-group">
                      ${['left', 'center', 'right', 'stretch'].map(option =>
                        this.renderAnchorModeButton(
                          'horizontal',
                          option,
                          horizontal,
                          enabled,
                          readOnly
                        )
                      )}
                    </div>
                  </div>
                  <div class="anchor-control-row">
                    <span class="anchor-axis-label">V</span>
                    <div class="anchor-mode-group">
                      ${['top', 'center', 'bottom', 'stretch'].map(option =>
                        this.renderAnchorModeButton('vertical', option, vertical, enabled, readOnly)
                      )}
                    </div>
                  </div>
                </div>
              </div>
            `
          : ''}
      `,
      {
        className: 'anchor-section anchor-section--visual',
        hideTitle: true,
      }
    );
  }

  private renderTransformGroup(label: string, props: PropertyDefinition[]) {
    if (!this.primaryNode) {
      return '';
    }

    return this.renderPropertySection(
      label,
      props.map(prop => this.renderTransformProperty(prop)),
      {
        className: 'transform-section',
      }
    );
  }

  private renderTransformProperty(prop: PropertyDefinition) {
    if (this.primaryNode instanceof Node2D && prop.name === 'rotation' && prop.type === 'number') {
      const state = this.propertyValues[prop.name];
      if (!state) {
        return '';
      }

      const label = prop.ui?.label || prop.name;
      const readOnly = this.isPropertyReadOnly(prop.ui?.readOnly, this.primaryNode);
      const isOverridden = this.isPropertyOverriddenForPrimaryNode(prop);

      return html`
        <div class="property-group property-group--transform-single-axis">
          ${this.renderPropertyLabel(
            prop,
            `${label}${prop.ui?.unit ? ` (${prop.ui.unit})` : ''}`,
            isOverridden
          )}
          <div class="transform-single-axis-editor">
            <span class="transform-single-axis-label transform-single-axis-label--z">Z</span>
            <input
              type="number"
              step=${prop.ui?.step ?? 0.01}
              class="property-input property-input--number ${state.isValid
                ? ''
                : 'property-input--invalid'}"
              .value=${state.value}
              ?disabled=${readOnly}
              @input=${(e: Event) => this.handlePropertyInput(prop.name, e)}
              @blur=${(e: Event) => this.handlePropertyBlur(prop.name, e)}
            />
          </div>
        </div>
      `;
    }

    return this.renderPropertyInput(prop);
  }

  private renderSizeGroup(label: string, props: PropertyDefinition[]) {
    if (!this.primaryNode) {
      return '';
    }

    const widthProp = props.find(p => p.name === 'width');
    const heightProp = props.find(p => p.name === 'height');
    const remainingProps = props.filter(p => p.name !== 'width' && p.name !== 'height');

    if (!widthProp || !heightProp) {
      return this.renderPropertySection(
        label,
        props.map(prop => this.renderPropertyInput(prop))
      );
    }

    const widthState = this.propertyValues[widthProp.name];
    const heightState = this.propertyValues[heightProp.name];
    const readOnly = this.isPropertyReadOnly(widthProp.ui?.readOnly, this.primaryNode);

    const width = widthState ? parseFloat(widthState.value) : 64;
    const height = heightState ? parseFloat(heightState.value) : 64;

    if (!(this.primaryNode instanceof Sprite2D)) {
      return this.renderPropertySection(
        label,
        props.map(prop => this.renderPropertyInput(prop))
      );
    }

    const node = this.primaryNode;
    const aspectRatioLocked = node.aspectRatioLocked;
    const textureAspectRatio = node.textureAspectRatio;
    const originalWidth = node.originalWidth;
    const originalHeight = node.originalHeight;
    const hasOriginalRatio = textureAspectRatio !== null && textureAspectRatio > 0;
    const hasOriginalSize =
      typeof originalWidth === 'number' &&
      originalWidth > 0 &&
      typeof originalHeight === 'number' &&
      originalHeight > 0;

    const handleWidthChange = (newWidth: number) => {
      if (!Number.isFinite(newWidth) || newWidth <= 0) {
        return;
      }
      if (aspectRatioLocked && hasOriginalRatio) {
        const newHeight = newWidth / textureAspectRatio!;
        void this.applySpriteSizeChange(newWidth, newHeight, aspectRatioLocked);
      } else {
        void this.applySpriteSizeChange(newWidth, height, aspectRatioLocked);
      }
    };

    const handleHeightChange = (newHeight: number) => {
      if (!Number.isFinite(newHeight) || newHeight <= 0) {
        return;
      }
      if (aspectRatioLocked && hasOriginalRatio) {
        const newWidth = newHeight * textureAspectRatio!;
        void this.applySpriteSizeChange(newWidth, newHeight, aspectRatioLocked);
      } else {
        void this.applySpriteSizeChange(width, newHeight, aspectRatioLocked);
      }
    };

    const handleResetToOriginal = () => {
      if (hasOriginalSize) {
        void this.applySpriteSizeChange(originalWidth, originalHeight, aspectRatioLocked);
      }
    };

    const handleToggleAspectRatio = () => {
      const newLocked = !aspectRatioLocked;
      void this.applyPropertyChange('aspectRatioLocked', newLocked);
    };

    return this.renderPropertySection(
      label,
      html`
        <div class="property-group property-group--size-inline">
          ${this.renderPropertyLabel(
            widthProp,
            'Size',
            this.isPropertyOverriddenForPrimaryNode(widthProp)
          )}
          <div class="size-inline-editor">
            <label class="size-inline-field">
              <span class="size-inline-axis">W</span>
              <input
                type="number"
                class="property-input property-input--number size-inline-input"
                step=${widthProp.ui?.step ?? 1}
                .value=${width.toFixed(widthProp.ui?.precision ?? 0)}
                ?disabled=${readOnly}
                @change=${(e: Event) =>
                  handleWidthChange(parseFloat((e.target as HTMLInputElement).value))}
              />
            </label>
            <label class="size-inline-field">
              <span class="size-inline-axis">H</span>
              <input
                type="number"
                class="property-input property-input--number size-inline-input"
                step=${heightProp.ui?.step ?? 1}
                .value=${height.toFixed(heightProp.ui?.precision ?? 0)}
                ?disabled=${readOnly}
                @change=${(e: Event) =>
                  handleHeightChange(parseFloat((e.target as HTMLInputElement).value))}
              />
            </label>
            ${widthProp.ui?.unit || heightProp.ui?.unit
              ? html`
                  <span class="size-inline-unit">${widthProp.ui?.unit ?? heightProp.ui?.unit}</span>
                `
              : ''}
            ${hasOriginalRatio
              ? html`
                  <button
                    class="size-lock-button ${aspectRatioLocked ? 'locked' : ''}"
                    type="button"
                    title=${aspectRatioLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                    @click=${handleToggleAspectRatio}
                  >
                    ${this.iconService.getIcon(aspectRatioLocked ? 'lock' : 'unlock', 14)}
                  </button>
                `
              : ''}
            ${hasOriginalSize
              ? html`
                  <button
                    class="size-reset-button"
                    type="button"
                    title=${`Reset to original texture size (${originalWidth} x ${originalHeight})`}
                    @click=${handleResetToOriginal}
                  >
                    ${this.iconService.getIcon('refresh-cw', 14)}
                  </button>
                `
              : ''}
          </div>
        </div>
        ${remainingProps.map(prop => this.renderPropertyInput(prop))}
      `,
      {
        className: 'size-section',
        hideTitle: true,
      }
    );
  }

  private getSelectOptions(prop: PropertyDefinition): SelectOption[] {
    const options = prop.ui?.options;
    if (!options) {
      return [];
    }

    if (Array.isArray(options)) {
      return options.map(option => ({
        value: String(option),
        label: String(option),
      }));
    }

    if (typeof options === 'object') {
      return Object.entries(options).map(([label, value]) => ({
        label,
        value: String(value),
      }));
    }

    return [];
  }

  private isPropertyReadOnly(
    readOnly: ReadOnlyValue,
    target: NodeBase | ScriptComponent | null | undefined
  ): boolean {
    // Play mode shows a read-only LIVE mirror of the running game; editing the
    // authored node mid-play (two-way edit) is out of scope for Phase 0.
    if (appState.collaboration.isReadOnly || appState.ui.isPlaying) {
      return true;
    }

    if (typeof readOnly === 'function') {
      return Boolean(target ? readOnly(target) : false);
    }

    return Boolean(readOnly);
  }

  private renderComponentPropertyInput(component: ScriptComponent, prop: PropertyDefinition) {
    const key = this.getComponentPropertyKey(component.id, prop.name);
    const state = this.componentPropertyValues[key];
    if (!state) {
      return '';
    }

    const label = prop.ui?.label || prop.name;
    // Component config on a prefab instance node is not serialized as an
    // override, so edits would be silently lost on save. Render the editors
    // read-only for every instance node (matching the disabled Add/Remove/Toggle
    // actions); the value can be changed by opening the prefab itself.
    const readOnly =
      this.isPropertyReadOnly(prop.ui?.readOnly, component) ||
      (this.primaryNode ? isPrefabNode(this.primaryNode) : false);

    if (prop.type === 'string' && prop.ui?.editor === 'audio-resource') {
      const audioPreview = this.getAudioPreview(state.value);
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <pix3-audio-resource-editor
            .resourceUrl=${state.value}
            .previewUrl=${audioPreview.previewUrl}
            .waveformUrl=${audioPreview.waveformUrl}
            .durationSeconds=${audioPreview.durationSeconds ?? 0}
            .channelCount=${audioPreview.channelCount ?? 0}
            .sampleRate=${audioPreview.sampleRate ?? 0}
            .fileSize=${audioPreview.size}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.applyComponentPropertyChange(component.id, prop, event.detail.url.trim())}
            @audio-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.onComponentAudioResourceDrop(component.id, prop, event.detail.event)}
          ></pix3-audio-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'string' && prop.ui?.editor === 'model-resource') {
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <pix3-model-resource-editor
            .resourceUrl=${state.value}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.applyComponentPropertyChange(component.id, prop, event.detail.url.trim())}
            @model-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.onComponentModelResourceDrop(component.id, prop, event.detail.event)}
          ></pix3-model-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'boolean') {
      return html`
        <div class="property-group property-group--checkbox component-property-group">
          <label class="property-label property-label--checkbox">
            <input
              type="checkbox"
              class="property-checkbox"
              .checked=${state.value === 'true'}
              ?disabled=${readOnly}
              @change=${(e: Event) =>
                this.applyComponentPropertyChange(
                  component.id,
                  prop,
                  (e.target as HTMLInputElement).checked
                )}
            />
            <span class="property-label-text">${label}</span>
          </label>
        </div>
      `;
    }

    if (prop.type === 'vector2') {
      let value = { x: 0, y: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse vector2 component value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <pix3-vector2-editor
            .x=${value.x}
            .y=${value.y}
            step=${prop.ui?.step ?? 0.01}
            precision=${prop.ui?.precision ?? 2}
            ?disabled=${readOnly}
            @change=${(e: CustomEvent) =>
              this.applyComponentPropertyChange(component.id, prop, e.detail)}
          ></pix3-vector2-editor>
        </div>
      `;
    }

    if (prop.type === 'vector3') {
      let value = { x: 0, y: 0, z: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse vector3 component value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <pix3-vector3-editor
            .x=${value.x}
            .y=${value.y}
            .z=${value.z}
            step=${prop.ui?.step ?? 0.01}
            precision=${prop.ui?.precision ?? 2}
            ?disabled=${readOnly}
            @change=${(e: CustomEvent) =>
              this.applyComponentPropertyChange(component.id, prop, e.detail)}
          ></pix3-vector3-editor>
        </div>
      `;
    }

    if (prop.type === 'euler') {
      let value = { x: 0, y: 0, z: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse euler component value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <pix3-euler-editor
            .x=${value.x}
            .y=${value.y}
            .z=${value.z}
            step=${prop.ui?.step ?? 0.1}
            precision=${prop.ui?.precision ?? 1}
            ?disabled=${readOnly}
            @change=${(e: CustomEvent) =>
              this.applyComponentPropertyChange(component.id, prop, e.detail)}
          ></pix3-euler-editor>
        </div>
      `;
    }

    if (prop.type === 'node') {
      const activeScene = this.sceneManager.getActiveSceneGraph();
      if (!activeScene) {
        return html`<div class="property-group component-property-group">
          <span class="property-label">${label}</span
          ><span class="error-text">No active scene</span>
        </div>`;
      }

      const allowedTypes = prop.ui?.nodeTypes;
      const nodes = Array.from(activeScene.nodeMap.values()).filter(n => {
        if (!allowedTypes || allowedTypes.length === 0) return true;
        return allowedTypes.includes(n.type);
      });

      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <select
            class="property-select"
            ?disabled=${readOnly}
            @change=${(e: Event) =>
              this.applyComponentPropertyChange(
                component.id,
                prop,
                (e.target as HTMLSelectElement).value
              )}
          >
            <option value="" ?selected=${!state.value}>[None]</option>
            ${nodes.map(
              n =>
                html`<option value=${n.nodeId} ?selected=${n.nodeId === state.value}>
                  ${n.name} (${n.type})
                </option>`
            )}
          </select>
        </div>
      `;
    }

    if (prop.type === 'select' || prop.type === 'enum') {
      const options = this.getSelectOptions(prop);
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <select
            class="property-select"
            ?disabled=${readOnly}
            @change=${(e: Event) =>
              this.applyComponentPropertyChange(
                component.id,
                prop,
                (e.target as HTMLSelectElement).value
              )}
          >
            ${options.map(
              option =>
                html`<option value=${option.value} ?selected=${option.value === state.value}>
                  ${option.label}
                </option>`
            )}
          </select>
        </div>
      `;
    }

    if (prop.type === 'number') {
      const hasSlider =
        prop.ui?.slider === true &&
        typeof prop.ui?.min === 'number' &&
        typeof prop.ui?.max === 'number' &&
        Number.isFinite(prop.ui.min) &&
        Number.isFinite(prop.ui.max);

      if (hasSlider) {
        const numericValue = Number.parseFloat(state.value);
        const safeValue = Number.isFinite(numericValue) ? numericValue : Number(prop.ui?.min);

        return html`
          <div class="property-group component-property-group">
            <span class="property-label">${label}${prop.ui?.unit ? ` (${prop.ui.unit})` : ''}</span>
            <pix3-slider-number-editor
              .value=${safeValue}
              .min=${Number(prop.ui?.min)}
              .max=${Number(prop.ui?.max)}
              .step=${prop.ui?.step ?? 0.01}
              .precision=${prop.ui?.precision ?? 2}
              ?disabled=${readOnly}
              @preview-change=${(e: CustomEvent<{ value: number }>) =>
                this.handleComponentSliderPreview(component.id, prop, e.detail.value)}
              @commit-change=${(e: CustomEvent<{ value: number }>) =>
                this.handleComponentSliderCommit(component.id, prop, e.detail.value)}
            ></pix3-slider-number-editor>
          </div>
        `;
      }

      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}${prop.ui?.unit ? ` (${prop.ui.unit})` : ''}</span>
          <input
            type="number"
            step=${prop.ui?.step ?? 0.01}
            class="property-input property-input--number ${state.isValid
              ? ''
              : 'property-input--invalid'}"
            .value=${state.value}
            ?disabled=${readOnly}
            @input=${(e: Event) => this.handleComponentPropertyInput(component.id, prop, e)}
            @blur=${(e: Event) => this.handleComponentPropertyBlur(component.id, prop, e)}
          />
        </div>
      `;
    }

    if (prop.type === 'color') {
      const pickerValue = this.getColorPickerValue(state.value);

      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <div class="property-color-editor">
            <input
              type="color"
              class="property-color-picker"
              .value=${pickerValue}
              ?disabled=${readOnly}
              @input=${(e: Event) =>
                this.handleComponentColorPickerInput(
                  component.id,
                  prop,
                  (e.target as HTMLInputElement).value
                )}
              @change=${async (e: Event) => {
                const input = e.target as HTMLInputElement;
                await this.handleComponentColorPickerCommit(component.id, prop, input.value);
                input.blur();
              }}
            />
            <input
              type="text"
              maxlength="9"
              class="property-input property-input--text property-input--color-text ${state.isValid
                ? ''
                : 'property-input--invalid'}"
              .value=${state.value}
              ?disabled=${readOnly}
              @input=${(e: Event) => this.handleComponentPropertyInput(component.id, prop, e)}
              @blur=${(e: Event) => this.handleComponentPropertyBlur(component.id, prop, e)}
            />
          </div>
        </div>
      `;
    }

    return html`
      <div class="property-group component-property-group">
        <span class="property-label">${label}</span>
        <input
          type="text"
          class="property-input property-input--text"
          .value=${state.value}
          ?disabled=${readOnly}
          @input=${(e: Event) => this.handleComponentPropertyInput(component.id, prop, e)}
          @blur=${(e: Event) => this.handleComponentPropertyBlur(component.id, prop, e)}
        />
      </div>
    `;
  }

  private renderPropertyInput(prop: PropertyDefinition) {
    if (!this.primaryNode || !this.propertyValues[prop.name]) {
      return '';
    }

    const state = this.propertyValues[prop.name];
    const label = prop.ui?.label || prop.name;
    const readOnly = this.isPropertyReadOnly(prop.ui?.readOnly, this.primaryNode);
    const isOverridden = this.isPropertyOverriddenForPrimaryNode(prop);
    const labelTemplate = this.renderPropertyLabel(prop, label, isOverridden);

    if (prop.type === 'object' && prop.ui?.editor === 'texture-resource') {
      const textureValue = this.toTextureResourceValue(state.value);
      const previewUrl = this.getTexturePreviewUrl(textureValue.url);
      const metadata = this.texturePreviewMetadata.get(textureValue.url.trim());

      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-texture-resource-editor
            .resourceUrl=${textureValue.url}
            .previewUrl=${previewUrl}
            .originalWidth=${metadata?.width ?? 0}
            .originalHeight=${metadata?.height ?? 0}
            .fileSize=${metadata?.size ?? 0}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.applyPropertyChange(prop.name, {
                type: 'texture',
                url: event.detail.url.trim(),
              })}
            @texture-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.onTextureResourceDrop(prop.name, event.detail.event)}
          ></pix3-texture-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'string' && prop.ui?.editor === 'audio-resource') {
      const audioPreview = this.getAudioPreview(state.value);
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-audio-resource-editor
            .resourceUrl=${state.value}
            .previewUrl=${audioPreview.previewUrl}
            .waveformUrl=${audioPreview.waveformUrl}
            .durationSeconds=${audioPreview.durationSeconds ?? 0}
            .channelCount=${audioPreview.channelCount ?? 0}
            .sampleRate=${audioPreview.sampleRate ?? 0}
            .fileSize=${audioPreview.size}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.applyPropertyChange(prop.name, event.detail.url.trim())}
            @audio-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.onAudioResourceDrop(prop.name, event.detail.event)}
          ></pix3-audio-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'string' && prop.ui?.editor === 'model-resource') {
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-model-resource-editor
            .resourceUrl=${state.value}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.applyPropertyChange(prop.name, event.detail.url.trim())}
            @model-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.onModelResourceDrop(prop.name, event.detail.event)}
          ></pix3-model-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'string' && prop.ui?.editor === 'animation-resource') {
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-animation-resource-editor
            .resourceUrl=${state.value}
            .showCreateButton=${this.canCreateAnimationResource(prop.name, state.value, readOnly)}
            .isCreating=${this.creatingAnimationPropertyName === prop.name}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.applyPropertyChange(prop.name, event.detail.url.trim())}
            @animation-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.onAnimationResourceDrop(prop.name, event.detail.event)}
            @open-request=${(event: CustomEvent<{ url: string }>) =>
              this.onOpenAnimationResource(event.detail.url)}
            @create-request=${() => this.onCreateAnimationResource(prop.name)}
          ></pix3-animation-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'boolean') {
      return html`
        <div class="property-group property-group--checkbox">
          <label class="property-label property-label--checkbox">
            <input
              type="checkbox"
              class="property-checkbox"
              .checked=${state.value === 'true'}
              ?disabled=${readOnly}
              @change=${(e: Event) =>
                this.applyPropertyChange(prop.name, (e.target as HTMLInputElement).checked)}
            />
            <span class=${`property-label-text ${isOverridden ? 'property-label--overridden' : ''}`}
              >${label}</span
            >
            ${isOverridden
              ? html`
                  <button
                    class="property-revert-button"
                    type="button"
                    title="Revert prefab override"
                    @click=${(e: Event) => this.onRevertPropertyClick(e, prop)}
                  >
                    ↺
                  </button>
                `
              : null}
          </label>
        </div>
      `;
    }

    if (prop.type === 'vector2') {
      let value = { x: 0, y: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse vector2 value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-vector2-editor
            .x=${value.x}
            .y=${value.y}
            step=${prop.ui?.step ?? 0.01}
            precision=${prop.ui?.precision ?? 2}
            ?disabled=${readOnly}
            @change=${(e: CustomEvent) => this.applyPropertyChange(prop.name, e.detail)}
          ></pix3-vector2-editor>
        </div>
      `;
    }

    if (prop.type === 'vector3') {
      let value = { x: 0, y: 0, z: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse vector3 value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-vector3-editor
            .x=${value.x}
            .y=${value.y}
            .z=${value.z}
            step=${prop.ui?.step ?? 0.01}
            precision=${prop.ui?.precision ?? 2}
            ?disabled=${readOnly}
            @change=${(e: CustomEvent) => this.applyPropertyChange(prop.name, e.detail)}
          ></pix3-vector3-editor>
        </div>
      `;
    }

    if (prop.type === 'euler') {
      let value = { x: 0, y: 0, z: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse euler value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-euler-editor
            .x=${value.x}
            .y=${value.y}
            .z=${value.z}
            step=${prop.ui?.step ?? 0.1}
            precision=${prop.ui?.precision ?? 1}
            ?disabled=${readOnly}
            @change=${(e: CustomEvent) => this.applyPropertyChange(prop.name, e.detail)}
          ></pix3-euler-editor>
        </div>
      `;
    }

    if (prop.type === 'number' && prop.ui?.editor === 'sprite-size') {
      // Only render size editor for width property to avoid duplicates
      if (prop.name !== 'width') {
        return '';
      }

      // Handle sprite size editor (combines width and height)
      const heightState = this.propertyValues['height'];
      const widthVal = Number.parseFloat(state.value);
      const heightVal = Number.parseFloat(heightState?.value ?? '64');

      const node = this.primaryNode instanceof Sprite2D ? this.primaryNode : null;
      const originalWidth = node?.originalWidth ?? null;
      const originalHeight = node?.originalHeight ?? null;
      const aspectRatioLocked = node?.aspectRatioLocked ?? false;
      const hasOriginalSize = Boolean(
        typeof originalWidth === 'number' &&
          originalWidth > 0 &&
          typeof originalHeight === 'number' &&
          originalHeight > 0
      );

      return html`
        <div class="property-group">
          ${this.renderPropertyLabel(prop, 'Size', isOverridden)}
          <pix3-size-editor
            .width=${Number.isFinite(widthVal) && widthVal > 0 ? widthVal : 64}
            .height=${Number.isFinite(heightVal) && heightVal > 0 ? heightVal : 64}
            .aspectRatioLocked=${aspectRatioLocked}
            .hasOriginalSize=${hasOriginalSize}
            .originalWidth=${originalWidth}
            .originalHeight=${originalHeight}
            ?disabled=${readOnly}
            @change=${(
              e: CustomEvent<{ width: number; height: number; aspectRatioLocked: boolean }>
            ) => {
              const { width, height, aspectRatioLocked } = e.detail;
              this.applySpriteSizeChange(width, height, aspectRatioLocked);
            }}
            @reset-size=${() => this.handleSizeReset()}
          ></pix3-size-editor>
        </div>
      `;
    }

    if (prop.type === 'node') {
      const activeScene = this.sceneManager.getActiveSceneGraph();
      if (!activeScene) {
        return html`<div class="property-group">
          <span class="property-label">${label}</span
          ><span class="error-text">No active scene</span>
        </div>`;
      }

      const allowedTypes = prop.ui?.nodeTypes;
      const nodes = Array.from(activeScene.nodeMap.values()).filter(n => {
        if (!allowedTypes || allowedTypes.length === 0) return true;
        return allowedTypes.includes(n.type);
      });

      return html`
        <div class="property-group">
          ${labelTemplate}
          <select
            class="property-select"
            ?disabled=${readOnly}
            @change=${(e: Event) =>
              this.applyPropertyChange(prop.name, (e.target as HTMLSelectElement).value)}
          >
            <option value="" ?selected=${!state.value}>[None]</option>
            ${nodes.map(
              n =>
                html`<option value=${n.nodeId} ?selected=${n.nodeId === state.value}>
                  ${n.name} (${n.type})
                </option>`
            )}
          </select>
        </div>
      `;
    }

    if (prop.type === 'select' || prop.type === 'enum') {
      const options = this.getSelectOptions(prop);
      return html`
        <div class="property-group">
          ${labelTemplate}
          <select
            class="property-select"
            ?disabled=${readOnly}
            @change=${(e: Event) =>
              this.applyPropertyChange(prop.name, (e.target as HTMLSelectElement).value)}
          >
            ${options.map(
              option =>
                html`<option value=${option.value} ?selected=${option.value === state.value}>
                  ${option.label}
                </option>`
            )}
          </select>
        </div>
      `;
    }

    if (prop.type === 'number') {
      if (prop.name === 'opacity') {
        const numericValue = Number.parseFloat(state.value);
        const safeValue = Number.isFinite(numericValue)
          ? Math.min(Math.max(numericValue, 0), 1)
          : 1;

        return html`
          <div class="property-group property-group--opacity">
            ${labelTemplate}
            <pix3-slider-number-editor
              .value=${safeValue * 100}
              .min=${0}
              .max=${100}
              .step=${1}
              .precision=${0}
              ?disabled=${readOnly}
              @preview-change=${(e: CustomEvent<{ value: number }>) =>
                this.handleSliderPreview(prop.name, e.detail.value / 100)}
              @commit-change=${(e: CustomEvent<{ value: number }>) =>
                this.handleSliderCommit(prop.name, e.detail.value / 100)}
            ></pix3-slider-number-editor>
          </div>
        `;
      }

      const hasSlider =
        prop.ui?.slider === true &&
        typeof prop.ui?.min === 'number' &&
        typeof prop.ui?.max === 'number' &&
        Number.isFinite(prop.ui.min) &&
        Number.isFinite(prop.ui.max);

      if (hasSlider) {
        const numericValue = Number.parseFloat(state.value);
        const safeValue = Number.isFinite(numericValue) ? numericValue : Number(prop.ui?.min);

        return html`
          <div class="property-group">
            ${this.renderPropertyLabel(
              prop,
              `${label}${prop.ui?.unit ? ` (${prop.ui.unit})` : ''}`,
              isOverridden
            )}
            <pix3-slider-number-editor
              .value=${safeValue}
              .min=${Number(prop.ui?.min)}
              .max=${Number(prop.ui?.max)}
              .step=${prop.ui?.step ?? 0.01}
              .precision=${prop.ui?.precision ?? 2}
              ?disabled=${readOnly}
              @preview-change=${(e: CustomEvent<{ value: number }>) =>
                this.handleSliderPreview(prop.name, e.detail.value)}
              @commit-change=${(e: CustomEvent<{ value: number }>) =>
                this.handleSliderCommit(prop.name, e.detail.value)}
            ></pix3-slider-number-editor>
          </div>
        `;
      }

      return html`
        <div class="property-group">
          ${this.renderPropertyLabel(
            prop,
            `${label}${prop.ui?.unit ? ` (${prop.ui.unit})` : ''}`,
            isOverridden
          )}
          <input
            type="number"
            step=${prop.ui?.step ?? 0.01}
            class="property-input property-input--number ${state.isValid
              ? ''
              : 'property-input--invalid'}"
            .value=${state.value}
            ?disabled=${readOnly}
            @input=${(e: Event) => this.handlePropertyInput(prop.name, e)}
            @blur=${(e: Event) => this.handlePropertyBlur(prop.name, e)}
          />
        </div>
      `;
    }

    if (prop.type === 'color') {
      const pickerValue = this.getColorPickerValue(state.value);

      return html`
        <div class="property-group">
          ${labelTemplate}
          <div class="property-color-editor">
            <input
              type="color"
              class="property-color-picker"
              .value=${pickerValue}
              ?disabled=${readOnly}
              @input=${(e: Event) =>
                this.handleColorPickerInput(prop.name, (e.target as HTMLInputElement).value)}
              @change=${async (e: Event) => {
                const input = e.target as HTMLInputElement;
                await this.handleColorPickerCommit(prop.name, input.value);
                input.blur();
              }}
            />
            <input
              type="text"
              maxlength="9"
              class="property-input property-input--text property-input--color-text ${state.isValid
                ? ''
                : 'property-input--invalid'}"
              .value=${state.value}
              ?disabled=${readOnly}
              @input=${(e: Event) => this.handlePropertyInput(prop.name, e)}
              @blur=${(e: Event) => this.handlePropertyBlur(prop.name, e)}
            />
          </div>
        </div>
      `;
    }

    if (prop.type === 'string') {
      return html`
        <div class="property-group">
          ${labelTemplate}
          <input
            type="text"
            class="property-input property-input--text"
            .value=${state.value}
            ?disabled=${readOnly}
            @input=${(e: Event) => this.handlePropertyInput(prop.name, e)}
            @blur=${(e: Event) => this.handlePropertyBlur(prop.name, e)}
          />
        </div>
      `;
    }

    // Default fallback for other types
    return html`
      <div class="property-group">
        ${labelTemplate}
        <input
          type="text"
          class="property-input property-input--text"
          .value=${state.value}
          ?disabled=${readOnly}
          @input=${(e: Event) => this.handlePropertyInput(prop.name, e)}
        />
      </div>
    `;
  }

  private renderAnchorModeButton(
    axis: 'horizontal' | 'vertical',
    option: string,
    currentValue: string,
    enabled: boolean,
    readOnly: boolean
  ) {
    const label =
      axis === 'horizontal'
        ? {
            left: 'L',
            center: 'C',
            right: 'R',
            stretch: 'S',
          }[option]
        : {
            top: 'T',
            center: 'C',
            bottom: 'B',
            stretch: 'S',
          }[option];

    return html`
      <button
        class="anchor-mode-button ${enabled && currentValue === option ? 'is-active' : ''}"
        type="button"
        ?disabled=${readOnly}
        title=${option}
        aria-label=${`${axis} ${option}`}
        @click=${() => this.applyAnchorMode(axis, option)}
      >
        ${this.renderAnchorModeIcon(axis, option, label)}
      </button>
    `;
  }

  private renderAnchorModeIcon(axis: 'horizontal' | 'vertical', option: string, fallback: string) {
    if (axis === 'horizontal') {
      switch (option) {
        case 'left':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2v10"></path>
            <rect x="3.5" y="4" width="6" height="6"></rect>
          </svg>`;
        case 'center':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M7 2v10"></path>
            <rect x="4" y="4" width="6" height="6"></rect>
          </svg>`;
        case 'right':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M12 2v10"></path>
            <rect x="4.5" y="4" width="6" height="6"></rect>
          </svg>`;
        case 'stretch':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2v10M12 2v10"></path>
            <rect x="3" y="4" width="8" height="6"></rect>
          </svg>`;
      }
    }

    if (axis === 'vertical') {
      switch (option) {
        case 'top':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2h10"></path>
            <rect x="4" y="3.5" width="6" height="6"></rect>
          </svg>`;
        case 'center':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 7h10"></path>
            <rect x="4" y="4" width="6" height="6"></rect>
          </svg>`;
        case 'bottom':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 12h10"></path>
            <rect x="4" y="4.5" width="6" height="6"></rect>
          </svg>`;
        case 'stretch':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2h10M2 12h10"></path>
            <rect x="4" y="3" width="6" height="8"></rect>
          </svg>`;
      }
    }

    return fallback;
  }

  private renderAnchorPreviewEdge(
    edge: 'left' | 'right' | 'top' | 'bottom' | 'center',
    horizontal: string,
    vertical: string,
    readOnly: boolean
  ) {
    const isActive =
      (edge === 'left' && horizontal === 'left') ||
      (edge === 'right' && horizontal === 'right') ||
      (edge === 'top' && vertical === 'top') ||
      (edge === 'bottom' && vertical === 'bottom') ||
      (edge === 'center' && horizontal === 'center' && vertical === 'center');

    return html`
      <button
        class="anchor-preview-edge anchor-preview-edge--${edge} ${isActive ? 'is-active' : ''}"
        type="button"
        ?disabled=${readOnly}
        title=${edge === 'center' ? 'Center both axes' : `Set ${edge} alignment`}
        @click=${() => this.applyAnchorPreviewEdge(edge)}
      ></button>
    `;
  }

  private async applyAnchorMode(axis: 'horizontal' | 'vertical', value: string): Promise<void> {
    if (!this.primaryNode || !(this.primaryNode instanceof Node2D)) {
      return;
    }

    if (
      !(this.propertyValues['layoutEnabled']?.value === 'true' || this.primaryNode.layoutEnabled)
    ) {
      await this.applyPropertyChange('layoutEnabled', true);
    }

    await this.applyPropertyChange(
      axis === 'horizontal' ? 'horizontalAlign' : 'verticalAlign',
      value
    );
  }

  private async applyAnchorPreviewEdge(
    edge: 'left' | 'right' | 'top' | 'bottom' | 'center'
  ): Promise<void> {
    if (edge === 'center') {
      await this.applyAnchorPreset({ horizontal: 'center', vertical: 'center' });
      return;
    }

    if (edge === 'left' || edge === 'right') {
      await this.applyAnchorMode('horizontal', edge);
      return;
    }

    await this.applyAnchorMode('vertical', edge);
  }

  private async applyAnchorPreset(preset: {
    horizontal?: 'left' | 'center' | 'right' | 'stretch';
    vertical?: 'top' | 'center' | 'bottom' | 'stretch';
  }): Promise<void> {
    if (!this.primaryNode || !(this.primaryNode instanceof Node2D)) {
      return;
    }

    if (
      !(this.propertyValues['layoutEnabled']?.value === 'true' || this.primaryNode.layoutEnabled)
    ) {
      await this.applyPropertyChange('layoutEnabled', true);
    }

    if (preset.horizontal) {
      await this.applyPropertyChange('horizontalAlign', preset.horizontal);
    }

    if (preset.vertical) {
      await this.applyPropertyChange('verticalAlign', preset.vertical);
    }
  }

  private renderPropertySection(
    label: string,
    content: unknown,
    options: PropertySectionOptions = {}
  ) {
    const classes = [
      'property-group-section',
      options.className,
      options.hideTitle ? 'property-group-section--titleless' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return html`
      <div class=${classes}>
        ${options.hideTitle ? '' : html`<h4 class="group-title">${label}</h4>`} ${content}
      </div>
    `;
  }

  private renderPropertyLabel(prop: PropertyDefinition, label: string, isOverridden: boolean) {
    return html`
      <span class="property-label ${isOverridden ? 'property-label--overridden' : ''}">
        ${label}
        ${isOverridden
          ? html`
              <button
                class="property-revert-button"
                type="button"
                title="Revert prefab override"
                @click=${(e: Event) => this.onRevertPropertyClick(e, prop)}
              >
                ↺
              </button>
            `
          : null}
      </span>
    `;
  }

  private onRevertPropertyClick(event: Event, prop: PropertyDefinition): void {
    event.stopPropagation();
    event.preventDefault();
    const baseValue = this.getPrefabBaseValueForProperty(prop);
    if (baseValue === undefined) {
      return;
    }
    void this.applyPropertyChange(prop.name, baseValue);
  }

  private isPropertyOverriddenForPrimaryNode(prop: PropertyDefinition): boolean {
    if (!this.primaryNode) {
      return false;
    }
    // Placement properties of an instance root (position/rotation/scale/name +
    // 2D anchors) are where-it-sits-in-the-scene, not prefab-content overrides.
    // Don't flag them or offer a Revert. See INSTANCE_PLACEMENT_PROPERTY_NAMES.
    if (isInstancePlacementProperty(this.primaryNode, prop.name)) {
      return false;
    }
    const baseValue = this.getPrefabBaseValueForProperty(prop);
    if (baseValue === undefined) {
      return false;
    }
    const currentValue = prop.getValue(this.primaryNode);
    return JSON.stringify(currentValue) !== JSON.stringify(baseValue);
  }

  private getPrefabBaseValueForProperty(prop: PropertyDefinition): unknown {
    if (!this.primaryNode) {
      return undefined;
    }

    const nodeMarker = getPrefabMetadata(this.primaryNode);
    if (!nodeMarker) {
      return undefined;
    }

    const instanceRoot = findPrefabInstanceRoot(this.primaryNode);
    if (!instanceRoot) {
      return undefined;
    }

    const rootMarker: PrefabMetadata | null = getPrefabMetadata(instanceRoot);
    const baseMap = rootMarker?.basePropertiesByLocalId;
    if (!baseMap) {
      return undefined;
    }

    const baseValue = baseMap[nodeMarker.effectiveLocalId]?.[prop.name];
    return baseValue === undefined ? undefined : JSON.parse(JSON.stringify(baseValue));
  }

  private async handleSizeReset() {
    if (!(this.primaryNode instanceof Sprite2D)) {
      return;
    }

    const originalWidth = this.primaryNode.originalWidth;
    const originalHeight = this.primaryNode.originalHeight;
    if (
      typeof originalWidth === 'number' &&
      originalWidth > 0 &&
      typeof originalHeight === 'number' &&
      originalHeight > 0
    ) {
      await this.applySpriteSizeChange(
        originalWidth,
        originalHeight,
        this.primaryNode.aspectRatioLocked
      );
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-inspector-panel': InspectorPanel;
  }
}
