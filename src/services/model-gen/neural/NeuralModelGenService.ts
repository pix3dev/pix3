import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { inject, injectable } from '@/fw/di';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { createCenteredPreviewRoot } from '@/services/assets/GltfBlobLoader';
import { ensureGlbExtension, normalizeModelPath } from '@/services/model-gen/Model3DExportService';
import {
  TripoModelProvider,
  type TripoGenerateInput,
} from '@/services/model-gen/neural/TripoModelProvider';

export type NeuralGenStatus =
  | 'idle'
  | 'uploading'
  | 'queued'
  | 'running'
  | 'downloading'
  | 'done'
  | 'error'
  | 'cancelled';

export interface NeuralGenState {
  status: NeuralGenStatus;
  /** 0–100 for the active phase (0 outside a run). */
  progress: number;
  /** The provider-reported stage label (e.g. 'uploading' | 'queued' | 'running' | 'downloading'). */
  stage: string;
  error: string | null;
  /** Bumps on every successful build so the panel can react to a fresh preview Group. */
  modelRevision: number;
  /** False while a run is in flight. */
  canGenerate: boolean;
  /** The Tripo task id of the last/current run, or null. */
  taskId: string | null;
}

const INITIAL_STATE: NeuralGenState = {
  status: 'idle',
  progress: 0,
  stage: '',
  error: null,
  modelRevision: 0,
  canGenerate: true,
  taskId: null,
};

/**
 * Orchestrator for the neural (Tripo3D) image→3D lane of the Model Lab — the counterpart to the
 * procedural {@link import('@/services/model-gen/Model3DGenService').Model3DGenService}. It drives
 * {@link TripoModelProvider} through upload → task → poll → download, maps progress onto an immutable
 * {@link NeuralGenState} exposed via {@link subscribe}, keeps the RAW downloaded GLB bytes (so a save
 * is lossless — no re-export), and parses a NEW centered preview `THREE.Group` each run.
 *
 * Ownership mirrors the procedural lane: this service builds a new Group per run and NEVER disposes a
 * Group it has handed out via {@link getModel} — the panel disposes what it holds.
 */
@injectable()
export class NeuralModelGenService {
  @inject(TripoModelProvider)
  private readonly provider!: TripoModelProvider;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  private state: NeuralGenState = INITIAL_STATE;
  private readonly listeners = new Set<(state: NeuralGenState) => void>();
  private abortController: AbortController | null = null;
  private currentModel: THREE.Group | undefined;
  private currentBlob: Blob | undefined;

  getState(): NeuralGenState {
    return this.state;
  }

  subscribe(listener: (state: NeuralGenState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** The latest loaded, centered preview Group, or undefined before the first successful build. */
  getModel(): THREE.Group | undefined {
    return this.currentModel;
  }

  /** The RAW downloaded GLB bytes of the latest build, for lossless saving. */
  getGlbBlob(): Blob | undefined {
    return this.currentBlob;
  }

  /**
   * Run one generation job end-to-end. Resolves on done / error / cancel (all reflected in
   * {@link NeuralGenState}, never thrown). A second call while a job runs is ignored. Requires a
   * configured Tripo3D key — without one it lands on `error` with a Settings-pointing message.
   */
  async generate(input: TripoGenerateInput): Promise<void> {
    if (this.abortController) {
      return;
    }
    if (!(await this.provider.hasKey())) {
      this.setState({
        status: 'error',
        progress: 0,
        stage: '',
        error: 'Add a Tripo3D API key in Settings.',
      });
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;
    const { signal } = controller;
    this.setState({
      status: 'uploading',
      progress: 0,
      stage: 'uploading',
      error: null,
      canGenerate: false,
      taskId: null,
    });

    try {
      const { glb, taskId } = await this.provider.generateGlb(input, {
        signal,
        onProgress: (progress, stage) => {
          this.setState({ status: mapStageToStatus(stage), progress, stage });
        },
      });
      this.setState({ taskId });

      const group = await this.buildPreview(glb);
      // Store the raw bytes + the new Group; never touch a previously handed-out Group.
      this.currentBlob = glb;
      this.currentModel = group;
      this.setState({
        status: 'done',
        progress: 100,
        stage: 'done',
        modelRevision: this.state.modelRevision + 1,
      });
    } catch (error) {
      if (this.isCancellation(error, signal)) {
        this.setState({ status: 'cancelled', stage: '' });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.setState({ status: 'error', stage: '', error: message });
      }
    } finally {
      this.abortController = null;
      this.setState({ canGenerate: true });
    }
  }

  /** Abort a running job (no-op when idle). */
  cancel(): void {
    this.abortController?.abort();
  }

  /** Return to a fresh idle state. Clears the model/blob references (does not dispose the Group). */
  reset(): void {
    this.cancel();
    this.currentModel = undefined;
    this.currentBlob = undefined;
    this.setState({
      status: 'idle',
      progress: 0,
      stage: '',
      error: null,
      taskId: null,
      canGenerate: true,
    });
  }

  /**
   * Write the RAW downloaded GLB bytes to `path` (project-relative or `res://…`), normalizing the
   * path, ensuring a `.glb` extension, and creating parent directories as needed. This saves the
   * bytes losslessly — it does NOT re-export the parsed Group.
   */
  async saveGlb(path: string): Promise<{ path: string; bytes: number }> {
    const blob = this.currentBlob;
    if (!blob) {
      throw new Error('There is no generated model to save.');
    }
    const relativePath = ensureGlbExtension(normalizeModelPath(path));
    if (!relativePath) {
      throw new Error('A file name is required.');
    }
    const buffer = await blob.arrayBuffer();
    await this.ensureParentDirectory(relativePath);
    await this.storage.writeBinaryFile(relativePath, buffer);
    return { path: relativePath, bytes: buffer.byteLength };
  }

  hasKey(): Promise<boolean> {
    return this.provider.hasKey();
  }

  setKey(value: string): Promise<void> {
    return this.provider.setKey(value);
  }

  clearKey(): Promise<void> {
    return this.provider.clearKey();
  }

  dispose(): void {
    this.cancel();
    this.listeners.clear();
    this.currentModel = undefined;
    this.currentBlob = undefined;
  }

  // -- internals -------------------------------------------------------------

  /** Parse the raw GLB bytes into a fresh centered preview Group. */
  private async buildPreview(glb: Blob): Promise<THREE.Group> {
    const arrayBuffer = await glb.arrayBuffer();
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(arrayBuffer, '');
    return createCenteredPreviewRoot(gltf.scene);
  }

  private async ensureParentDirectory(relativePath: string): Promise<void> {
    const segments = relativePath.split('/');
    segments.pop();
    let accumulated = '';
    for (const segment of segments) {
      if (!segment) {
        continue;
      }
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      try {
        await this.storage.createDirectory(accumulated);
      } catch {
        // directory likely already exists
      }
    }
  }

  private setState(patch: Partial<NeuralGenState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private isCancellation(error: unknown, signal: AbortSignal): boolean {
    return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
  }
}

/** Map a provider progress `stage` onto a {@link NeuralGenStatus}. */
function mapStageToStatus(stage: string): NeuralGenStatus {
  switch (stage) {
    case 'uploading':
      return 'uploading';
    case 'queued':
      return 'queued';
    case 'downloading':
      return 'downloading';
    case 'running':
    default:
      return 'running';
  }
}
