import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { DialogService } from '@/services/editor/DialogService';
import { LoggingService } from '@/services/core/LoggingService';
import {
  BundleSizeService,
  formatByteSize,
  type BundleSizeReport,
  type BundleSizeCategory,
} from '@/services/export/BundleSizeService';
import { UpdateCheckService, type UpdateCheckState } from '@/services/editor/UpdateCheckService';
import {
  ProjectDiagnosticsService,
  type ScriptDiagnosticsSummary,
} from '@/services/scripting/ProjectDiagnosticsService';
import {
  TabPerformanceService,
  type TabPerformanceSample,
} from '@/services/editor/TabPerformanceService';
import { LayoutManagerService } from '@/core/LayoutManager';
import { BridgeConnectionService } from '@/services/llm/BridgeConnectionService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { EditorSettingsService } from '@/services/editor/EditorSettingsService';
import { ProjectSyncService } from '@/services/project/ProjectSyncService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { CURRENT_EDITOR_VERSION } from '@/version';
import { subscribe } from 'valtio/vanilla';
import {
  appState,
  type AutosaveStatus,
  type HybridSyncStatus,
  type WorkspaceConnectionStatus,
  type WorkspaceLeaseState,
} from '@/state';
import { WorkspaceSessionService } from '@/services/project/workspace/WorkspaceSessionService';
import { WorkspaceConnectDialogService } from '@/services/project/workspace/WorkspaceConnectDialogService';
import './pix3-status-bar.ts.css';
import '../collab/collab-status-bar';
import './pix3-agent-channel-indicator';

interface StatusMessage {
  text: string;
  type: 'info' | 'success' | 'warning' | 'error';
  timestamp: number;
}

/**
 * The built-in providers whose keys this browser holds itself (Gemini, OpenRouter) come from the
 * registry; everything else metered runs through the local bridge. The two lane indicators together
 * answer "can the agent talk to a model at all?".
 */

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

  @inject(LlmProviderRegistry)
  private readonly llmProviders!: LlmProviderRegistry;

  @inject(BridgeConnectionService)
  private readonly bridge!: BridgeConnectionService;

  @inject(AgentSettingsService)
  private readonly agentSettings!: AgentSettingsService;

  @inject(EditorSettingsService)
  private readonly editorSettingsService!: EditorSettingsService;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(ProjectSyncService)
  private readonly projectSyncService!: ProjectSyncService;

  @inject(WorkspaceSessionService)
  private readonly workspaceSession!: WorkspaceSessionService;

  @inject(WorkspaceConnectDialogService)
  private readonly workspaceConnectDialog!: WorkspaceConnectDialogService;

  /** `pix3 serve` connection, shown only while the open project is a workspace. */
  @state()
  private workspaceStatus: WorkspaceConnectionStatus | null = null;

  @state()
  private workspaceLease: WorkspaceLeaseState = 'none';

  /** Co-authoring autosave pill (null = hidden: no project, or a cloud project). */
  @state()
  private autosaveStatus: AutosaveStatus | null = null;

  @state()
  private autosaveReason: string | null = null;

  @state()
  private autosaveLastAt: number | null = null;

  @state()
  private pendingExternalCount = 0;

  @state()
  private unreadableCount = 0;

  @state()
  private externalStale = false;

  @state()
  private currentMessage: StatusMessage | null = null;

  /**
   * Hybrid (local folder <-> cloud copy) sync, copied out of `appState.project.hybridSync` field
   * by field so a progress tick re-renders this bar only when something it shows has changed.
   */
  @state()
  private syncStatus: HybridSyncStatus = 'unlinked';

  @state()
  private syncProcessed = 0;

  @state()
  private syncTotal = 0;

  @state()
  private syncLocalChanges = 0;

  @state()
  private syncCloudChanges = 0;

  @state()
  private syncConflicts = 0;

  @state()
  private syncIssueCount = 0;

  @state()
  private syncError: string | null = null;

  @state()
  private syncLastAt: number | null = null;

  @state()
  private bundleSize: BundleSizeReport | null = null;

  @state()
  private bundleSizeComputing = false;

  @state()
  private projectName: string | null = null;

  @state()
  private isPlaying = false;

  /** Vibe (`flow`) hides the panels the perf probe measures — see {@link syncPerformanceProbe}. */
  @state()
  private isFlow = appState.ui.workspaceMode === 'flow';

  @state()
  private bridgeAvailable = false;

  @state()
  private bridgeProviderCount = 0;

  /** Labels of the built-in providers this browser has a key for (empty = none configured). */
  @state()
  private directKeyLabels: string[] = [];

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
  private disposeBridgeSubscription?: () => void;
  private disposeAgentSettingsSubscription?: () => void;

  connectedCallback() {
    super.connectedCallback();

    this.disposeProjectSubscription = subscribe(appState.project, () => {
      if (this.projectName !== appState.project.projectName) {
        // Project changed — the previous size estimate no longer applies.
        this.bundleSize = null;
        this.bundleSizeComputing = false;
      }
      this.projectName = appState.project.projectName;
      this.syncHybridSyncState();
      this.syncWorkspaceState();
      this.syncCoauthoringState();
    });

    this.disposeUiSubscription = subscribe(appState.ui, () => {
      this.isPlaying = appState.ui.isPlaying;
      this.isFlow = appState.ui.workspaceMode === 'flow';
      this.syncPerformanceProbe();
    });

    // Both agent lanes at a glance: the local bridge (every metered provider) and the built-in
    // provider keys the browser holds itself. A probe result can arrive long after startup, so
    // subscribe.
    this.disposeBridgeSubscription = this.bridge.subscribe(() => {
      this.syncBridgeState();
    });
    this.disposeAgentSettingsSubscription = this.agentSettings.subscribe(() => {
      void this.refreshDirectKeys();
    });
    this.syncBridgeState();

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

    this.syncPerformanceProbe();

    // Initialize state
    this.projectName = appState.project.projectName;
    this.syncHybridSyncState();
    this.syncWorkspaceState();
    this.syncCoauthoringState();
    this.isPlaying = appState.ui.isPlaying;
    this.diagnostics = this.diagnosticsService.getLastSummary();
  }

  /**
   * Hold the CPU/GPU probe only while this bar is actually on screen.
   *
   * In Vibe the whole Studio branch stays mounted and is hidden with `display:none`, so without this
   * the status bar keeps re-rendering twice a second — and, because the probe stops as soon as its
   * last subscriber leaves, dropping the subscription also stops the 500 ms timer behind it.
   */
  private syncHybridSyncState(): void {
    const sync = appState.project.hybridSync;
    // Lit's @state setters already skip equal primitives, so plain assignment is change-detected.
    this.syncStatus = sync.status;
    this.syncProcessed = sync.processedFileCount;
    this.syncTotal = sync.totalFileCount;
    this.syncLocalChanges = sync.localChangeCount;
    this.syncCloudChanges = sync.cloudChangeCount;
    this.syncConflicts = sync.conflictCount;
    this.syncIssueCount = sync.issues.length;
    this.syncError = sync.errorMessage;
    this.syncLastAt = sync.lastSyncAt;
  }

  /**
   * One pill for the local-folder <-> cloud link, so a sync that stalls, errors, or leaves
   * conflicts is visible without opening the Sync dialog. Hidden while the project has no cloud
   * link at all; clicking opens the dialog where every state here is actionable.
   */
  private renderSyncStatus() {
    if (this.syncStatus === 'unlinked' || !this.projectName) {
      return html``;
    }

    const lastSync = this.syncLastAt
      ? `Last sync ${new Date(this.syncLastAt).toLocaleString()}`
      : 'Not synced yet';
    const extra = this.syncError ? `\n${this.syncError}` : '';
    const footer = `\n${lastSync}\nClick to open Sync Project.`;

    let tone = 'is-ok';
    let icon = 'cloud';
    let label = 'Synced';
    let title = `Local folder and cloud copy are in sync.${footer}`;

    switch (this.syncStatus) {
      case 'checking':
        tone = 'is-busy';
        icon = 'refresh-cw';
        label = 'Checking…';
        title = `Comparing the local folder with the cloud copy.${footer}`;
        break;
      case 'syncing':
        tone = 'is-busy';
        icon = 'refresh-cw';
        label = this.syncTotal > 0 ? `Syncing ${this.syncProcessed}/${this.syncTotal}` : 'Syncing…';
        title = `Applying file updates between the local folder and the cloud copy.${footer}`;
        break;
      case 'local-changes':
        tone = this.syncIssueCount > 0 ? 'is-warn' : 'is-pending';
        icon = 'upload-cloud';
        label =
          this.syncIssueCount > 0
            ? `${this.syncIssueCount} skipped`
            : `${this.syncLocalChanges} to upload`;
        title =
          this.syncIssueCount > 0
            ? `${this.syncIssueCount} file(s) could not be uploaded.${extra}${footer}`
            : `${this.syncLocalChanges} local change(s) not yet in the cloud copy.${footer}`;
        break;
      case 'cloud-changes':
        tone = 'is-pending';
        icon = 'download-cloud';
        label = `${this.syncCloudChanges} to download`;
        title = `${this.syncCloudChanges} cloud change(s) not yet in the local folder.${footer}`;
        break;
      case 'conflict':
        tone = 'is-error';
        icon = 'alert-triangle';
        label = `${this.syncConflicts} conflict${this.syncConflicts === 1 ? '' : 's'}`;
        title = `Both sides changed the same file(s). Resolve in Sync Project.${footer}`;
        break;
      case 'auth-required':
        tone = 'is-error';
        icon = 'cloud-off';
        label = 'Sign in to sync';
        title = `The cloud copy needs you signed in.${extra}${footer}`;
        break;
      case 'error':
        tone = 'is-error';
        icon = 'alert-triangle';
        label = 'Sync error';
        title = `Sync failed.${extra}${footer}`;
        break;
      default:
        break;
    }

    return html`
      <button
        type="button"
        class="status-indicator status-sync ${tone}"
        title=${title}
        @click=${this.onSyncIndicatorClick}
      >
        ${this.icons.getIcon(icon, IconSize.SMALL)}
        <span class="status-sync-label">${label}</span>
      </button>
    `;
  }

  private syncWorkspaceState(): void {
    const project = appState.project;
    this.workspaceStatus =
      project.backend === 'workspace' && project.status === 'ready'
        ? project.workspace.status
        : null;
    this.workspaceLease = project.workspace.lease;
  }

  /**
   * Connection pill of a `pix3 serve` workspace: connected / reconnecting / read-only (another
   * window holds the lease) / disconnected. Clicking offers the action that fixes the state.
   */
  private renderWorkspaceStatus() {
    const status = this.workspaceStatus;
    if (!status) {
      return html``;
    }
    const workspace = appState.project.workspace;
    const where = workspace.root ? `\n${workspace.root}` : '';
    const endpoint = workspace.endpoint ?? '';
    const readOnly = this.workspaceLease === 'busy' || this.workspaceLease === 'lost';

    let tone = 'is-ok';
    let icon = 'server';
    let label = 'Workspace';
    let title = `Connected to pix3 serve at ${endpoint}.${where}`;

    if (status === 'reconnecting' || status === 'connecting') {
      tone = 'is-busy';
      icon = 'refresh-cw';
      label = 'Reconnecting…';
      title = `Lost the connection to ${endpoint}; retrying. Edits are not saved until it is back.`;
    } else if (status === 'disconnected') {
      tone = 'is-error';
      icon = 'alert-triangle';
      label = 'Disconnected';
      title = `${workspace.errorMessage ?? `Not connected to ${endpoint}.`}\nClick to reconnect.`;
    } else if (readOnly) {
      tone = 'is-warn';
      icon = 'lock';
      label = 'Read-only';
      title =
        'Another Pix3 window holds the edit lease of this workspace, so this one cannot save.' +
        '\nClick to take over.';
    }

    return html`
      <button
        type="button"
        class="status-indicator status-sync status-workspace ${tone}"
        title=${title}
        aria-label=${`Workspace: ${label}`}
        @click=${this.onWorkspaceIndicatorClick}
      >
        ${this.icons.getIcon(icon, IconSize.SMALL)}
        <span class="status-sync-label">${label}</span>
      </button>
    `;
  }

  private syncCoauthoringState(): void {
    const project = appState.project;
    const coauthoring = project.coauthoring;
    const visible = project.status === 'ready' && project.backend !== 'cloud';
    this.autosaveStatus = visible ? coauthoring.autosaveStatus : null;
    this.autosaveReason = coauthoring.autosaveReason;
    this.autosaveLastAt = coauthoring.lastAutosavedAt;
    this.pendingExternalCount = coauthoring.pendingExternalPaths.length;
    this.unreadableCount = coauthoring.unreadablePaths.length;
    this.externalStale = visible && coauthoring.stale;
  }

  /**
   * Co-authoring pills: where the open scenes stand relative to the disk (on disk / saving… /
   * held for an external version / autosave off), plus "stale" while play mode keeps an external
   * change from loading. Plan `.plans/external-agent-authoring.md` §5 C4.
   */
  private renderCoauthoringStatus() {
    const status = this.autosaveStatus;
    if (!status) {
      return html``;
    }
    const reason = this.autosaveReason ? `\n${this.autosaveReason}` : '';
    const last = this.autosaveLastAt
      ? `\nLast autosave ${new Date(this.autosaveLastAt).toLocaleTimeString()}.`
      : '';

    let tone = 'is-ok';
    let icon = 'hard-drive';
    let label = 'On disk';
    let title = `Every open scene is saved to the project folder.${last}`;
    switch (status) {
      case 'off':
        tone = 'is-off';
        icon = 'save';
        label = 'Autosave off';
        title = `Scenes are saved only with Save (Ctrl+S).${reason}\nClick to open Settings.`;
        break;
      case 'not-owner':
        tone = 'is-warn';
        icon = 'lock';
        label = 'Autosave: other window';
        title = `${this.autosaveReason ?? 'Another window owns this project.'}`;
        break;
      case 'dirty':
        tone = 'is-pending';
        icon = 'clock';
        label = 'Autosave…';
        title = `Unsaved edits; saving about a second after the last change.${last}`;
        break;
      case 'saving':
        tone = 'is-pending';
        icon = 'upload';
        label = 'Saving…';
        title = 'Writing the scene to the project folder.';
        break;
      case 'held':
        tone = 'is-warn';
        icon = 'pause-circle';
        label = this.unreadableCount > 0 ? 'File not readable' : 'Waiting for disk';
        title =
          'A newer version of an open scene is on disk (another tool or agent wrote it). ' +
          `Autosave waits until it has loaded; your edits stay protected.${reason}`;
        break;
      case 'error':
        tone = 'is-error';
        icon = 'alert-triangle';
        label = 'Autosave failed';
        title = `The last autosave failed; the next edit retries.${reason}`;
        break;
      default:
        break;
    }
    if (status === 'saved' && this.pendingExternalCount > 0) {
      tone = 'is-pending';
      icon = 'download';
      label = 'Loading changes…';
      title = `${this.pendingExternalCount} file(s) changed on disk; loading them.`;
    }

    return html`
      <button
        type="button"
        class="status-indicator status-sync status-autosave ${tone}"
        title=${title}
        aria-label=${`Autosave: ${label}`}
        @click=${this.onAutosaveIndicatorClick}
      >
        ${this.icons.getIcon(icon, IconSize.SMALL)}
        <span class="status-sync-label">${label}</span>
      </button>
      ${this.externalStale
        ? html`
            <span
              class="status-indicator status-sync status-stale is-warn"
              title="Files changed on disk while the game is running. They load when play stops."
            >
              ${this.icons.getIcon('alert-circle', IconSize.SMALL)}
              <span class="status-sync-label">Stale</span>
            </span>
          `
        : html``}
    `;
  }

  private onAutosaveIndicatorClick = (): void => {
    if (this.autosaveStatus === 'off') {
      void this.editorSettingsService.showSettings('general');
    }
  };

  private onWorkspaceIndicatorClick = (): void => {
    const workspace = appState.project.workspace;
    if (workspace.status === 'disconnected') {
      this.workspaceConnectDialog.open({
        endpoint: workspace.endpoint,
        errorMessage: workspace.errorMessage,
        workspaceName: appState.project.projectName,
        workspaceId: appState.project.id,
      });
      return;
    }
    if (workspace.lease === 'busy' || workspace.lease === 'lost') {
      this.workspaceSession.takeOverLease();
    }
  };

  private onSyncIndicatorClick = (): void => {
    void this.projectSyncService.showDialog();
  };

  private syncBridgeState(): void {
    this.bridgeAvailable = this.bridge.isAvailable();
    this.bridgeProviderCount = this.bridge.getEntries().length;
    void this.refreshDirectKeys();
  }

  private async refreshDirectKeys(): Promise<void> {
    try {
      const providers = this.llmProviders.listStatic().filter(provider => !provider.hidden);
      const labels = await Promise.all(
        providers.map(async provider =>
          (await this.agentSettings.hasApiKey(provider.id)) ? provider.label : null
        )
      );
      this.directKeyLabels = labels.filter((label): label is string => label !== null);
    } catch {
      // Secret storage unavailable (locked / non-DOM test env) — report "no key" rather than throw.
      this.directKeyLabels = [];
    }
  }

  private syncPerformanceProbe(): void {
    const shouldProbe = appState.ui.workspaceMode !== 'flow';
    if (shouldProbe === Boolean(this.disposePerformanceSubscription)) {
      return;
    }
    if (!shouldProbe) {
      this.disposePerformanceSubscription?.();
      this.disposePerformanceSubscription = undefined;
      return;
    }
    this.disposePerformanceSubscription = this.tabPerformanceService.subscribe(sample => {
      this.perfSample = sample;
    });
  }

  disconnectedCallback() {
    this.disposeLogListener?.();
    this.disposeProjectSubscription?.();
    this.disposeUiSubscription?.();
    this.disposeUpdateCheckSubscription?.();
    this.disposeDiagnosticsSubscription?.();
    this.disposePerformanceSubscription?.();
    this.disposeBridgeSubscription?.();
    this.disposeAgentSettingsSubscription?.();
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
                <span
                  class="status-message ${this.currentMessage.type}"
                  title=${this.currentMessage.text}
                >
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
          ${this.renderWorkspaceStatus()}
          <pix3-agent-channel-indicator></pix3-agent-channel-indicator>
          ${this.renderCoauthoringStatus()} ${this.renderSyncStatus()} ${this.renderAgentLanes()}
          ${this.isFlow ? html`` : this.renderPerformance()} ${this.renderDiagnostics()}
          ${this.projectName ? this.renderBundleSize() : html``}
          <span class="status-version">${this.updateState.currentVersion.displayVersion}</span>
          ${this.projectName
            ? html`<span class="status-project">${this.projectName}</span>`
            : html``}
        </div>
      </div>
    `;
  }

  /**
   * The two ways the agent can reach a model, side by side: the local Pix3AgentBridge (which owns
   * every metered provider's key) and the built-in provider keys this browser stores itself. Both
   * are one click from the place they are configured — a dead bridge or a missing key is otherwise only
   * discoverable by sending a prompt and reading the failure.
   */
  private renderAgentLanes() {
    const bridgeTitle = this.bridgeAvailable
      ? `Pix3AgentBridge connected — ${this.bridgeProviderCount} provider${
          this.bridgeProviderCount === 1 ? '' : 's'
        } available.\nKeys stay on your machine.\nClick to open Agent settings.`
      : 'Pix3AgentBridge not reachable — metered providers (OpenAI, Anthropic, Claude Code) are ' +
        'unavailable.\nStart it with `npx @pix3/agent-bridge`, then open its pairing link.\n' +
        'Click to open Agent settings.';
    const hasDirectKey = this.directKeyLabels.length > 0;
    const keyTitle = hasDirectKey
      ? `API key configured in this browser: ${this.directKeyLabels.join(', ')}.\nClick to open ` +
        'Agent settings.'
      : 'No built-in provider key stored in this browser (Gemini, OpenRouter).\nWithout one ' +
        '(and without the bridge) the agent and the asset generator cannot run.\nClick to ' +
        'open Agent settings.';

    return html`
      <button
        type="button"
        class="status-indicator status-lane ${this.bridgeAvailable ? 'is-on' : 'is-off'}"
        title=${bridgeTitle}
        @click=${this.onAgentLaneClick}
      >
        ${this.icons.getIcon('link', IconSize.SMALL)}
        <span class="status-lane-label">Bridge</span>
        <span class="status-lane-dot"></span>
      </button>
      <button
        type="button"
        class="status-indicator status-lane ${hasDirectKey ? 'is-on' : 'is-off'}"
        title=${keyTitle}
        @click=${this.onAgentLaneClick}
      >
        ${this.icons.getIcon('key', IconSize.SMALL)}
        <span class="status-lane-label"
          >${hasDirectKey ? this.directKeyLabels.join(' + ') : 'Keys'}</span
        >
        <span class="status-lane-dot"></span>
      </button>
    `;
  }

  private onAgentLaneClick = (): void => {
    void this.editorSettingsService.showSettings('agent');
  };

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
        ${this.icons.getIcon('bundle', IconSize.SMALL)} ${label}
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
