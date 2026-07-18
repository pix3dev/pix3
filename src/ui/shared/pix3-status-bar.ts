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
import {
  ProjectDiagnosticsService,
  type ScriptDiagnosticsSummary,
} from '@/services/ProjectDiagnosticsService';
import { TabPerformanceService, type TabPerformanceSample } from '@/services/TabPerformanceService';
import { LayoutManagerService } from '@/core/LayoutManager';
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

  @inject(ProjectDiagnosticsService)
  private readonly diagnosticsService!: ProjectDiagnosticsService;

  @inject(TabPerformanceService)
  private readonly tabPerformanceService!: TabPerformanceService;

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

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
  private diagnostics: ScriptDiagnosticsSummary | null = null;

  @state()
  private perfSample: TabPerformanceSample = { cpuLoad: 0, gpuMs: null, renderMs: 0 };

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
  private disposeDiagnosticsSubscription?: () => void;
  private disposePerformanceSubscription?: () => void;

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

    this.disposeDiagnosticsSubscription = this.diagnosticsService.subscribe(summary => {
      this.diagnostics = summary;
    });

    this.disposePerformanceSubscription = this.tabPerformanceService.subscribe(sample => {
      this.perfSample = sample;
    });

    // Initialize state
    this.projectName = appState.project.projectName;
    this.isPlaying = appState.ui.isPlaying;
    this.diagnostics = this.diagnosticsService.getLastSummary();
  }

  disconnectedCallback() {
    this.disposeLogListener?.();
    this.disposeProjectSubscription?.();
    this.disposeUiSubscription?.();
    this.disposeUpdateCheckSubscription?.();
    this.disposeDiagnosticsSubscription?.();
    this.disposePerformanceSubscription?.();
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
          ${this.renderPerformance()} ${this.renderDiagnostics()}
          ${this.projectName ? this.renderBundleSize() : html``}
          <span class="status-version">${this.updateState.currentVersion.displayVersion}</span>
          ${this.projectName
            ? html`<span class="status-project">${this.projectName}</span>`
            : html``}
        </div>
      </div>
    `;
  }

  private renderDiagnostics() {
    const summary = this.diagnostics;
    if (!summary || (summary.errorCount === 0 && summary.warningCount === 0)) {
      return html``;
    }

    const hasErrors = summary.errorCount > 0;
    const label = hasErrors
      ? `⨯ ${summary.errorCount}${summary.warningCount > 0 ? ` ⚠ ${summary.warningCount}` : ''}`
      : `⚠ ${summary.warningCount}`;
    const title =
      `${summary.errorCount} script error(s), ${summary.warningCount} warning(s) ` +
      `in ${summary.filesChecked} file(s).\nClick to re-check and open the Logs panel.`;

    return html`
      <button
        type="button"
        class="status-indicator status-diagnostics ${hasErrors ? 'error' : 'warning'}"
        title=${title}
        @click=${this.onDiagnosticsClick}
      >
        ${label}
      </button>
    `;
  }

  private onDiagnosticsClick = (): void => {
    this.layoutManager.focusPanel('logs');
    void this.diagnosticsService.checkProject();
  };

  /**
   * A glanceable CPU/GPU load readout for the whole editor tab. CPU is a
   * main-thread load estimate (event-loop lag); GPU is the viewport's measured
   * GPU frame time, falling back to render (CPU-side) frame time where the
   * backend can't report GPU timing.
   */
  private renderPerformance() {
    const { cpuLoad, gpuMs, renderMs } = this.perfSample;
    const cpuPct = Math.round(cpuLoad * 100);
    const level = cpuLoad >= 0.75 ? 'high' : cpuLoad >= 0.4 ? 'mid' : 'low';

    const hasGpu = gpuMs !== null;
    const gpuLabel = hasGpu ? 'GPU' : 'Frame';
    const gpuValue = `${(hasGpu ? gpuMs : renderMs).toFixed(1)}ms`;

    const title =
      'Editor tab load\n' +
      `CPU ${cpuPct}% — main-thread load (event-loop lag)\n` +
      (hasGpu
        ? `GPU ${gpuValue} — viewport GPU frame time`
        : `Frame ${gpuValue} — viewport render time (GPU timing unavailable on this backend)`);

    return html`
      <span class="status-indicator status-perf ${level}" title=${title}>
        <span class="status-perf-metric">CPU ${cpuPct}%</span>
        <span class="status-perf-sep">·</span>
        <span class="status-perf-metric">${gpuLabel} ${gpuValue}</span>
      </span>
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
