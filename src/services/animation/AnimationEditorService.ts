import { injectable } from '@/fw/di';
import type {
  AnimationClip,
  AnimationFrame,
  AnimationPlaybackMode,
  AnimationResource,
} from '@pix3/runtime';

export interface AnimationInspectorSnapshot {
  readonly assetPath: string | null;
  readonly resource: AnimationResource | null;
  readonly clips: readonly AnimationClip[];
  readonly activeClip: AnimationClip | null;
  readonly activeClipName: string;
  readonly selectedFrame: AnimationFrame | null;
  readonly selectedFrameIndex: number;
}

export interface AnimationInspectorController {
  getInspectorSnapshot(): AnimationInspectorSnapshot;
  subscribeInspector(listener: () => void): () => void;
  updateTexturePath(value: string): Promise<void>;
  openTextureSlicer(): Promise<void>;
  selectClip(clipName: string): Promise<void>;
  addClip(): Promise<void>;
  removeClip(): Promise<void>;
  renameClip(nextName: string): Promise<void>;
  updateClipFps(nextFps: number): Promise<void>;
  updateClipPlaybackMode(mode: AnimationPlaybackMode): Promise<void>;
  updateClipLoop(nextLoop: boolean): Promise<void>;
  updateSelectedFrameDurationMultiplier(value: number): Promise<void>;
  updateSelectedFrameTexturePath(value: string): Promise<void>;
  updateSelectedFrameAnchor(axis: 'x' | 'y', value: number): Promise<void>;
  updateSelectedFrameBoundingBox(
    field: 'x' | 'y' | 'width' | 'height',
    value: number
  ): Promise<void>;
  addPolygonVertex(): Promise<void>;
  clearPolygon(): Promise<void>;
  resetBoundingBox(): Promise<void>;
}

export interface AnimationEditorContextSnapshot {
  readonly assetPath: string | null;
  readonly controller: AnimationInspectorController | null;
}

type AnimationEditorListener = (snapshot: AnimationEditorContextSnapshot) => void;

@injectable()
export class AnimationEditorService {
  private activeAssetPath: string | null = null;
  private activeController: AnimationInspectorController | null = null;
  private listeners = new Set<AnimationEditorListener>();

  getActiveAssetPath(): string | null {
    return this.activeAssetPath;
  }

  getActiveController(): AnimationInspectorController | null {
    return this.activeController;
  }

  getSnapshot(): AnimationEditorContextSnapshot {
    return {
      assetPath: this.activeAssetPath,
      controller: this.activeController,
    };
  }

  setActiveAssetPath(assetPath: string | null): void {
    const normalized = assetPath?.trim() || null;
    if (normalized === this.activeAssetPath) {
      return;
    }

    this.activeAssetPath = normalized;
    this.notifyListeners();
  }

  setActiveController(controller: AnimationInspectorController | null): void {
    if (controller === this.activeController) {
      return;
    }

    this.activeController = controller;
    this.notifyListeners();
  }

  subscribe(listener: AnimationEditorListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
    this.activeController = null;
    this.activeAssetPath = null;
  }

  private notifyListeners(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
