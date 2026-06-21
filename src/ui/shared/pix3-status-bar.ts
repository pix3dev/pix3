import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { DialogService } from '@/services/DialogService';
import { LoggingService } from '@/services/LoggingService';
import {
  BundleSizeService,
  formatByteSize,
  type BundleSizeReport,
  type BundleSizeCategory,
} from '@/services/BundleSizeService';
import { UpdateCheckService, type UpdateCheckState } from '@/services/UpdateCheckService';
import { CURRENT_EDITOR_VERSION } from '@/version';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import './pix3-status-bar.ts.css';
import '../collab/collab-status-bar';

interface StatusMessage {
  text: string;
  type: 'info' | 'success' | 'warning' | 'error';
  timestamp: number;
}

@customElement('pix3-status-bar')
export class Pix3StatusBar extends ComponentBase {
  static useShadowDom = false;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(UpdateCheckService)
  private readonly updateCheckService!: UpdateCheckService;

  @inject(BundleSizeService)
  private readonly bundleSizeService!: BundleSizeService;

  @state()
  private currentMessage: StatusMessage | null = null;

  @state()
  private bundleSize: BundleSizeReport | null = null;

  @state()
  private bundleSizeComputing = false;

  @state()
  private projectName: string | null = null;

  @state()
  private isPlaying = false;

  @state()
  private updateState: UpdateCheckState = {
    status: 'idle',
    currentVersion: CURRENT_EDITOR_VERSION,
    latestVersion: null,
  };

  private messageTimeout: number | null = null;
  private disposeLogListener?: () => void;
  private disposeProjectSubscription?: () => void;
  private disposeUiSubscription?: () => void;
  private disposeUpdateCheckSubscription?: () => void;

  connectedCallback() {
    super.connectedCallback();

    this.disposeProjectSubscription = subscribe(appState.project, () => {
      if (this.projectName !== appState.project.projectName) {
        // Project changed — the previous size estimate no longer applies.
        this.bundleSize = null;
        this.bundleSizeComputing = false;
      }
      this.projectName = appState.project.projectName;
    });

    this.disposeUiSubscription = subscribe(appState.ui, () => {
      this.isPlaying = appState.ui.isPlaying;
    });

    this.disposeUpdateCheckSubscription = this.updateCheckService.subscribe(state => {
      this.updateState = state;
    });

    // Subscribe to log messages to show status
    this.disposeLogListener = this.logger.subscribe(entry => {
      // Show important messages in status bar
      if (entry.level === 'error' || entry.level === 'warn' || entry.level === 'info') {
        this.showMessage(
          entry.message,
          entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warning' : 'info'
        );
      }
    });

    // Initialize state
    this.projectName = appState.project.projectName;
    this.isPlaying = appState.ui.isPlaying;
  }

  disconnectedCallback() {
    this.disposeLogListener?.();
    this.disposeProjectSubscription?.();
    this.disposeUiSubscription?.();
    this.disposeUpdateCheckSubscription?.();
    if (this.messageTimeout !== null) {
      window.clearTimeout(this.messageTimeout);
    }
    super.disconnectedCallback();
  }

  /**
   * Show a temporary status message
   */
  showMessage(text: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    this.currentMessage = {
      text,
      type,
      timestamp: Date.now(),
    };

    // Clear previous timeout
    if (this.messageTimeout !== null) {
      window.clearTimeout(this.messageTimeout);
    }

    // Auto-hide after 5 seconds
    this.messageTimeout = window.setTimeout(() => {
      this.currentMessage = null;
      this.messageTimeout = null;
    }, 5000);
  }

  protected render() {
    return html`
      <div class="status-bar">
        <div class="status-left">
          ${this.currentMessage
            ? html`
                <span class="status-message ${this.currentMessage.type}">
                  ${this.currentMessage.text}
                </span>
              `
            : html`<span class="status-ready">Ready</span>`}
        </div>
        <div class="status-right">
          <collab-status-bar></collab-status-bar>
          ${this.isPlaying
            ? html`<span class="status-indicator playing">▶ Playing</span>`
            : html``}
          ${this.updateState.status === 'update-available' && this.updateState.latestVersion
            ? html`
                <button
                  type="button"
                  class="status-indicator update status-update-button"
                  title="Reload the editor to apply the update"
                  @click=${this.onUpdateIndicatorClick}
                >
                  Update available: ${this.updateState.latestVersion.displayVersion}
                </button>
              `
            : html``}
          ${this.projectName ? this.renderBundleSize() : html``}
          <span class="status-version">${this.updateState.currentVersion.displayVersion}</span>
          ${this.projectName
            ? html`<span class="status-project">${this.projectName}</span>`
            : html``}
        </div>
      </div>
    `;
  }

  private renderBundleSize() {
    const label = this.bundleSizeComputing
      ? '…'
      : this.bundleSize
        ? formatByteSize(this.bundleSize.totalBytes)
        : 'Size';
    const title = this.bundleSizeComputing
      ? 'Calculating project size…'
      : this.bundleSize
        ? `${this.buildBundleSizeBreakdown(this.bundleSize)}\nClick to recalculate`
        : 'Click to calculate the project bundle size';

    return html`
      <button
        type="button"
        class="status-indicator status-bundle-size"
        title=${title}
        ?disabled=${this.bundleSizeComputing}
        @click=${this.onBundleSizeClick}
      >
        📦 ${label}
      </button>
    `;
  }

  private buildBundleSizeBreakdown(report: BundleSizeReport): string {
    const labels: Record<BundleSizeCategory, string> = {
      images: 'Images',
      audio: 'Audio',
      models: 'Models',
      scenes: 'Scenes',
      scripts: 'Scripts',
      data: 'Data',
      fonts: 'Fonts',
      other: 'Other',
    };
    const order: BundleSizeCategory[] = [
      'images',
      'audio',
      'models',
      'scenes',
      'scripts',
      'data',
      'fonts',
      'other',
    ];

    const lines = order
      .filter(category => report.byCategory[category].count > 0)
      .map(
        category =>
          `${labels[category]}: ${formatByteSize(report.byCategory[category].bytes)} (${report.byCategory[category].count})`
      );

    return [
      `Bundle size: ${formatByteSize(report.totalBytes)} · ${report.fileCount} files`,
      ...lines,
    ].join('\n');
  }

  private onBundleSizeClick = async (): Promise<void> => {
    if (this.bundleSizeComputing) {
      return;
    }
    this.bundleSizeComputing = true;
    try {
      this.bundleSize = await this.bundleSizeService.computeProjectSize();
    } catch (error) {
      console.error('[Pix3StatusBar] Failed to compute project bundle size', error);
      this.showMessage('Failed to compute project size', 'error');
    } finally {
      this.bundleSizeComputing = false;
    }
  };

  private onUpdateIndicatorClick = async (): Promise<void> => {
    if (this.updateState.status !== 'update-available' || !this.updateState.latestVersion) {
      return;
    }

    const confirmed = await this.dialogService.showConfirmation({
      title: 'Update Available',
      message:
        `A newer Pix3 editor build is available.\n\n` +
        `Current: ${this.updateState.currentVersion.displayVersion}\n` +
        `Available: ${this.updateState.latestVersion.displayVersion}\n\n` +
        `Reload the page now to update the editor.`,
      confirmLabel: 'Reload Now',
      cancelLabel: 'Later',
    });

    if (!confirmed) {
      return;
    }

    this.reloadForUpdate();
  };

  private reloadForUpdate(): void {
    const url = new URL(window.location.href);
    url.searchParams.set('pix3_refresh', Date.now().toString());
    window.location.replace(url.toString());
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-status-bar': Pix3StatusBar;
  }
}
