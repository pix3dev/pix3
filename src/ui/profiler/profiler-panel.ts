import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { svg } from 'lit';
import {
  type ProfilerAudioSnapshot,
  type ProfilerFrameImpactEntrySnapshot,
  type ProfilerFrameImpactSnapshot,
  ProfilerSessionService,
  type ProfilerCountersSnapshot,
  type ProfilerHistorySnapshot,
  type ProfilerPerformanceSnapshot,
  type ProfilerSessionSnapshot,
} from '@/services/play/ProfilerSessionService';
import {
  RemotePreviewTelemetryService,
  type RemotePlayerTelemetry,
} from '@/services/play/RemotePreviewTelemetryService';
import './profiler-panel.ts.css';
import '../shared/pix3-panel';

const IDLE_COPY = 'Profiler metrics appear here while Play mode is running.';
const REMOTE_IDLE_COPY = 'Waiting for metrics from the remote device…';
const FRAME_IMPACT_EMPTY_COPY = 'No frame activity breakdown reported by the active runtime yet.';
const AUDIO_EMPTY_COPY = 'No audio files have played in this session yet.';

/** selectedSource value for the local editor game session. */
const LOCAL_SOURCE = 'local';

@customElement('pix3-profiler-panel')
export class ProfilerPanel extends ComponentBase {
  @inject(ProfilerSessionService)
  private readonly profilerSessionService!: ProfilerSessionService;

  @inject(RemotePreviewTelemetryService)
  private readonly remotePreviewTelemetryService!: RemotePreviewTelemetryService;

  @state()
  private snapshot: ProfilerSessionSnapshot = {
    status: 'idle',
    performance: {
      fps: null,
      frameTimeMs: null,
      logicMs: null,
      renderMs: null,
      drawCalls: null,
      triangles: null,
      geometries: null,
      textures: null,
      jsHeapUsedMb: null,
    },
    counters: {
      elapsedMs: 0,
      frameCount: 0,
      hostKind: null,
    },
    history: {
      fps: [],
      frameTimeMs: [],
      logicMs: [],
      renderMs: [],
    },
    frameImpact: {
      activities: [],
      sampledFrameCount: 0,
      windowDurationMs: 0,
      totalFrameTimeMs: 0,
    },
    audio: {
      files: [],
      activeInstanceCount: 0,
    },
  };

  private disposeSubscription?: () => void;
  private disposeTelemetrySubscription?: () => void;
  private resizeObserver?: ResizeObserver;

  @state()
  private chartWidth = 320;

  @state()
  private selectedAudioKey: string | null = null;

  @state()
  private remotePlayers: readonly RemotePlayerTelemetry[] = [];

  @state()
  private selectedSource: string = LOCAL_SOURCE;

  /** True once the user picked a source explicitly; disables auto-switching. */
  private sourceManuallySelected = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeSubscription = this.profilerSessionService.subscribe(snapshot => {
      this.snapshot = snapshot;
      this.syncSelectedAudioKey(snapshot);
      this.syncSelectedSource();
      this.requestUpdate();
    });
    this.disposeTelemetrySubscription = this.remotePreviewTelemetryService.subscribe(players => {
      this.remotePlayers = players;
      this.syncSelectedSource();
      this.requestUpdate();
    });
  }

  disconnectedCallback(): void {
    this.disposeSubscription?.();
    this.disposeSubscription = undefined;
    this.disposeTelemetrySubscription?.();
    this.disposeTelemetrySubscription = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.startResizeObserver();
  }

  protected render() {
    const remotePlayer = this.getSelectedRemotePlayer();
    const snapshot = remotePlayer
      ? (this.remotePreviewTelemetryService.getProfilerSnapshot(remotePlayer.clientId) ??
        this.snapshot)
      : this.snapshot;
    const idleCopy = remotePlayer ? REMOTE_IDLE_COPY : IDLE_COPY;

    return html`
      <pix3-panel panel-description=${snapshot.status === 'idle' ? idleCopy : ''}>
        <div class="profiler-root">
          ${this.renderSourceSwitcher()}
          ${snapshot.status === 'idle'
            ? html`<p class="profiler-idle">${idleCopy}</p>`
            : html`
                ${this.renderCharts(snapshot.history, snapshot.performance)}
                ${this.renderSection(
                  'Performance',
                  this.renderPerformanceRows(snapshot.performance, remotePlayer)
                )}
                ${this.renderSection('Session', this.renderCounterRows(snapshot.counters))}
                ${remotePlayer
                  ? this.renderDeviceSection(remotePlayer)
                  : html`
                      ${this.renderAudioSection(snapshot.audio)}
                      ${this.renderFrameImpactSection(snapshot.frameImpact)}
                    `}
              `}
        </div>
      </pix3-panel>
    `;
  }

  private getSelectedRemotePlayer(): RemotePlayerTelemetry | null {
    if (this.selectedSource === LOCAL_SOURCE) {
      return null;
    }

    return this.remotePlayers.find(player => player.clientId === this.selectedSource) ?? null;
  }

  private syncSelectedSource(): void {
    if (this.selectedSource !== LOCAL_SOURCE && !this.getSelectedRemotePlayer()) {
      this.selectedSource = LOCAL_SOURCE;
      this.sourceManuallySelected = false;
    }

    if (this.sourceManuallySelected) {
      return;
    }

    // Follow the action: a local play session wins, otherwise show the first
    // live remote device (remote preview without local play).
    if (this.snapshot.status !== 'idle') {
      this.selectedSource = LOCAL_SOURCE;
      return;
    }

    if (this.selectedSource === LOCAL_SOURCE) {
      const liveRemote = this.remotePlayers.find(
        player => player.connected && player.lastSample !== null
      );
      if (liveRemote) {
        this.selectedSource = liveRemote.clientId;
      }
    }
  }

  private selectSource(source: string): void {
    this.sourceManuallySelected = true;
    this.selectedSource = source;
  }

  private renderSourceSwitcher() {
    if (this.remotePlayers.length === 0) {
      return null;
    }

    return html`
      <div class="profiler-source-switcher" role="group" aria-label="Metrics source">
        <button
          type="button"
          class="profiler-source-button ${this.selectedSource === LOCAL_SOURCE ? 'active' : ''}"
          aria-pressed=${String(this.selectedSource === LOCAL_SOURCE)}
          @click=${() => this.selectSource(LOCAL_SOURCE)}
        >
          Editor
        </button>
        ${this.remotePlayers.map(
          player => html`
            <button
              type="button"
              class="profiler-source-button ${this.selectedSource === player.clientId
                ? 'active'
                : ''} ${player.connected ? '' : 'profiler-source-button-offline'}"
              aria-pressed=${String(this.selectedSource === player.clientId)}
              title=${player.connected ? player.label : `${player.label} (offline)`}
              @click=${() => this.selectSource(player.clientId)}
            >
              ${player.label}
            </button>
          `
        )}
      </div>
    `;
  }

  private renderDeviceSection(player: RemotePlayerTelemetry) {
    const info = player.deviceInfo;
    const sample = player.lastSample;
    return html`
      <section class="profiler-section">
        <h3 class="profiler-section-title">Device</h3>
        <div class="profiler-grid">
          ${this.renderMetricRow('Status', player.connected ? 'connected' : 'offline')}
          ${info
            ? html`
                ${this.renderMetricRow('GPU', info.gpu ?? '—')}
                ${this.renderMetricRow(
                  'Screen',
                  `${info.screenWidth}×${info.screenHeight} @${info.devicePixelRatio}x`
                )}
                ${this.renderMetricRow('Viewport', `${info.viewportWidth}×${info.viewportHeight}`)}
                ${this.renderMetricRow(
                  'Memory',
                  info.deviceMemoryGb !== null ? `${info.deviceMemoryGb} GB` : '—'
                )}
                ${this.renderMetricRow('CPU cores', this.formatInteger(info.hardwareConcurrency))}
              `
            : this.renderMetricRow('Info', 'not reported')}
          ${sample && typeof sample.longFrameCount === 'number'
            ? this.renderMetricRow('Long frames/s', this.formatInteger(sample.longFrameCount))
            : null}
        </div>
      </section>
    `;
  }

  private renderSection(title: string, content: unknown) {
    return html`
      <section class="profiler-section">
        <h3 class="profiler-section-title">${title}</h3>
        <div class="profiler-grid">${content}</div>
      </section>
    `;
  }

  private renderPerformanceRows(
    snapshot: ProfilerPerformanceSnapshot,
    remotePlayer: RemotePlayerTelemetry | null = null
  ) {
    const remoteSample = remotePlayer?.lastSample ?? null;
    return html`
      ${this.renderMetricRow('FPS', this.formatInteger(snapshot.fps))}
      ${this.renderMetricRow('Frame', this.formatMilliseconds(snapshot.frameTimeMs))}
      ${remoteSample && typeof remoteSample.maxFrameMs === 'number'
        ? this.renderMetricRow('Max frame', this.formatMilliseconds(remoteSample.maxFrameMs))
        : null}
      ${this.renderMetricRow('Logic', this.formatMilliseconds(snapshot.logicMs))}
      ${this.renderMetricRow('Render', this.formatMilliseconds(snapshot.renderMs))}
      ${this.renderMetricRow('Draw calls', this.formatInteger(snapshot.drawCalls))}
      ${this.renderMetricRow('Triangles', this.formatInteger(snapshot.triangles))}
      ${this.renderMetricRow('Geometries', this.formatInteger(snapshot.geometries))}
      ${this.renderMetricRow('Textures', this.formatInteger(snapshot.textures))}
      ${this.renderMetricRow('JS heap', this.formatMegabytes(snapshot.jsHeapUsedMb))}
    `;
  }

  private renderCounterRows(snapshot: ProfilerCountersSnapshot) {
    return html`
      ${this.renderMetricRow('Elapsed', this.formatDuration(snapshot.elapsedMs))}
      ${this.renderMetricRow('Frames', this.formatInteger(snapshot.frameCount))}
      ${this.renderMetricRow('Host', snapshot.hostKind ?? '—')}
    `;
  }

  private renderMetricRow(label: string, value: string) {
    return html`
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
    `;
  }

  private renderAudioSection(snapshot: ProfilerAudioSnapshot) {
    const activeFileCount = snapshot.files.filter(file => file.isActive).length;
    const selectedFile = snapshot.files.find(file => file.key === this.selectedAudioKey) ?? null;
    const sectionMeta = [
      `${snapshot.files.length.toLocaleString('en-US')} files`,
      `${snapshot.activeInstanceCount.toLocaleString('en-US')} active`,
    ];
    if (activeFileCount > 0) {
      sectionMeta.push(`${activeFileCount.toLocaleString('en-US')} playing`);
    }

    return html`
      <section class="profiler-section profiler-audio-section">
        <div class="profiler-section-heading">
          <h3 class="profiler-section-title">Audio Files</h3>
          <span class="profiler-section-meta">${sectionMeta.join(' · ')}</span>
        </div>
        <p class="profiler-section-note">
          One tile per audio file. Green means the file is playing now; gray means it played earlier
          in this session.
        </p>
        ${snapshot.files.length === 0
          ? html`<p class="profiler-empty-state">${AUDIO_EMPTY_COPY}</p>`
          : html`
              <div class="audio-file-grid" role="list" aria-label="Audio files played this session">
                ${snapshot.files.map(file => this.renderAudioFileCard(file))}
              </div>
              ${selectedFile ? this.renderAudioDetails(selectedFile) : null}
            `}
      </section>
    `;
  }

  private renderAudioFileCard(file: ProfilerAudioSnapshot['files'][number]) {
    const isSelected = this.selectedAudioKey === file.key;
    const stateCopy = file.isActive ? 'playing' : 'idle';
    const className = [
      'audio-file-card',
      file.isActive ? 'audio-file-card-active' : 'audio-file-card-inactive',
      isSelected ? 'audio-file-card-selected' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return html`
      <button
        type="button"
        class=${className}
        role="listitem"
        data-audio-key=${file.key}
        aria-pressed=${isSelected ? 'true' : 'false'}
        title=${file.resourcePath ?? file.label}
        @click=${() => this.toggleAudioSelection(file.key)}
      >
        <span class="audio-file-count">${file.activeInstanceCount.toLocaleString('en-US')}</span>
        <span class="audio-file-name" title=${file.label}>${file.label}</span>
        <span class="audio-file-state">${stateCopy}</span>
      </button>
    `;
  }

  private renderAudioDetails(file: ProfilerAudioSnapshot['files'][number]) {
    const playbackRows = file.currentInstances.length > 0 ? file.currentInstances : [];
    const fallbackPlayback = playbackRows.length === 0 ? file.lastPlayback : null;

    return html`
      <div class="audio-detail-card">
        <div class="audio-detail-header">
          <div>
            <h4 class="audio-detail-title">${file.label}</h4>
            ${file.resourcePath
              ? html`<p class="audio-detail-subtitle">${file.resourcePath}</p>`
              : null}
          </div>
          <span
            class=${`audio-detail-badge ${file.isActive ? 'audio-detail-badge-active' : 'audio-detail-badge-idle'}`}
            >${file.isActive ? 'active' : 'inactive'}</span
          >
        </div>
        <div class="audio-detail-grid">
          ${this.renderAudioDetailRow('Name', file.label)}
          ${this.renderAudioDetailRow('Bitrate', this.formatAudioBitrate(file.bitrateKbps))}
          ${this.renderAudioDetailRow(
            'Duration',
            this.formatAudioClipDuration(file.durationSeconds)
          )}
          ${this.renderAudioDetailRow(
            'Active Instances',
            file.activeInstanceCount.toLocaleString('en-US')
          )}
          ${this.renderAudioDetailRow('Sample Rate', this.formatAudioSampleRate(file.sampleRate))}
          ${this.renderAudioDetailRow('Channels', this.formatInteger(file.channelCount))}
        </div>
        <div class="audio-detail-playback-section">
          <div class="audio-detail-playback-heading">
            ${playbackRows.length > 0 ? 'Playback Params' : 'Last Playback Params'}
          </div>
          ${playbackRows.length > 0
            ? html`
                <div class="audio-detail-playback-list">
                  ${playbackRows.map((instance, index) =>
                    this.renderAudioPlaybackDetails(instance, `Instance ${index + 1}`)
                  )}
                </div>
              `
            : fallbackPlayback
              ? html`
                  <div class="audio-detail-playback-list">
                    ${this.renderAudioPlaybackDetails(fallbackPlayback, 'Last seen')}
                  </div>
                `
              : html`<p class="profiler-empty-state">No playback details captured yet.</p>`}
        </div>
      </div>
    `;
  }

  private renderAudioDetailRow(label: string, value: string) {
    return html`
      <div class="audio-detail-label">${label}</div>
      <div class="audio-detail-value">${value}</div>
    `;
  }

  private renderAudioPlaybackDetails(
    instance: ProfilerAudioSnapshot['files'][number]['currentInstances'][number],
    label: string
  ) {
    const panLabel = this.formatAudioPan(instance.pan);

    return html`
      <div class="audio-detail-playback-row">
        <div class="audio-detail-playback-row-header">
          <span class="audio-detail-playback-row-title">${label}</span>
          <span class="audio-detail-playback-row-age"
            >${this.formatAudioElapsed(instance.elapsedMs)}</span
          >
        </div>
        <div class="audio-detail-playback-chips">
          <span class="audio-instance-chip">${this.formatAudioVolume(instance.volume)}</span>
          <span class="audio-instance-chip">${this.formatAudioRate(instance.playbackRate)}</span>
          ${panLabel ? html`<span class="audio-instance-chip">${panLabel}</span>` : null}
          ${instance.loop
            ? html`<span class="audio-instance-chip audio-instance-chip-loop">loop</span>`
            : null}
        </div>
      </div>
    `;
  }

  private renderFrameImpactSection(snapshot: ProfilerFrameImpactSnapshot) {
    const sampledFrameCountLabel = `${snapshot.sampledFrameCount.toLocaleString('en-US')}f`;
    return html`
      <section class="profiler-section profiler-impact-section">
        <div class="profiler-section-heading">
          <h3 class="profiler-section-title">Frame Impact</h3>
          <span class="profiler-section-meta"
            >${this.formatImpactWindow(snapshot.windowDurationMs)} · ${sampledFrameCountLabel}</span
          >
        </div>
        <p class="profiler-section-note">
          100% = full frame time inside this window. Count = frames where the activity appeared.
          Runtime rows are added automatically.
        </p>
        ${snapshot.activities.length === 0
          ? html`<p class="profiler-empty-state">${FRAME_IMPACT_EMPTY_COPY}</p>`
          : html`
              <div class="frame-impact-table" role="table" aria-label="Frame impact table">
                <div class="frame-impact-row frame-impact-row-header" role="row">
                  <div class="frame-impact-header-cell" role="columnheader">Self (% · ms)</div>
                  <div class="frame-impact-header-cell" role="columnheader">Total (% · ms)</div>
                  <div class="frame-impact-header-cell" role="columnheader">
                    Activity · count/${sampledFrameCountLabel}
                  </div>
                </div>
                ${snapshot.activities.map(activity => this.renderFrameImpactRow(activity))}
              </div>
            `}
      </section>
    `;
  }

  private renderFrameImpactRow(activity: ProfilerFrameImpactEntrySnapshot) {
    return html`
      <div class="frame-impact-row" role="row">
        <div class="frame-impact-cell" role="cell">
          ${this.renderFrameImpactValue(activity.selfPercent, activity.selfTimeMs, 'self')}
        </div>
        <div class="frame-impact-cell" role="cell">
          ${this.renderFrameImpactValue(activity.totalPercent, activity.totalTimeMs, 'total')}
        </div>
        <div class="frame-impact-cell frame-impact-cell-activity" role="cell">
          <span class="frame-impact-activity-label">${activity.label}</span>
          <span class="frame-impact-activity-meta"
            >${this.formatInteger(activity.sampleCount)}</span
          >
        </div>
      </div>
    `;
  }

  private renderFrameImpactValue(
    percent: number | null,
    timeMs: number,
    variant: 'self' | 'total'
  ) {
    return html`
      <div class="frame-impact-meter frame-impact-meter-${variant}">
        <div class="frame-impact-meter-fill" style=${`width: ${this.toCssPercent(percent)}`}></div>
        <div class="frame-impact-meter-content" title=${this.formatPercent(percent)}>
          <span class="frame-impact-primary">${this.formatPercent(percent)}</span>
          <span class="frame-impact-secondary">${this.formatImpactMilliseconds(timeMs)}</span>
        </div>
      </div>
    `;
  }

  private renderCharts(history: ProfilerHistorySnapshot, performance: ProfilerPerformanceSnapshot) {
    return html`
      <section class="profiler-charts">
        ${this.renderChartCard(
          'FPS',
          `${history.fps.length} samples`,
          this.formatInteger(performance.fps),
          this.renderLineChart(history.fps, 120, 'fps-line')
        )}
        ${this.renderChartCard(
          'Frame Breakdown',
          'logic + render',
          this.formatMilliseconds(performance.frameTimeMs),
          this.renderStackedBreakdownChart(history.logicMs, history.renderMs, 24)
        )}
      </section>
    `;
  }

  private renderChartCard(title: string, subtitle: string, value: string, chart: unknown) {
    return html`
      <div class="chart-card">
        <div class="chart-card-header">
          <div>
            <h3 class="chart-title">${title}</h3>
            <p class="chart-subtitle">${subtitle}</p>
          </div>
          <div class="chart-current-value">${value}</div>
        </div>
        ${title === 'Frame Breakdown'
          ? html`
              <div class="chart-legend" aria-label="Frame breakdown legend">
                <span class="chart-legend-item">
                  <span class="chart-legend-swatch chart-legend-swatch-logic"></span>
                  <span>Logic</span>
                </span>
                <span class="chart-legend-item">
                  <span class="chart-legend-swatch chart-legend-swatch-render"></span>
                  <span>Render</span>
                </span>
              </div>
            `
          : null}
        <div class="chart-surface">${chart}</div>
      </div>
    `;
  }

  private toggleAudioSelection(key: string) {
    this.selectedAudioKey = this.selectedAudioKey === key ? null : key;
  }

  private renderLineChart(values: readonly number[], maxValue: number, lineClass: string) {
    if (values.length === 0) {
      return html`<div class="chart-empty">Waiting for frame samples…</div>`;
    }

    const chartValues = this.resampleSeries(values, this.chartWidth);
    const viewBoxWidth = Math.max(chartValues.length - 1, 1);
    const points = chartValues
      .map((value, index) => {
        const x = chartValues.length === 1 ? 0 : (index / (chartValues.length - 1)) * viewBoxWidth;
        const y = 100 - this.normalizeChartValue(value, maxValue) * 100;
        return `${x},${y}`;
      })
      .join(' ');
    const areaPoints = `0,100 ${points} ${viewBoxWidth},100`;

    return svg`
      <svg
        class="chart-svg"
        viewBox=${`0 0 ${viewBoxWidth} 100`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polyline class="chart-grid-line" points=${`0,75 ${viewBoxWidth},75`}></polyline>
        <polyline class="chart-grid-line" points=${`0,50 ${viewBoxWidth},50`}></polyline>
        <polyline class="chart-grid-line" points=${`0,25 ${viewBoxWidth},25`}></polyline>
        <polygon class="chart-area" points=${areaPoints}></polygon>
        <polyline class=${lineClass} points=${points}></polyline>
      </svg>
    `;
  }

  private renderStackedBreakdownChart(
    logicValues: readonly number[],
    renderValues: readonly number[],
    maxValue: number
  ) {
    if (logicValues.length === 0 || renderValues.length === 0) {
      return html`<div class="chart-empty">Waiting for frame samples…</div>`;
    }

    const resampledLogic = this.resampleSeries(logicValues, this.chartWidth);
    const resampledRender = this.resampleSeries(renderValues, this.chartWidth);
    const sampleCount = Math.min(resampledLogic.length, resampledRender.length);

    // Two step-outline polygons (render band + logic band stacked on top of it)
    // instead of two <rect> per column: per-column rects meant thousands of SVG
    // attribute writes per update once frame times got noisy, which itself
    // dragged the frame rate down. A step polygon rasterizes to the exact same
    // 1px-column bars but costs a single `points` write per series.
    const renderTop: number[] = new Array(sampleCount);
    const totalTop: number[] = new Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      const logicValue = resampledLogic[index] ?? 0;
      const renderValue = resampledRender[index] ?? 0;
      renderTop[index] = 100 - this.normalizeChartValue(renderValue, maxValue) * 100;
      totalTop[index] = 100 - this.normalizeChartValue(logicValue + renderValue, maxValue) * 100;
    }
    const renderPoints = `0,100 ${this.stepEdgePoints(renderTop)} ${sampleCount},100`;
    const logicPoints = `${this.stepEdgePoints(totalTop)} ${this.stepEdgePoints(renderTop, true)}`;

    return svg`
      <svg
        class="chart-svg"
        viewBox=${`0 0 ${sampleCount} 100`}
        preserveAspectRatio="none"
        aria-hidden="true"
        shape-rendering="crispEdges"
      >
        <polyline class="chart-grid-line" points=${`0,75 ${sampleCount},75`}></polyline>
        <polyline class="chart-grid-line" points=${`0,50 ${sampleCount},50`}></polyline>
        <polyline class="chart-grid-line" points=${`0,25 ${sampleCount},25`}></polyline>
        <polygon class="chart-bar chart-bar-render" points=${renderPoints}></polygon>
        <polygon class="chart-bar chart-bar-logic" points=${logicPoints}></polygon>
      </svg>
    `;
  }

  /**
   * Staircase edge through per-column values: column i contributes the segment
   * (i, y[i]) → (i+1, y[i]). `reverse` walks it right-to-left for closing a
   * band polygon against the edge below it.
   */
  private stepEdgePoints(columnY: readonly number[], reverse = false): string {
    const parts: string[] = [];
    for (let index = 0; index < columnY.length; index += 1) {
      const y = round2(columnY[index] ?? 100);
      parts.push(`${index},${y} ${index + 1},${y}`);
    }
    if (reverse) {
      parts.reverse();
    }
    return parts.join(' ');
  }

  private resampleSeries(values: readonly number[], targetColumns: number): number[] {
    if (values.length <= 1) {
      return values.length === 0 ? [] : [values[0] ?? 0];
    }

    const columnCount = Math.max(1, Math.min(Math.floor(targetColumns), values.length));
    if (columnCount >= values.length) {
      return [...values];
    }

    const result: number[] = [];
    for (let column = 0; column < columnCount; column += 1) {
      const start = Math.floor((column / columnCount) * values.length);
      const end = Math.max(start + 1, Math.floor(((column + 1) / columnCount) * values.length));
      let sum = 0;
      let count = 0;
      for (let index = start; index < end; index += 1) {
        const value = values[index] ?? 0;
        sum += value;
        count += 1;
      }
      result.push(count > 0 ? sum / count : 0);
    }

    return result;
  }

  private startResizeObserver(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      this.updateChartWidth();
    });
    this.resizeObserver.observe(this);
    this.updateChartWidth();
  }

  private updateChartWidth(): void {
    const surface = this.querySelector('.chart-surface') as HTMLElement | null;
    const nextWidth = Math.max(120, Math.floor(surface?.clientWidth ?? this.clientWidth - 24));
    if (nextWidth !== this.chartWidth) {
      this.chartWidth = nextWidth;
    }
  }

  private normalizeChartValue(value: number, maxValue: number): number {
    if (!Number.isFinite(value) || value <= 0 || maxValue <= 0) {
      return 0;
    }

    return Math.min(value / maxValue, 1);
  }

  private formatInteger(value: number | null): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '—';
    }

    return Math.round(value).toLocaleString('en-US');
  }

  private formatMilliseconds(value: number | null): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '—';
    }

    return `${value.toFixed(1)} ms`;
  }

  private formatPercent(value: number | null): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '—';
    }

    return `${value.toFixed(1)}%`;
  }

  private formatImpactMilliseconds(value: number | null): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '—';
    }

    if (value < 1) {
      return `${value.toFixed(2)} ms`;
    }

    if (value < 100) {
      return `${value.toFixed(1)} ms`;
    }

    return `${Math.round(value).toLocaleString('en-US')} ms`;
  }

  private formatAudioElapsed(value: number): string {
    if (!Number.isFinite(value) || value < 0) {
      return '—';
    }

    if (value < 1000) {
      return `${Math.round(value).toLocaleString('en-US')} ms`;
    }

    if (value < 10000) {
      return `${(value / 1000).toFixed(1)} s`;
    }

    return `${Math.round(value / 1000).toLocaleString('en-US')} s`;
  }

  private formatAudioBitrate(value: number | null): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return '—';
    }

    if (value >= 1000) {
      return `${(value / 1000).toFixed(2)} Mbps`;
    }

    return `${Math.round(value).toLocaleString('en-US')} kbps`;
  }

  private formatAudioClipDuration(value: number | null): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return '—';
    }

    if (value < 10) {
      return `${value.toFixed(2)} s`;
    }

    if (value < 60) {
      return `${value.toFixed(1)} s`;
    }

    const totalSeconds = Math.round(value);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private formatAudioSampleRate(value: number | null): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return '—';
    }

    const khz = value / 1000;
    return `${khz % 1 === 0 ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
  }

  private formatAudioVolume(value: number): string {
    if (!Number.isFinite(value) || value < 0) {
      return 'vol —';
    }

    return `vol ${Math.round(value * 100).toLocaleString('en-US')}%`;
  }

  private formatAudioRate(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
      return 'rate —';
    }

    return `rate ${value.toFixed(2)}x`;
  }

  private formatAudioPan(value: number | null): string | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    return `pan ${value.toFixed(2)}`;
  }

  private syncSelectedAudioKey(snapshot: ProfilerSessionSnapshot): void {
    if (snapshot.status === 'idle' || snapshot.audio.files.length === 0) {
      this.selectedAudioKey = null;
      return;
    }

    if (!this.selectedAudioKey) {
      return;
    }

    if (!snapshot.audio.files.some(file => file.key === this.selectedAudioKey)) {
      this.selectedAudioKey = null;
    }
  }

  private formatMegabytes(value: number | null): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '—';
    }

    return `${value.toFixed(1)} MB`;
  }

  private formatDuration(elapsedMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private formatImpactWindow(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
      return '0.0 s';
    }

    return `${(value / 1000).toFixed(1)} s`;
  }

  private toCssPercent(value: number | null): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return '0%';
    }

    return `${Math.min(value, 100).toFixed(2)}%`;
  }
}

/** Round to 2 decimals — keeps chart `points` strings short and stable. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-profiler-panel': ProfilerPanel;
  }
}
