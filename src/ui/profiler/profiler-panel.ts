import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { svg } from 'lit';
import {
  type ProfilerFrameImpactEntrySnapshot,
  type ProfilerFrameImpactSnapshot,
  ProfilerSessionService,
  type ProfilerCountersSnapshot,
  type ProfilerHistorySnapshot,
  type ProfilerPerformanceSnapshot,
  type ProfilerSessionSnapshot,
} from '@/services';
import './profiler-panel.ts.css';
import '../shared/pix3-panel';

const IDLE_COPY = 'Profiler metrics appear here while Play mode is running.';
const FRAME_IMPACT_EMPTY_COPY = 'No frame activity breakdown reported by the active runtime yet.';

@customElement('pix3-profiler-panel')
export class ProfilerPanel extends ComponentBase {
  @inject(ProfilerSessionService)
  private readonly profilerSessionService!: ProfilerSessionService;

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
    },
  };

  private disposeSubscription?: () => void;
  private resizeObserver?: ResizeObserver;

  @state()
  private chartWidth = 320;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeSubscription = this.profilerSessionService.subscribe(snapshot => {
      this.snapshot = snapshot;
      this.requestUpdate();
    });
  }

  disconnectedCallback(): void {
    this.disposeSubscription?.();
    this.disposeSubscription = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.startResizeObserver();
  }

  protected render() {
    return html`
      <pix3-panel panel-description=${this.snapshot.status === 'idle' ? IDLE_COPY : ''}>
        <div class="profiler-root">
          ${this.snapshot.status === 'idle'
            ? html`<p class="profiler-idle">${IDLE_COPY}</p>`
            : html`
                ${this.renderCharts(this.snapshot.history, this.snapshot.performance)}
                ${this.renderSection(
                  'Performance',
                  this.renderPerformanceRows(this.snapshot.performance)
                )}
                ${this.renderSection('Session', this.renderCounterRows(this.snapshot.counters))}
                ${this.renderFrameImpactSection(this.snapshot.frameImpact)}
              `}
        </div>
      </pix3-panel>
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

  private renderPerformanceRows(snapshot: ProfilerPerformanceSnapshot) {
    return html`
      ${this.renderMetricRow('FPS', this.formatInteger(snapshot.fps))}
      ${this.renderMetricRow('Frame', this.formatMilliseconds(snapshot.frameTimeMs))}
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
                  <div class="frame-impact-header-cell" role="columnheader"
                    >Activity · count/${sampledFrameCountLabel}</div
                  >
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
          <span class="frame-impact-activity-meta">${this.formatInteger(activity.sampleCount)}</span>
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
        <div
          class="frame-impact-meter-fill"
          style=${`width: ${this.toCssPercent(percent)}`}
        ></div>
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
    const bars = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const logicValue = resampledLogic[index] ?? 0;
      const renderValue = resampledRender[index] ?? 0;
      const totalHeight = this.normalizeChartValue(logicValue + renderValue, maxValue) * 100;
      const renderHeight = this.normalizeChartValue(renderValue, maxValue) * 100;
      const logicHeight = this.normalizeChartValue(logicValue, maxValue) * 100;
      const x = index;
      const width = 1;
      bars.push(svg`
        <rect
          class="chart-bar chart-bar-render"
          x=${x}
          y=${100 - renderHeight}
          width=${width}
          height=${renderHeight}
        ></rect>
        <rect
          class="chart-bar chart-bar-logic"
          x=${x}
          y=${100 - totalHeight}
          width=${width}
          height=${logicHeight}
        ></rect>
      `);
    }

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
        ${bars}
      </svg>
    `;
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

declare global {
  interface HTMLElementTagNameMap {
    'pix3-profiler-panel': ProfilerPanel;
  }
}
