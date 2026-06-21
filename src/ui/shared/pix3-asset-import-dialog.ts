import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { createRef, ref } from 'lit/directives/ref.js';
import { AssetImportService } from '@/services/AssetImportService';
import { IconService, IconSize } from '@/services/IconService';
import './pix3-asset-import-dialog.ts.css';

interface StagedFile {
  readonly id: number;
  readonly file: File;
  /** Object URL for image previews, or `null` for non-image files. Must be revoked. */
  readonly previewUrl: string | null;
}

/**
 * Modal that lets the user stage files via drag-and-drop, the OS file picker, or
 * the clipboard, review them (with size/type/preview and per-row removal), and
 * copy them into the target project directory on confirm.
 */
@customElement('pix3-asset-import-dialog')
export class AssetImportDialog extends ComponentBase {
  @inject(AssetImportService)
  private readonly assetImportService!: AssetImportService;

  @inject(IconService)
  private readonly iconService!: IconService;

  @property({ type: String, reflect: true })
  public dialogId = '';

  @property({ type: String })
  public targetDirectory = '.';

  @state()
  private stagedFiles: StagedFile[] = [];

  @state()
  private isDragOver = false;

  @state()
  private isImporting = false;

  @state()
  private errorMessage: string | null = null;

  private readonly fileInputRef = createRef<HTMLInputElement>();
  private nextStagedId = 0;
  private pastedCounter = 0;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('paste', this.onWindowPaste);
    window.addEventListener('keydown', this.onWindowKeyDown, true);
  }

  disconnectedCallback(): void {
    window.removeEventListener('paste', this.onWindowPaste);
    window.removeEventListener('keydown', this.onWindowKeyDown, true);
    this.revokeAllPreviews();
    super.disconnectedCallback();
  }

  protected render() {
    const targetLabel = this.targetDirectory === '.' ? 'project root' : this.targetDirectory;
    const count = this.stagedFiles.length;
    const importLabel = this.isImporting ? 'Importing…' : count > 0 ? `Import ${count}` : 'Import';

    return html`
      <div class="dialog-backdrop" @click=${this.onBackdropClick}>
        <div
          class="dialog-content"
          role="dialog"
          aria-modal="true"
          aria-label="Import assets"
          @click=${(event: Event) => event.stopPropagation()}
        >
          <div class="import-header">
            <h2 class="dialog-title">Import Assets</h2>
            <button
              class="import-close"
              type="button"
              aria-label="Close"
              ?disabled=${this.isImporting}
              @click=${this.handleCancel}
            >
              ${this.iconService.getIcon('x', IconSize.MEDIUM)}
            </button>
          </div>

          <p class="import-target">
            Destination <span class="import-target__path">${targetLabel}</span>
          </p>

          <div
            class="drop-zone ${this.isDragOver ? 'drop-zone--active' : ''}"
            @dragenter=${this.onDragOver}
            @dragover=${this.onDragOver}
            @dragleave=${this.onDragLeave}
            @drop=${this.onDrop}
          >
            <span class="drop-zone__icon">
              ${this.iconService.getIcon('upload-cloud', IconSize.XLARGE)}
            </span>
            <p class="drop-zone__title">Drag &amp; drop files here</p>
            <p class="drop-zone__hint">or paste from the clipboard (Ctrl/Cmd + V)</p>
            <div class="drop-zone__actions">
              <button class="btn-secondary" type="button" @click=${this.onBrowse}>
                ${this.iconService.getIcon('folder', IconSize.SMALL)} Browse files
              </button>
              <button class="btn-secondary" type="button" @click=${this.onPasteButton}>
                ${this.iconService.getIcon('clipboard', IconSize.SMALL)} Paste
              </button>
            </div>
            <input
              ${ref(this.fileInputRef)}
              class="visually-hidden"
              type="file"
              multiple
              @change=${this.onFileInputChange}
            />
          </div>

          ${this.errorMessage
            ? html`<p class="import-error" role="alert">${this.errorMessage}</p>`
            : null}
          ${count > 0
            ? html`
                <div class="staged">
                  <div class="staged__header">
                    <span>Selected files (${count})</span>
                    <button
                      class="staged__clear"
                      type="button"
                      ?disabled=${this.isImporting}
                      @click=${this.clearAll}
                    >
                      Clear all
                    </button>
                  </div>
                  <ul class="staged__list">
                    ${this.stagedFiles.map(staged => this.renderStagedFile(staged))}
                  </ul>
                </div>
              `
            : null}

          <div class="dialog-actions">
            <button
              class="btn-secondary"
              type="button"
              ?disabled=${this.isImporting}
              @click=${this.handleCancel}
            >
              Cancel
            </button>
            <button
              class="btn-primary"
              type="button"
              ?disabled=${count === 0 || this.isImporting}
              @click=${this.handleConfirm}
            >
              ${importLabel}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderStagedFile(staged: StagedFile) {
    const { file } = staged;
    const typeLabel = file.type || fileExtension(file.name).toUpperCase() || 'file';

    return html`
      <li class="staged-item">
        <span class="staged-item__preview">
          ${staged.previewUrl
            ? html`<img src=${staged.previewUrl} alt="" />`
            : this.iconService.getIcon('file', IconSize.MEDIUM)}
        </span>
        <span class="staged-item__info">
          <span class="staged-item__name" title=${file.name}>${file.name}</span>
          <span class="staged-item__meta">${formatBytes(file.size)} · ${typeLabel}</span>
        </span>
        <button
          class="staged-item__remove"
          type="button"
          aria-label=${`Remove ${file.name}`}
          ?disabled=${this.isImporting}
          @click=${() => this.removeFile(staged.id)}
        >
          ${this.iconService.getIcon('x', IconSize.SMALL)}
        </button>
      </li>
    `;
  }

  private onDragOver = (event: DragEvent): void => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    this.isDragOver = true;
  };

  private onDragLeave = (event: DragEvent): void => {
    // Ignore drag-leave events fired while moving over child elements of the zone.
    const related = event.relatedTarget as Node | null;
    const zone = event.currentTarget as Node | null;
    if (related && zone && zone.contains(related)) {
      return;
    }
    this.isDragOver = false;
  };

  private onDrop = (event: DragEvent): void => {
    event.preventDefault();
    this.isDragOver = false;
    const files = extractFilesFromDataTransfer(event.dataTransfer);
    if (files.length > 0) {
      this.addFiles(files);
    }
  };

  private onBrowse = (): void => {
    this.fileInputRef.value?.click();
  };

  private onFileInputChange = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.addFiles(Array.from(input.files));
    }
    // Reset so selecting the same file again still fires a change event.
    input.value = '';
  };

  private onWindowPaste = (event: ClipboardEvent): void => {
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      this.addFiles(files);
    }
  };

  private onPasteButton = async (): Promise<void> => {
    this.errorMessage = null;
    const clipboard = navigator.clipboard as Clipboard & { read?: () => Promise<ClipboardItems> };
    if (!clipboard || typeof clipboard.read !== 'function') {
      this.errorMessage =
        'This browser cannot read the clipboard directly. Use Ctrl/Cmd + V instead.';
      return;
    }

    try {
      const items = await clipboard.read();
      if (!this.isConnected) {
        return;
      }
      const files: File[] = [];
      for (const item of items) {
        for (const type of item.types) {
          if (!type.startsWith('image/')) {
            continue;
          }
          const blob = await item.getType(type);
          const extension = extensionForMime(type) || 'png';
          files.push(
            new File([blob], `pasted-${(this.pastedCounter += 1)}.${extension}`, { type })
          );
        }
      }
      if (files.length === 0) {
        this.errorMessage = 'No image was found on the clipboard.';
        return;
      }
      this.addFiles(files);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Failed to read the clipboard.';
    }
  };

  private onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !this.isImporting) {
      event.stopPropagation();
      this.handleCancel();
    }
  };

  private onBackdropClick = (): void => {
    if (!this.isImporting) {
      this.handleCancel();
    }
  };

  private addFiles(files: readonly File[]): void {
    // Guarantee every staged file has a usable name regardless of source
    // (drag-drop and the OS picker can both surface nameless blobs).
    const staged = files.map(file => {
      const named = this.ensureNamedFile(file);
      return {
        id: (this.nextStagedId += 1),
        file: named,
        previewUrl: named.type.startsWith('image/') ? URL.createObjectURL(named) : null,
      };
    });
    this.stagedFiles = [...this.stagedFiles, ...staged];
    this.errorMessage = null;
  }

  private removeFile(id: number): void {
    const target = this.stagedFiles.find(staged => staged.id === id);
    if (target?.previewUrl) {
      URL.revokeObjectURL(target.previewUrl);
    }
    this.stagedFiles = this.stagedFiles.filter(staged => staged.id !== id);
  }

  private clearAll = (): void => {
    this.revokeAllPreviews();
    this.stagedFiles = [];
    this.errorMessage = null;
  };

  private handleConfirm = async (): Promise<void> => {
    if (this.stagedFiles.length === 0 || this.isImporting) {
      return;
    }

    this.isImporting = true;
    this.errorMessage = null;

    try {
      const result = await this.assetImportService.importFiles(
        this.stagedFiles.map(staged => staged.file),
        this.targetDirectory
      );

      // The dialog may have been torn down while the import was in flight.
      if (!this.isConnected) {
        return;
      }

      if (result.importedPaths.length === 0) {
        this.errorMessage = result.failures[0]?.error ?? 'No files were imported.';
        this.isImporting = false;
        return;
      }

      if (result.failures.length > 0) {
        console.warn('[AssetImportDialog] Some files failed to import', result.failures);
      }

      this.dispatchEvent(
        new CustomEvent('asset-import-confirmed', {
          detail: { dialogId: this.dialogId, importedPaths: result.importedPaths },
          bubbles: true,
          composed: true,
        })
      );
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Failed to import files.';
      this.isImporting = false;
    }
  };

  private handleCancel = (): void => {
    this.dispatchEvent(
      new CustomEvent('asset-import-cancelled', {
        detail: { dialogId: this.dialogId },
        bubbles: true,
        composed: true,
      })
    );
  };

  private ensureNamedFile(file: File): File {
    if (file.name && file.name.trim().length > 0) {
      return file;
    }
    const extension = extensionForMime(file.type) || 'bin';
    return new File([file], `pasted-${(this.pastedCounter += 1)}.${extension}`, {
      type: file.type,
      lastModified: file.lastModified,
    });
  }

  private revokeAllPreviews(): void {
    for (const staged of this.stagedFiles) {
      if (staged.previewUrl) {
        URL.revokeObjectURL(staged.previewUrl);
      }
    }
  }
}

function extractFilesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) {
    return [];
  }
  const files: File[] = [];
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    for (let i = 0; i < dataTransfer.items.length; i += 1) {
      const item = dataTransfer.items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }
    if (files.length > 0) {
      return files;
    }
  }
  if (dataTransfer.files) {
    for (let i = 0; i < dataTransfer.files.length; i += 1) {
      files.push(dataTransfer.files[i]);
    }
  }
  return files;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

function extensionForMime(mime: string): string {
  if (mime === 'image/jpeg') {
    return 'jpg';
  }
  if (mime === 'image/svg+xml') {
    return 'svg';
  }
  const slash = mime.indexOf('/');
  return slash >= 0 ? mime.slice(slash + 1) : '';
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-asset-import-dialog': AssetImportDialog;
  }
}
