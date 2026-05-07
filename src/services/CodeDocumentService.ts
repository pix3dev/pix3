import { injectable, inject } from '@/fw/di';
import { DialogService } from '@/services/DialogService';
import { FileWatchService } from '@/services/FileWatchService';
import { ProjectScriptLoaderService } from '@/services/ProjectScriptLoaderService';
import { ProjectStorageService } from '@/services/ProjectStorageService';

export type CodeDocumentLanguage = 'typescript' | 'javascript' | 'json';
export type CodeDocumentEventReason = 'load' | 'change' | 'save' | 'reload' | 'external-change';

export interface CodeDocumentSnapshot {
  resourcePath: string;
  language: CodeDocumentLanguage;
  text: string;
  savedText: string;
  isDirty: boolean;
  lastModifiedTime: number | null;
}

export interface CodeDocumentEvent {
  resourcePath: string;
  reason: CodeDocumentEventReason;
  snapshot: CodeDocumentSnapshot;
}

interface CodeDocumentRecord extends CodeDocumentSnapshot {
  fileHandle: FileSystemFileHandle | null;
  disposeWatch?: () => void;
}

type CodeDocumentListener = (event: CodeDocumentEvent) => void;

@injectable()
export class CodeDocumentService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(FileWatchService)
  private readonly fileWatchService!: FileWatchService;

  @inject(ProjectScriptLoaderService)
  private readonly projectScriptLoader!: ProjectScriptLoaderService;

  private readonly documents = new Map<string, CodeDocumentRecord>();
  private readonly listeners = new Map<string, Set<CodeDocumentListener>>();
  private readonly globalListeners = new Set<CodeDocumentListener>();
  private readonly loadInFlight = new Map<string, Promise<CodeDocumentSnapshot>>();

  async ensureLoaded(resourcePath: string): Promise<CodeDocumentSnapshot> {
    const existing = this.documents.get(resourcePath);
    if (existing) {
      return this.toSnapshot(existing);
    }

    let inFlight = this.loadInFlight.get(resourcePath);
    if (!inFlight) {
      inFlight = this.loadDocument(resourcePath).finally(() => {
        this.loadInFlight.delete(resourcePath);
      });
      this.loadInFlight.set(resourcePath, inFlight);
    }

    return inFlight;
  }

  getDocument(resourcePath: string): CodeDocumentSnapshot | null {
    const record = this.documents.get(resourcePath);
    return record ? this.toSnapshot(record) : null;
  }

  subscribe(resourcePath: string, listener: CodeDocumentListener): () => void {
    let bucket = this.listeners.get(resourcePath);
    if (!bucket) {
      bucket = new Set<CodeDocumentListener>();
      this.listeners.set(resourcePath, bucket);
    }

    bucket.add(listener);
    return () => {
      const current = this.listeners.get(resourcePath);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.listeners.delete(resourcePath);
      }
    };
  }

  subscribeAll(listener: CodeDocumentListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  async updateContent(resourcePath: string, text: string): Promise<CodeDocumentSnapshot> {
    const record = await this.requireRecord(resourcePath);
    if (record.text === text) {
      return this.toSnapshot(record);
    }

    record.text = text;
    record.isDirty = record.text !== record.savedText;
    this.emit(resourcePath, 'change');
    return this.toSnapshot(record);
  }

  async save(resourcePath: string): Promise<CodeDocumentSnapshot> {
    const record = await this.requireRecord(resourcePath);
    await this.storage.writeTextFile(resourcePath, record.text);
    record.savedText = record.text;
    record.isDirty = false;
    record.lastModifiedTime = await this.storage.getLastModified(resourcePath);
    this.fileWatchService.setLastKnownModifiedTime(resourcePath, record.lastModifiedTime);
    this.emit(resourcePath, 'save');

    if (this.shouldRebuildScripts(resourcePath)) {
      await this.projectScriptLoader.syncAndBuild();
    }

    return this.toSnapshot(record);
  }

  async reload(resourcePath: string): Promise<CodeDocumentSnapshot> {
    const record = await this.requireRecord(resourcePath);
    const nextText = await this.storage.readTextFile(resourcePath);
    record.text = nextText;
    record.savedText = nextText;
    record.isDirty = false;
    record.lastModifiedTime = await this.storage.getLastModified(resourcePath);
    this.fileWatchService.setLastKnownModifiedTime(resourcePath, record.lastModifiedTime);
    this.emit(resourcePath, 'reload');
    return this.toSnapshot(record);
  }

  close(resourcePath: string): void {
    const record = this.documents.get(resourcePath);
    if (!record) {
      return;
    }

    record.disposeWatch?.();
    this.documents.delete(resourcePath);
    this.listeners.delete(resourcePath);
  }

  isSupportedResourcePath(resourcePath: string): boolean {
    const normalized = resourcePath.toLowerCase();
    return normalized.endsWith('.ts') || normalized.endsWith('.js') || normalized.endsWith('.json');
  }

  resolveLanguage(resourcePath: string): CodeDocumentLanguage {
    const normalized = resourcePath.toLowerCase();
    if (normalized.endsWith('.json')) {
      return 'json';
    }
    if (normalized.endsWith('.js')) {
      return 'javascript';
    }
    return 'typescript';
  }

  private async loadDocument(resourcePath: string): Promise<CodeDocumentSnapshot> {
    const text = await this.storage.readTextFile(resourcePath);
    const lastModifiedTime = await this.storage.getLastModified(resourcePath);
    const fileHandle = await this.storage.getFileHandle(resourcePath);
    const record: CodeDocumentRecord = {
      resourcePath,
      language: this.resolveLanguage(resourcePath),
      text,
      savedText: text,
      isDirty: false,
      lastModifiedTime,
      fileHandle,
    };

    this.documents.set(resourcePath, record);
    this.registerWatch(record);
    this.emit(resourcePath, 'load');
    return this.toSnapshot(record);
  }

  private registerWatch(record: CodeDocumentRecord): void {
    record.disposeWatch?.();
    record.disposeWatch = undefined;

    if (this.storage.getBackend() !== 'local' || !record.fileHandle) {
      return;
    }

    const onChange = () => {
      void this.handleExternalChange(record.resourcePath);
    };

    this.fileWatchService.watch(
      record.resourcePath,
      record.fileHandle,
      record.lastModifiedTime,
      onChange
    );
    record.disposeWatch = () => this.fileWatchService.unwatch(record.resourcePath, onChange);
  }

  private async handleExternalChange(resourcePath: string): Promise<void> {
    const record = this.documents.get(resourcePath);
    if (!record) {
      return;
    }

    record.lastModifiedTime = await this.storage.getLastModified(resourcePath);
    this.emit(resourcePath, 'external-change');

    if (!record.isDirty) {
      await this.reload(resourcePath);
      return;
    }

    const choice = await this.dialogService.showChoice({
      title: 'File Changed on Disk',
      message: `Reload external changes for ${this.getDisplayName(resourcePath)}? Your in-editor edits are still unsaved.`,
      confirmLabel: 'Reload',
      secondaryLabel: 'Keep Current',
      cancelLabel: 'Cancel',
    });

    if (choice === 'confirm') {
      await this.reload(resourcePath);
    }
  }

  private emit(resourcePath: string, reason: CodeDocumentEventReason): void {
    const record = this.documents.get(resourcePath);
    if (!record) {
      return;
    }

    const event: CodeDocumentEvent = {
      resourcePath,
      reason,
      snapshot: this.toSnapshot(record),
    };

    const listeners = this.listeners.get(resourcePath);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }
    }

    for (const listener of this.globalListeners) {
      listener(event);
    }
  }

  private async requireRecord(resourcePath: string): Promise<CodeDocumentRecord> {
    await this.ensureLoaded(resourcePath);
    const record = this.documents.get(resourcePath);
    if (!record) {
      throw new Error(`Code document not loaded: ${resourcePath}`);
    }
    return record;
  }

  private shouldRebuildScripts(resourcePath: string): boolean {
    const normalized = resourcePath
      .replace(/^res:\/\//i, '')
      .replace(/^\/+/, '')
      .replace(/\\+/g, '/')
      .toLowerCase();

    if (!(normalized.endsWith('.ts') || normalized.endsWith('.js'))) {
      return false;
    }

    return normalized.startsWith('scripts/') || normalized.startsWith('src/scripts/');
  }

  private getDisplayName(resourcePath: string): string {
    const segments = resourcePath.replace(/\\+/g, '/').split('/').filter(Boolean);
    return segments[segments.length - 1] ?? resourcePath;
  }

  private toSnapshot(record: CodeDocumentRecord): CodeDocumentSnapshot {
    return {
      resourcePath: record.resourcePath,
      language: record.language,
      text: record.text,
      savedText: record.savedText,
      isDirty: record.isDirty,
      lastModifiedTime: record.lastModifiedTime,
    };
  }

  dispose(): void {
    for (const record of this.documents.values()) {
      record.disposeWatch?.();
    }
    this.documents.clear();
    this.listeners.clear();
    this.globalListeners.clear();
    this.loadInFlight.clear();
  }
}
