import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { IconService } from '@/services/editor/IconService';
import type { AnimationClip } from '@pix3/runtime';

import type { AnimationDocumentController } from './animation-document-controller';

import './sprite-clips-rail.ts.css';

/**
 * The clip rail of an animation document: one entry per clip with its frame
 * count, the active one highlighted, plus add / remove / inline-rename.
 *
 * New UI rather than an extraction — clip CRUD only ever existed in the
 * Inspector (`inspector-section-renderers.ts`), which keeps working untouched:
 * both surfaces drive the very same {@link AnimationDocumentController}, so they
 * cannot drift. Like `<pix3-sprite-timeline>` it takes a controller reference and
 * emits **no** data events; the active clip is controller state every host
 * already observes through `subscribe()`.
 */
@customElement('pix3-sprite-clips-rail')
export class SpriteClipsRail extends ComponentBase {
  @property({ attribute: false })
  controller: AnimationDocumentController | null = null;

  @inject(IconService)
  private readonly iconService!: IconService;

  /** Clip whose name is being edited inline (double-click or F2 on the entry). */
  @state()
  private renamingClipName: string | null = null;

  private boundController: AnimationDocumentController | null = null;
  private disposeControllerSubscription?: () => void;
  private shouldFocusRenameInput = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.bindController();
  }

  protected willUpdate(changedProperties: Map<PropertyKey, unknown>): void {
    if (changedProperties.has('controller')) {
      this.bindController();
    }
  }

  protected updated(): void {
    if (!this.shouldFocusRenameInput) {
      return;
    }

    const input = this.querySelector<HTMLInputElement>('.clip-rename-input');
    if (input) {
      this.shouldFocusRenameInput = false;
      input.focus();
      input.select();
    }
  }

  disconnectedCallback(): void {
    this.unbindController();
    super.disconnectedCallback();
  }

  protected render() {
    const controller = this.controller;
    const clips = controller?.resource?.clips ?? [];
    if (!controller) {
      return null;
    }

    return html`
      <div class="clips-rail-header">
        <span class="clips-rail-title">Clips</span>
        <div class="clips-rail-actions">
          <button
            class="clips-rail-action"
            type="button"
            title="Add clip"
            aria-label="Add clip"
            ?disabled=${!controller.resource}
            @click=${() => void controller.addClip()}
          >
            ${this.iconService.getIcon('plus', 12)}
          </button>
          <button
            class="clips-rail-action is-danger"
            type="button"
            title="Remove the active clip"
            aria-label="Remove the active clip"
            ?disabled=${!controller.activeClip}
            @click=${() => void controller.removeClip()}
          >
            ${this.iconService.getIcon('trash-2', 12)}
          </button>
        </div>
      </div>
      ${clips.length === 0
        ? html`<p class="clips-rail-empty">No clips yet. Add one to start authoring frames.</p>`
        : html`
            <ul class="clip-list">
              ${clips.map(clip => this.renderClipEntry(controller, clip))}
            </ul>
          `}
    `;
  }

  private renderClipEntry(controller: AnimationDocumentController, clip: AnimationClip) {
    if (this.renamingClipName === clip.name) {
      return html`
        <li class="clip-list-item">
          <input
            class="clip-rename-input"
            type="text"
            .value=${clip.name}
            aria-label=${`Rename clip ${clip.name}`}
            @keydown=${(event: KeyboardEvent) => this.onRenameKeyDown(event, clip.name)}
            @blur=${(event: Event) =>
              void this.commitRename(clip.name, (event.target as HTMLInputElement).value)}
          />
        </li>
      `;
    }

    const isActive = clip.name === controller.activeClipName;
    return html`
      <li class="clip-list-item">
        <button
          class="clip-entry ${isActive ? 'is-active' : ''}"
          type="button"
          title=${`${clip.name} — ${clip.frames.length} frame(s). Double-click or press F2 to rename.`}
          aria-pressed=${isActive ? 'true' : 'false'}
          @click=${() => void controller.selectClip(clip.name)}
          @dblclick=${() => this.beginRename(clip.name)}
          @keydown=${(event: KeyboardEvent) => this.onEntryKeyDown(event, clip.name)}
        >
          <span class="clip-entry-name">${clip.name}</span>
          <span class="clip-entry-count">${clip.frames.length}</span>
        </button>
      </li>
    `;
  }

  // --- inline rename ---------------------------------------------------------

  /**
   * `renameClip` always renames the *active* clip, so a rename started on another
   * entry selects it first. `selectClip` swaps the active name synchronously (the
   * await inside it only syncs a selected node's `currentClip`), so the input this
   * render puts on screen is already the active clip's.
   */
  private beginRename(clipName: string): void {
    const controller = this.controller;
    if (!controller) {
      return;
    }

    if (controller.activeClipName !== clipName) {
      void controller.selectClip(clipName);
    }

    this.renamingClipName = clipName;
    this.shouldFocusRenameInput = true;
  }

  private onEntryKeyDown(event: KeyboardEvent, clipName: string): void {
    if (event.key !== 'F2') {
      return;
    }

    event.preventDefault();
    this.beginRename(clipName);
  }

  private onRenameKeyDown(event: KeyboardEvent, clipName: string): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.commitRename(clipName, (event.target as HTMLInputElement).value);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelRename();
    }
  }

  /**
   * Commit an inline rename. Also the blur handler, so clicking away keeps the
   * edit — Escape is the one way to throw it out, and it drops the input before a
   * blur can be dispatched.
   */
  private async commitRename(clipName: string, rawNextName: string): Promise<void> {
    if (this.renamingClipName !== clipName) {
      return;
    }

    this.renamingClipName = null;
    this.shouldFocusRenameInput = false;

    const nextName = rawNextName.trim();
    if (!nextName || nextName === clipName) {
      return;
    }

    await this.controller?.renameClip(nextName);
  }

  private cancelRename(): void {
    this.renamingClipName = null;
    this.shouldFocusRenameInput = false;
  }

  // --- controller binding ----------------------------------------------------

  /**
   * Subscribe to the controller handed in as a property. Called from
   * `connectedCallback` as well as on property change so a Golden Layout re-dock
   * (disconnect → reconnect with the same controller) rebinds.
   */
  private bindController(): void {
    if (this.boundController === this.controller && this.disposeControllerSubscription) {
      return;
    }

    this.unbindController();
    const controller = this.controller;
    if (!controller) {
      return;
    }

    this.boundController = controller;
    this.disposeControllerSubscription = controller.subscribe(() => this.requestUpdate());
  }

  private unbindController(): void {
    this.disposeControllerSubscription?.();
    this.disposeControllerSubscription = undefined;
    this.boundController = null;
    this.renamingClipName = null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-sprite-clips-rail': SpriteClipsRail;
  }
}
