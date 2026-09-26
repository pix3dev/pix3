import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { appState } from '@/state';
import { LayoutManagerService } from '@/core/LayoutManager';
import { IconService, IconSize } from '@/services/editor/IconService';
import { ExternalMergeService } from '@/services/project/coauthoring/ExternalMergeService';
import type { RecoveryRecord } from '@/services/project/coauthoring/RecoveryJournalService';
import './pix3-recovery-menu.ts.css';

const MENU_WIDTH_PX = 300;

/**
 * Scene tab context menu (right-click on a scene / prefab editor tab) — plan §5 C3: "Restore my
 * version…" lists the last ~10 versions of that scene in the recovery journal
 * (`.pix3/recovery/`), newest first, with their time. Picking one restores it as ONE undoable
 * operation (`RestoreRecoveryVersionCommand`), so this decision is reversible too.
 */
@customElement('pix3-recovery-menu')
export class Pix3RecoveryMenu extends ComponentBase {
  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @inject(ExternalMergeService)
  private readonly merges!: ExternalMergeService;

  @inject(IconService)
  private readonly icons!: IconService;

  @state() private open = false;
  @state() private x = 0;
  @state() private y = 0;
  @state() private sceneId: string | null = null;
  @state() private records: RecoveryRecord[] | null = null;
  @state() private showVersions = false;

  private disposeContextMenu?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeContextMenu = this.layoutManager.subscribeEditorTabContextMenu((tabId, at) =>
      this.openForTab(tabId, at)
    );
    window.addEventListener('pointerdown', this.onPointerDown, true);
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  disconnectedCallback(): void {
    this.disposeContextMenu?.();
    this.disposeContextMenu = undefined;
    window.removeEventListener('pointerdown', this.onPointerDown, true);
    window.removeEventListener('keydown', this.onKeyDown, true);
    super.disconnectedCallback();
  }

  /** Open the menu for the scene of an editor tab (ignored for non-scene tabs). */
  openForTab(tabId: string, at: { x: number; y: number }): void {
    const tab = appState.tabs.tabs.find(t => t.id === tabId);
    if (!tab || (tab.type !== 'scene' && tab.type !== 'prefab')) return;
    const sceneId =
      Object.values(appState.scenes.descriptors).find(d => d?.filePath === tab.resourceId)?.id ??
      null;
    if (!sceneId) return;
    this.openForScene(sceneId, at);
  }

  openForScene(sceneId: string, at: { x: number; y: number }): void {
    this.sceneId = sceneId;
    this.x = Math.max(8, Math.min(at.x, window.innerWidth - MENU_WIDTH_PX - 8));
    this.y = Math.max(8, at.y);
    this.records = null;
    this.showVersions = false;
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.showVersions = false;
  }

  protected render() {
    if (!this.open || !this.sceneId) return null;
    return html`
      <div
        class="recovery-menu"
        role="menu"
        aria-label="Scene tab"
        style="left:${this.x}px; top:${this.y}px; width:${MENU_WIDTH_PX}px"
      >
        <button
          type="button"
          class="recovery-menu__item"
          role="menuitem"
          aria-haspopup="true"
          aria-expanded=${this.showVersions ? 'true' : 'false'}
          data-action="restore-my-version"
          @click=${this.onShowVersions}
        >
          <span class="recovery-menu__icon" aria-hidden="true"
            >${this.icons.getIcon('rotate-ccw', IconSize.SMALL)}</span
          >
          Restore my version…
        </button>
        ${this.showVersions ? this.renderVersions() : null}
      </div>
    `;
  }

  private renderVersions() {
    if (this.records === null) {
      return html`<div class="recovery-menu__hint">Reading the recovery journal…</div>`;
    }
    if (this.records.length === 0) {
      return html`<div class="recovery-menu__hint">No saved versions of this scene yet.</div>`;
    }
    return html`<div class="recovery-menu__versions" role="group" aria-label="Versions">
      ${this.records.map(
        record => html`
          <button
            type="button"
            class="recovery-menu__item recovery-menu__version"
            role="menuitem"
            data-ref=${record.ref}
            @click=${() => this.onRestore(record)}
          >
            <span class="recovery-menu__icon" aria-hidden="true"
              >${this.icons.getIcon('clock', IconSize.SMALL)}</span
            >
            <span class="recovery-menu__time">${new Date(record.createdAt).toLocaleString()}</span>
            <span class="recovery-menu__hash">${record.hash8}</span>
          </button>
        `
      )}
    </div>`;
  }

  private onShowVersions = async (): Promise<void> => {
    this.showVersions = true;
    const sceneId = this.sceneId;
    const path = sceneId ? appState.scenes.descriptors[sceneId]?.filePath : null;
    if (!path) {
      this.records = [];
      return;
    }
    try {
      const records = await this.merges.listVersions(path, 10);
      if (this.sceneId === sceneId) this.records = records;
    } catch (error) {
      console.warn('[Pix3RecoveryMenu] Could not list journal versions', error);
      this.records = [];
    }
  };

  private async onRestore(record: RecoveryRecord): Promise<void> {
    const sceneId = this.sceneId;
    this.close();
    if (!sceneId) return;
    try {
      await this.merges.restoreVersion(sceneId, record);
    } catch (error) {
      console.error('[Pix3RecoveryMenu] Restore failed', error);
    }
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.open) return;
    const target = event.target as Node | null;
    if (target && this.contains(target)) return;
    this.close();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.open && event.key === 'Escape') {
      event.stopPropagation();
      this.close();
    }
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-recovery-menu': Pix3RecoveryMenu;
  }
}
