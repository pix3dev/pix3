import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { inject, injectable } from '@/fw/di';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { createCenteredPreviewRoot } from '@/services/assets/GltfBlobLoader';
import { ensureGlbExtension, normalizeModelPath } from '@/services/model-gen/Model3DExportService';
import { Model3DGenSettingsService } from '@/services/model-gen/Model3DGenSettingsService';
import { TripoModelProvider } from '@/services/model-gen/neural/TripoModelProvider';
import { StropheModel3DProvider } from '@/services/model-gen/neural/StropheModel3DProvider';
import type { Neural3DInput, Neural3DProvider } from '@/services/model-gen/neural/Neural3DProvider';

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
  /** The backend job id of the last/current run, or null. */
  taskId: string | null;
  /** Label of the backend the lane is currently configured to use (for UI copy). */
  providerLabel: string;
}

const INITIAL_STATE: NeuralGenState = {
  status: 'idle',
  progress: 0,
  stage: '',
  error: null,
  modelRevision: 0,
  canGenerate: true,
  taskId: null,
  providerLabel: '',
};

/**
 * Orchestrator for the neural image→3D lane of the Model Lab — the counterpart to the procedural
 * {@link import('@/services/model-gen/Model3DGenService').Model3DGenService}. It drives the
 * configured {@link Neural3DProvider} through upload → job → poll → download, maps progress onto an
 * immutable {@link NeuralGenState} exposed via {@link subscribe}, keeps the RAW downloaded GLB bytes
 * (so a save is lossless — no re-export), and parses a NEW centered preview `THREE.Group` each run.
 *
 * Two backends are available and chosen by the `neural3dProviderId` Model Lab preference: **Strophe**
 * (default — metered credits, no proxy required, so it also works in a production static build) and
 * **Tripo3D** direct (needs the `/tripo-proxy` + `/tripo-download` dev proxies, since Tripo sends no
 * CORS headers). The provider is resolved per call, so switching the preference takes effect on the
 * next run without a reload.
 *
 * Ownership mirrors the procedural lane: this service builds a new Group per run and NEVER disposes a
 * Group it has handed out via {@link getModel} — the panel disposes what it holds.
 */
@injectable()
export class NeuralModelGenService {
  @inject(TripoModelProvider)
  private readonly tripo!: TripoModelProvider;

  @inject(StropheModel3DProvider)
  private readonly strophe!: StropheModel3DProvider;

  @inject(Model3DGenSettingsService)
  private readonly settings!: Model3DGenSettingsService;

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
   * The backend this lane is configured to use. Resolved from preferences on every call so a settings
   * change applies immediately.
   */
  getProvider(): Neural3DProvider {
    const preferred = this.settings.getPreferences().neural3dProviderId;
    if (preferred === 'tripo') {
      return this.tripo;
    }
    this.strophe.setFamilyId(
      this.settings.getPreferences().neural3dFamilyId ?? this.strophe.getFamilyId()
    );
    return this.strophe;
  }

  /**
   * Run one generation job end-to-end. Resolves on done / error / cancel (all reflected in
   * {@link NeuralGenState}, never thrown). A second call while a job runs is ignored. Requires a key
   * for the configured backend — without one it lands on `error` with a Settings-pointing message.
   */
  async generate(input: Neural3DInput): Promise<void> {
    if (this.abortController) {
      return;
    }
    const provider = this.getProvider();
    if (!(await provider.hasKey())) {
      this.setState({
        status: 'error',
        progress: 0,
        stage: '',
        error: `Add a ${provider.label} API key in Settings.`,
        providerLabel: provider.label,
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
      providerLabel: provider.label,
    });

    try {
      const { glb, taskId } = await provider.generateGlb(input, {
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

  /** Whether the configured backend has a key. */
  hasKey(): Promise<boolean> {
    return this.getProvider().hasKey();
  }

  /** Store a key for the configured backend (each backend owns its own secret id). */
  setKey(value: string): Promise<void> {
    return this.getProvider().setKey(value);
  }

  clearKey(): Promise<void> {
    return this.getProvider().clearKey();
  }

  /** Label of the configured backend, for UI copy that names the service. */
  getProviderLabel(): string {
    return this.getProvider().label;
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
