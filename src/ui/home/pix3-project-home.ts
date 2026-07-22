import { ComponentBase, customElement, html, inject, state, subscribe } from '@/fw';
import { nothing } from 'lit';
import './pix3-project-home.ts.css';
import { appState } from '@/state';
import { IconService } from '@/services/editor/IconService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { LayoutManagerService } from '@/core/LayoutManager';
import { FileSystemAPIService } from '@/services/project/FileSystemAPIService';
import { DialogService } from '@/services/editor/DialogService';
import { AgentChatService } from '@/services/agent/AgentChatService';
import {
  ProjectHomeService,
  type ProjectHomeData,
  type HomeSceneEntry,
  type HomeChecklistItem,
  type ChecklistAction,
} from '@/services/project/ProjectHomeService';

const AGENT_CHIPS = [
  'Set up the main game loop',
  'Balance enemy waves from the GDD',
  'Generate placeholder sprites',
  'Wire up the HUD scene',
] as const;

/** Deterministic hue per scene name so placeholder thumbnails stay stable. */
const hueFor = (name: string): number => {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360;
  }
  return hash;
};

/**
 * Project Home — the pinned first tab of the editor's document area. An
 * onboarding dashboard shown when a project is opened: hero actions, an agent
 * prompt, the scene grid, recent activity, and a right rail (GDD, setup
 * checklist, at-a-glance stats). Lives in the `background` layout slot, so it is
 * always present and non-closable; scenes open as tabs beside it.
 */
@customElement('pix3-project-home')
export class Pix3ProjectHome extends ComponentBase {
  @inject(ProjectHomeService)
  private readonly homeService!: ProjectHomeService;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @inject(FileSystemAPIService)
  private readonly fileSystem!: FileSystemAPIService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(AgentChatService)
  private readonly agentChat!: AgentChatService;

  @inject(IconService)
  private readonly icons!: IconService;

  @state()
  private data: ProjectHomeData | null = null;

  @state()
  private loading = true;

  @state()
  private agentInput = '';

  /** Rendered scene thumbnails, keyed by scene path. */
  @state()
  private thumbs: Record<string, string> = {};

  @state()
  private newSceneMenuOpen = false;

  private disposeProject?: () => void;
  private disposeScenes?: () => void;
  private refreshInFlight = false;
  private refreshQueued = false;
  private thumbsInFlight = false;
  private readonly handleActivate = () => void this.refresh();
  private readonly handleDocumentClick = (event: MouseEvent) => {
    if (!this.newSceneMenuOpen) return;
    const target = event.target as Node;
    const menu = this.querySelector('.ph-newscene');
    if (menu && !menu.contains(target)) this.newSceneMenuOpen = false;
  };

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    this.disposeProject = subscribe(appState.project, () => void this.refresh());
    this.disposeScenes = subscribe(appState.scenes, () => void this.refresh());
    window.addEventListener('pix3-project-home:activate', this.handleActivate);
    document.addEventListener('click', this.handleDocumentClick);
  }

  disconnectedCallback(): void {
    this.disposeProject?.();
    this.disposeProject = undefined;
    this.disposeScenes?.();
    this.disposeScenes = undefined;
    window.removeEventListener('pix3-project-home:activate', this.handleActivate);
    document.removeEventListener('click', this.handleDocumentClick);
    super.disconnectedCallback();
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInFlight = true;
    try {
      const next = await this.homeService.load();
      this.data = next;
      void this.loadThumbnails(next.scenes);
    } catch {
      // Keep the previous snapshot on failure; never blank the dashboard.
    } finally {
      this.loading = false;
      this.refreshInFlight = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  /** Lazily fill in scene thumbnails one at a time (cache-first, off the hot path). */
  private async loadThumbnails(scenes: HomeSceneEntry[]): Promise<void> {
    if (this.thumbsInFlight) return;
    this.thumbsInFlight = true;
    try {
      for (const scene of scenes) {
        if (this.thumbs[scene.path]) continue;
        const url = await this.homeService.getSceneThumbnail(scene);
        if (url) this.thumbs = { ...this.thumbs, [scene.path]: url };
      }
    } finally {
      this.thumbsInFlight = false;
    }
  }

  // ---- actions -------------------------------------------------------------

  private openScene(resourceId: string): void {
    void this.editorTabService.focusOrOpenScene(resourceId);
  }

  private openMainScene(): void {
    const main = this.data?.mainScenePath;
    if (main) {
      this.openScene(this.homeService.toResourceId(main));
      return;
    }
    const first = this.data?.scenes[0];
    if (first) this.openScene(first.resourceId);
  }

  private continueSession(): void {
    const projectId = appState.project.id;
    if (!projectId) return;
    void this.editorTabService.restoreProjectSession(projectId);
  }

  private async runAgent(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (!text) return;
    this.agentInput = '';
    this.layoutManager.revealAgentPanel();
    try {
      await this.agentChat.ensureLoaded();
      await this.agentChat.send(text);
    } catch {
      // The agent panel surfaces provider/config errors itself.
    }
  }

  private fillAgentInput(text: string): void {
    this.agentInput = text;
    void this.updateComplete.then(() => {
      const input = this.querySelector<HTMLInputElement>('.ph-agent__input');
      input?.focus();
    });
  }

  private onAgentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.runAgent(this.agentInput);
    }
  }

  private async createScene(kind: 'blank' | 'template'): Promise<void> {
    const is2d = appState.project.manifest?.projectType !== '3d';
    const { width, height } = appState.project.manifest?.viewportBaseSize ?? {
      width: 1920,
      height: 1080,
    };
    try {
      const dir = 'src/assets/scenes';
      await this.fileSystem.createDirectory(`res://${dir}`).catch(() => undefined);
      const name = await this.nextSceneName(dir);
      const resourceId = `res://${dir}/${name}.pix3scene`;
      await this.fileSystem.writeTextFile(
        resourceId,
        this.sceneTemplate(kind, is2d, width, height, name)
      );
      appState.project.fileRefreshSignal += 1;
      this.openScene(resourceId);
    } catch (error) {
      await this.dialogService.showConfirmation({
        title: 'Could not create scene',
        message: error instanceof Error ? error.message : 'Failed to create the scene file.',
        confirmLabel: 'OK',
        cancelLabel: '',
      });
    }
  }

  private async nextSceneName(dir: string): Promise<string> {
    let existing = new Set<string>();
    try {
      const entries = await this.fileSystem.listDirectory(`res://${dir}`);
      existing = new Set(entries.map(e => e.name.toLowerCase()));
    } catch {
      // directory may not exist yet
    }
    const base = 'new-scene';
    if (!existing.has(`${base}.pix3scene`)) return base;
    let n = 2;
    while (existing.has(`${base}-${n}.pix3scene`)) n += 1;
    return `${base}-${n}`;
  }

  private sceneTemplate(
    kind: 'blank' | 'template',
    is2d: boolean,
    width: number,
    height: number,
    name: string
  ): string {
    const header = `# Pix3 Scene File (YAML)\nversion: 1.0.0\nmetadata:\n  description: ${name}\n`;
    if (is2d) {
      const children =
        kind === 'template'
          ? `\n    children:\n      - id: background\n        type: ColorRect2D\n        name: Background\n        properties:\n          width: ${width}\n          height: ${height}\n          color: "#1a1a2e"\n        children: []`
          : '\n    children: []';
      return `${header}root:\n  - id: root\n    type: Group2D\n    name: Root\n    properties:\n      width: ${width}\n      height: ${height}${children}\n`;
    }
    const children =
      kind === 'template'
        ? `\n    children:\n      - id: camera\n        type: Camera3D\n        name: Camera\n        properties:\n          transform:\n            position: [0, 2, 8]\n            rotationEuler: [-10, 0, 0]\n            scale: [1, 1, 1]\n        children: []`
        : '\n    children: []';
    return `${header}root:\n  - id: root\n    type: Node3D\n    name: Root\n    properties:\n      transform:\n        position: [0, 0, 0]\n        rotationEuler: [0, 0, 0]\n        scale: [1, 1, 1]${children}\n`;
  }

  private openGdd(): void {
    const gdd = this.data?.gdd;
    if (gdd) void this.editorTabService.focusOrOpenCode(this.homeService.toResourceId(gdd.path));
  }

  private runChecklistAction(action: ChecklistAction): void {
    switch (action) {
      case 'draft-gdd':
        void this.runAgent(
          'Draft a Game Design Document for this project at design/gdd.md, covering the core loop, enemies & waves, economy, progression and levels.'
        );
        return;
      case 'add-script':
        void this.runAgent(
          'Add a gameplay script to the main scene that drives the core loop, and attach it to the appropriate node.'
        );
        return;
      case 'invite':
        void this.dialogService.showConfirmation({
          title: 'Share with the team',
          message:
            appState.project.backend === 'cloud'
              ? 'Invite teammates from the cloud project sharing settings.'
              : 'Team collaboration is available for cloud projects. Move this project to the cloud to invite teammates.',
          confirmLabel: 'OK',
          cancelLabel: '',
        });
        return;
    }
  }

  // ---- rendering -----------------------------------------------------------

  protected render() {
    const data = this.data;
    if (!data && this.loading) {
      return html`<div class="ph-root ph-root--loading">Loading project…</div>`;
    }
    if (!data) {
      return html`<div class="ph-root ph-root--loading">No project loaded.</div>`;
    }

    const dateLabel = new Date().toLocaleDateString(undefined, { weekday: 'long' });

    return html`
      <div class="ph-root">
        <div class="ph-content">
          ${this.renderHero(data, dateLabel)} ${this.renderAgentCard()}
          <div class="ph-grid">
            <div class="ph-main">${this.renderScenes(data)} ${this.renderActivity(data)}</div>
            <div class="ph-rail">
              ${this.renderGdd(data)} ${this.renderChecklist(data)} ${this.renderAtAGlance(data)}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderHero(data: ProjectHomeData, dateLabel: string) {
    const canOpenMain = data.mainScenePath !== null || data.scenes.length > 0;
    return html`
      <div class="ph-hero">
        <div class="ph-hero__title">
          <div class="ph-hero__sub">${dateLabel} · picking up where you left off</div>
          <h1 class="ph-hero__name">${data.projectName}</h1>
        </div>
        ${canOpenMain
          ? html`<button class="ph-btn ph-btn--primary" @click=${() => this.openMainScene()}>
              ${this.icons.getIcon('play', 15)} Open main scene
            </button>`
          : nothing}
        ${data.hasSession
          ? html`<button class="ph-btn" @click=${() => this.continueSession()}>
              ${this.icons.getIcon('refresh-cw', 15)} Continue last session
            </button>`
          : nothing}
      </div>
    `;
  }

  private renderAgentCard() {
    return html`
      <div class="ph-card ph-agent">
        <div class="ph-agent__head">
          <span class="ph-agent__spark">${this.icons.getIcon('sparkles', 15)}</span>
          <span class="ph-agent__label">Agent</span>
          <span class="ph-agent__hint">knows your project, GDD and scenes</span>
        </div>
        <div class="ph-agent__field focus-within-ring">
          <input
            class="ph-agent__input"
            type="text"
            placeholder="Describe a task — e.g. “add a wave of fast enemies to the main scene”"
            .value=${this.agentInput}
            @input=${(e: Event) => (this.agentInput = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => this.onAgentKeydown(e)}
          />
          <kbd class="ph-kbd">⏎</kbd>
          <button
            class="ph-btn ph-btn--primary ph-btn--sm"
            ?disabled=${this.agentInput.trim().length === 0}
            @click=${() => this.runAgent(this.agentInput)}
          >
            Run
          </button>
        </div>
        <div class="ph-agent__chips">
          ${AGENT_CHIPS.map(
            chip =>
              html`<button class="ph-pill ph-pill--ghost" @click=${() => this.fillAgentInput(chip)}>
                ${chip}
              </button>`
          )}
        </div>
      </div>
    `;
  }

  private renderScenes(data: ProjectHomeData) {
    return html`
      <div class="ph-section-head">
        <h2 class="ph-h2">Scenes</h2>
        <span class="ph-count mono">${data.scenes.length}</span>
        ${data.scenes.length > 0
          ? html`<span class="ph-section-head__note">sorted by last edited</span>`
          : nothing}
      </div>
      ${data.scenes.length === 0
        ? html`<div class="ph-empty">
            No scenes yet. Create your first scene to start building.
          </div>`
        : nothing}
      <div class="ph-scenes">
        ${data.scenes.map(scene => this.renderSceneCard(scene))} ${this.renderNewSceneCard()}
      </div>
    `;
  }

  private renderSceneCard(scene: HomeSceneEntry) {
    const hue = hueFor(scene.name);
    const thumb = this.thumbs[scene.path];
    return html`
      <button class="ph-scene" @click=${() => this.openScene(scene.resourceId)}>
        ${thumb
          ? html`<img class="ph-scene__thumb" src=${thumb} alt="" aria-hidden="true" />`
          : html`<div
              class="ph-scene__thumb ph-scene__thumb--placeholder viewport-grid"
              style=${`--ph-hue:${hue}`}
              aria-hidden="true"
            ></div>`}
        <div class="ph-scene__body">
          <div class="ph-scene__name-row">
            <span class="ph-scene__name">${scene.name}</span>
            ${scene.isMain ? html`<span class="ph-pill ph-pill--accent">Main</span>` : nothing}
            ${scene.isDraft ? html`<span class="ph-pill ph-pill--neutral">Draft</span>` : nothing}
          </div>
          <div class="ph-scene__meta">
            <span class="mono">${scene.nodeCount} nodes</span>
            <span>·</span>
            <span>${this.relativeTime(scene.modifiedAt)}</span>
          </div>
        </div>
      </button>
    `;
  }

  private renderNewSceneCard() {
    return html`
      <div class="ph-newscene">
        <button
          class="ph-newscene__trigger"
          aria-haspopup="menu"
          aria-expanded=${this.newSceneMenuOpen}
          @click=${(e: MouseEvent) => {
            e.stopPropagation();
            this.newSceneMenuOpen = !this.newSceneMenuOpen;
          }}
        >
          <span class="ph-newscene__icon">${this.icons.getIcon('plus', 18)}</span>
          <span class="ph-newscene__title">New scene</span>
        </button>
        ${this.newSceneMenuOpen
          ? html`<div class="ph-newscene__menu" role="menu">
              <button
                class="ph-newscene__item"
                role="menuitem"
                @click=${() => this.pickNewScene('blank')}
              >
                <span class="ph-newscene__item-icon">${this.icons.getIcon('file', 14)}</span>
                <span class="ph-newscene__item-label">
                  <span class="ph-newscene__item-title">Empty</span>
                  <span class="ph-newscene__item-desc">Start from a bare scene</span>
                </span>
              </button>
              <button
                class="ph-newscene__item"
                role="menuitem"
                @click=${() => this.pickNewScene('template')}
              >
                <span class="ph-newscene__item-icon">${this.icons.getIcon('grid', 14)}</span>
                <span class="ph-newscene__item-label">
                  <span class="ph-newscene__item-title">Template</span>
                  <span class="ph-newscene__item-desc">Prefilled starter for this project</span>
                </span>
              </button>
              <button
                class="ph-newscene__item ph-newscene__item--accent"
                role="menuitem"
                @click=${() => this.pickNewScene('prompt')}
              >
                <span class="ph-newscene__item-icon">${this.icons.getIcon('sparkles', 14)}</span>
                <span class="ph-newscene__item-label">
                  <span class="ph-newscene__item-title">From prompt</span>
                  <span class="ph-newscene__item-desc">Describe it to the agent</span>
                </span>
              </button>
            </div>`
          : nothing}
      </div>
    `;
  }

  private pickNewScene(kind: 'blank' | 'template' | 'prompt'): void {
    this.newSceneMenuOpen = false;
    if (kind === 'prompt') {
      this.fillAgentInput('Create a new scene that ');
      return;
    }
    void this.createScene(kind);
  }

  private renderActivity(data: ProjectHomeData) {
    return html`
      <div class="ph-section-head ph-section-head--activity">
        <h2 class="ph-h2">Recent activity</h2>
      </div>
      <div class="ph-card ph-activity">
        ${data.activity.length === 0
          ? html`<div class="ph-activity__empty">No recent activity yet.</div>`
          : data.activity.map(
              item => html`
                <div class="ph-activity__row">
                  <span class="ph-activity__icon">${this.icons.getIcon(item.icon, 14)}</span>
                  <div class="ph-activity__text">
                    <div>${item.text}</div>
                    <div class="ph-activity__when">${this.relativeTime(item.when)}</div>
                  </div>
                </div>
              `
            )}
      </div>
    `;
  }

  private renderGdd(data: ProjectHomeData) {
    const gdd = data.gdd;
    if (!gdd) {
      return html`
        <div class="ph-card ph-gdd">
          <div class="ph-gdd__head">
            <span class="ph-gdd__icon">${this.icons.getIcon('file-text', 15)}</span>
            <div class="ph-gdd__title-wrap">
              <div class="ph-gdd__title">Game Design Doc</div>
              <div class="ph-gdd__sub">No GDD yet</div>
            </div>
          </div>
          <div class="ph-gdd__foot">
            <button class="ph-linkbtn" @click=${() => this.runChecklistAction('draft-gdd')}>
              ${this.icons.getIcon('sparkles', 13)} Draft a GDD with the agent
            </button>
          </div>
        </div>
      `;
    }
    return html`
      <div class="ph-card ph-gdd">
        <div class="ph-gdd__head">
          <span class="ph-gdd__icon">${this.icons.getIcon('file-text', 15)}</span>
          <div class="ph-gdd__title-wrap">
            <div class="ph-gdd__title">Game Design Doc</div>
            <div class="ph-gdd__sub">
              ${gdd.path} · updated ${this.relativeTime(gdd.modifiedAt)}
            </div>
          </div>
          <button class="ph-btn ph-btn--xs" @click=${() => this.openGdd()}>Open</button>
        </div>
        ${gdd.sections.length > 0
          ? html`<div class="ph-gdd__sections">
              ${gdd.sections.map(
                section => html`
                  <button class="ph-gdd__section" @click=${() => this.openGdd()}>
                    <span class="ph-gdd__section-name">${section.title}</span>
                    <span class="ph-gdd__status ph-gdd__status--${section.status} mono"
                      >${section.status}</span
                    >
                  </button>
                `
              )}
            </div>`
          : nothing}
        <div class="ph-gdd__foot">
          <button class="ph-linkbtn" @click=${() => this.runChecklistAction('draft-gdd')}>
            ${this.icons.getIcon('sparkles', 13)} Draft missing sections with the agent
          </button>
        </div>
      </div>
    `;
  }

  private renderChecklist(data: ProjectHomeData) {
    const done = data.checklist.filter(i => i.done).length;
    const total = data.checklist.length;
    if (done >= total) return nothing;
    const pct = Math.round((done / total) * 100);
    return html`
      <div class="ph-card ph-checklist">
        <div class="ph-section-head ph-section-head--tight">
          <h2 class="ph-h2">Project setup</h2>
          <span class="ph-count mono">${done}/${total}</span>
        </div>
        <div class="ph-progress"><div class="ph-progress__bar" style=${`width:${pct}%`}></div></div>
        ${data.checklist.map(item => this.renderChecklistRow(item))}
      </div>
    `;
  }

  private renderChecklistRow(item: HomeChecklistItem) {
    return html`
      <div class="ph-check-row ${item.done ? 'ph-check-row--done' : ''}">
        <span class="ph-check-box ${item.done ? 'ph-check-box--done' : ''}">
          ${item.done ? this.icons.getIcon('check', 12) : nothing}
        </span>
        <span class="ph-check-label">${item.label}</span>
        ${!item.done && item.action
          ? html`<button
              class="ph-linkbtn ph-linkbtn--accent"
              @click=${() => this.runChecklistAction(item.action as ChecklistAction)}
            >
              ${this.actionLabel(item.action)}
            </button>`
          : nothing}
      </div>
    `;
  }

  private renderAtAGlance(data: ProjectHomeData) {
    const g = data.atAGlance;
    const rows: Array<[string, string]> = [
      ['Assets', `${g.assetCount} · ${this.formatBytes(g.assetBytes)}`],
      ['Scripts', String(g.scriptCount)],
      ['Locales', g.locales.length ? g.locales.join(' · ') : '—'],
      ['Last build', g.lastBuild ?? '—'],
    ];
    return html`
      <div class="ph-card ph-glance">
        <h2 class="ph-h2 ph-glance__title">At a glance</h2>
        ${rows.map(
          ([k, v]) => html`
            <div class="ph-glance__row">
              <span class="ph-glance__key">${k}</span>
              <span class="ph-glance__val mono">${v}</span>
            </div>
          `
        )}
      </div>
    `;
  }

  private actionLabel(action: ChecklistAction): string {
    switch (action) {
      case 'draft-gdd':
        return 'Draft';
      case 'add-script':
        return 'Ask agent';
      case 'invite':
        return 'Invite';
    }
  }

  private relativeTime(ms: number): string {
    if (!ms) return 'unknown';
    const diff = Date.now() - ms;
    if (diff < 0) return 'just now';
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w ago`;
    return new Date(ms).toLocaleDateString();
  }

  private formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 KB';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-project-home': Pix3ProjectHome;
  }
}
