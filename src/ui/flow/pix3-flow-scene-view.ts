import { nothing, type PropertyValues } from 'lit';
import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import { AgentChatService } from '@/services/agent/AgentChatService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { SaveSceneOperation } from '@/features/scene/SaveSceneOperation';
import { SceneManager } from '@pix3/runtime';
import '@/ui/viewport/editor-tab';
import './pix3-flow-scene-view.ts.css';

/**
 * Slot the selection chip occupies in the composer. One slot: re-picking swaps the chip instead of
 * stacking a new one per click.
 */
const SELECTION_SLOT_KEY = 'vibe-selection';

/** How many nodes the strip and the chip name before falling back to "+N more". */
const SELECTION_LIST_LIMIT = 4;

/**
 * How long an edit made here sits in memory before it is written back to the `.pix3scene`.
 *
 * Short on purpose. The dirty flag is raised on gizmo mouse-UP (not per frame of a drag), so this is
 * a settling delay for a burst of edits rather than a throttle for a stream — and every extra
 * hundred milliseconds is time in which a reload or a Download HTML would ship the stale file.
 */
export const AUTOSAVE_DEBOUNCE_MS = 1200;

/** How long the strip keeps saying "Saved" after a write lands. */
export const SAVED_RECEIPT_MS = 2000;

/**
 * Vibe's third stage view: the edit-mode viewport.
 *
 * Vibe loads a real scene graph (`play-workspace.ensureSceneActive` does it on the first
 * `game.start`) but has no tabs and no docks, so until now there was nothing to look at when the
 * game was stopped and no way to point at an object. This wraps the ordinary `pix3-editor-tab` in
 * its tab-less `standalone` mode, and adds the one thing Vibe needs that Studio gets from the
 * Inspector and the scene tree: a readable answer to "what did I just click".
 *
 * Two obligations that are easy to miss:
 *  - **The visibility flag is the renderer's permission slip.** `ViewportRendererService` suppresses
 *    every frame while the workspace is `flow`, so this component has to announce itself
 *    (`appState.ui.flowSceneViewVisible`) and ask for the first frame — flipping the flag is not
 *    itself a dirty-marker (see CLAUDE.md, "Editor viewport renders on demand").
 *  - **Selection reaches the agent for free.** `AgentChatService.buildSystemPrompt` already puts
 *    `appState.selection.nodeIds` into the live project-context block, so no plumbing is added here.
 *    The composer chip exists only so the user can SEE that the agent knows.
 *  - **Nothing else here saves.** Vibe has no Ctrl+S, no tab and no dirty marker, and Download HTML
 *    builds from the FILES — so an edit made with the gizmo lives only in memory and dies on the next
 *    reload. The agent saves after its own mutations; a person editing here had nobody, which is why
 *    this view carries the debounced write-back (see `armSceneSave`).
 */
@customElement('pix3-flow-scene-view')
export class Pix3FlowSceneView extends ComponentBase {
  @inject(AgentChatService)
  private readonly agentChat!: AgentChatService;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(ViewportRendererService)
  private readonly viewportRenderer!: ViewportRendererService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(OperationService)
  private readonly operations!: OperationService;

  /**
   * Whether this view is the stage on screen. The shell keeps it MOUNTED and merely hides it (same
   * rule as the idea document), so "visible" cannot be read from the DOM — it is handed down.
   */
  @property({ type: Boolean })
  active = true;

  @state()
  private selectionLabels: string[] = [];

  @state()
  private selectionExtra = 0;

  /** What the strip says about the write-back: nothing, in flight, or "just landed". */
  @state()
  private saveState: 'idle' | 'saving' | 'saved' = 'idle';

  /**
   * Whether the properties drawer is showing. Mirrors `appState.ui.flowInspectorOpen`, which is
   * where it lives so the posture survives the remount every stage switch causes.
   */
  @state()
  private inspectorOpen = appState.ui.flowInspectorOpen;

  /**
   * Whether `pix3-inspector-panel` has been imported. The Inspector pulls in the property editors,
   * the resource pickers and the library inspector — a real chunk, and Vibe's whole premise is that
   * it does not build the editor it is not showing. So it is imported on first open, never on load.
   *
   * Seeded from the custom-element registry rather than `false`, because that registry is the
   * global truth: once any part of the session has imported the panel, a fresh instance of this
   * view must not pretend it is still loading.
   */
  @state()
  private inspectorLoaded = customElements.get('pix3-inspector-panel') !== undefined;

  private inspectorLoading = false;

  private disposeSelection?: () => void;
  private disposeScenes?: () => void;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savedReceiptTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInFlight = false;
  /** An edit that arrived while a write was in flight — the file has to be written again. */
  private saveAgain = false;
  /**
   * Node ids the chip currently stands for, joined. `appState.selection` also carries the hovered
   * node, which changes on every pointer move — without this the composer would be re-raised
   * dozens of times a second for a selection that never changed.
   */
  private stagedSelection: string | null = null;
  /** Last `scenes.nodeDataChangeSignal` this view acted on — see {@link onScenesChanged}. */
  private lastNodeDataSignal = appState.scenes.nodeDataChangeSignal;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeSelection = subscribe(appState.selection, () => this.syncSelection());
    this.disposeScenes = subscribe(appState.scenes, () => this.onScenesChanged());
    this.syncSelection();
    this.syncVisibility();
    if (this.inspectorOpen) {
      // Remounted with the drawer already open (the posture outlives the stage switch that
      // rebuilt this view). Nobody pressed the toggle, so nothing else would load the panel and
      // the drawer would sit on "Loading properties…" forever.
      void this.ensureInspectorLoaded();
    }
  }

  disconnectedCallback(): void {
    this.disposeSelection?.();
    this.disposeSelection = undefined;
    this.disposeScenes?.();
    this.disposeScenes = undefined;
    // Leaving Vibe (or the whole shell unmounting) must not be the moment an edit is dropped.
    this.flushSceneSave();
    if (this.savedReceiptTimer !== null) {
      clearTimeout(this.savedReceiptTimer);
      this.savedReceiptTimer = null;
    }
    this.retractSelectionChip();
    this.setVisible(false);
    super.disconnectedCallback();
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has('active')) {
      this.syncVisibility();
      if (!this.active) {
        // The stage switching to Game is the hand-off: whatever is still pending goes out now, so a
        // Download HTML or a reload from the other view cannot ship a file the user has moved past.
        this.flushSceneSave();
      }
    }
  }

  private syncVisibility(): void {
    this.setVisible(this.isConnected && this.active);
  }

  private setVisible(visible: boolean): void {
    if (appState.ui.flowSceneViewVisible === visible) {
      return;
    }
    appState.ui.flowSceneViewVisible = visible;
    if (visible) {
      // The flag only lifts the suppression; it does not mark anything dirty. Without this the
      // viewport would stay black until the 500 ms idle heartbeat happened to fire.
      this.viewportRenderer.requestRender();
    }
  }

  /**
   * Arm the write-back whenever the active scene goes dirty.
   *
   * The trigger is the descriptor's own `isDirty`, not `appState.history`: a save clears the flag,
   * so a cleared flag can never re-arm the timer, and the loop a history subscription would create
   * (save → history entry → save) cannot happen. Only the VISIBLE view arms — the agent saves after
   * its own mutations, and a hidden view arming as well would just race it for the same file.
   */
  private onScenesChanged(): void {
    if (!this.isConnected || !this.active) {
      return;
    }
    // Node data changed without the hierarchy changing — a property edit, including a rename made
    // in the drawer right below the strip.
    if (appState.scenes.nodeDataChangeSignal !== this.lastNodeDataSignal) {
      this.lastNodeDataSignal = appState.scenes.nodeDataChangeSignal;
      this.refreshSelectionLabels();
    }
    if (!this.dirtySceneId()) {
      return;
    }
    this.armSceneSave();
  }

  /**
   * The scene id that has unsaved edits and can actually be written, or null.
   *
   * The three refusals mirror `SaveSceneCommand.preconditions`, and the cloud one is the load-bearing
   * one: a collab project synchronizes through Yjs, so writing its file from here would fight the
   * sync instead of persisting anything.
   */
  private dirtySceneId(): string | null {
    if (appState.project.status !== 'ready' || appState.project.backend === 'cloud') {
      return null;
    }
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) {
      return null;
    }
    const descriptor = appState.scenes.descriptors[sceneId];
    if (!descriptor?.isDirty || !descriptor.filePath?.startsWith('res://')) {
      return null;
    }
    return sceneId;
  }

  private armSceneSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveDirtyScene(true);
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /**
   * Write a pending edit out NOW, without waiting for the debounce.
   *
   * Announces nothing: a flush happens exactly when this view stops being on screen, so there is
   * nobody to read a receipt — and writing one would be a reactive update raised from inside Lit's
   * own update cycle (`updated`), which Lit rightly complains about.
   */
  private flushSceneSave(): void {
    if (this.saveTimer === null) {
      return;
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.saveDirtyScene(false);
  }

  /**
   * Write the dirty scene back to its file, best-effort.
   *
   * Deliberately `OperationService.invoke` and not `SaveSceneCommand`: the command pushes the save
   * onto the undo stack, and Vibe has the ordinary Ctrl+Z. One entry per autosave would mean every
   * gizmo edit costs TWO undos — the second one being a save that restores a dirty flag and nothing
   * a user can see. The preconditions the command would have checked are in `dirtySceneId`.
   */
  private async saveDirtyScene(announce: boolean): Promise<void> {
    if (this.saveInFlight) {
      this.saveAgain = true;
      return;
    }
    const sceneId = this.dirtySceneId();
    if (!sceneId) {
      return;
    }
    this.saveInFlight = true;
    if (announce) {
      this.saveState = 'saving';
    }
    try {
      await this.operations.invoke(new SaveSceneOperation({ sceneId }));
      if (announce) {
        this.showSavedReceipt();
      }
    } catch (error) {
      // A failed autosave is not worth a dialog over a prototyping session, but it must not read as
      // a success either — the strip drops back to silence and the reason goes to the console.
      console.warn('[Pix3FlowSceneView] Auto-save of the scene edit failed:', error);
      if (announce) {
        this.saveState = 'idle';
      }
    } finally {
      this.saveInFlight = false;
    }
    if (this.saveAgain) {
      this.saveAgain = false;
      void this.saveDirtyScene(announce);
    }
  }

  private showSavedReceipt(): void {
    this.saveState = 'saved';
    if (this.savedReceiptTimer !== null) {
      clearTimeout(this.savedReceiptTimer);
    }
    this.savedReceiptTimer = setTimeout(() => {
      this.savedReceiptTimer = null;
      if (this.saveState === 'saved') {
        this.saveState = 'idle';
      }
    }, SAVED_RECEIPT_MS);
  }

  /**
   * Mirror the selection into the strip and into a composer chip.
   *
   * The chip is deliberately not the transport — the agent already reads the selection out of
   * `appState` on every turn. It is the receipt: without it a user who clicks a node has no way to
   * tell whether the thing they are about to ask about is the thing the agent will look at.
   */
  private syncSelection(): void {
    const ids = [...appState.selection.nodeIds];
    const key = ids.join(',');
    if (key === this.stagedSelection) {
      return;
    }
    this.stagedSelection = key;

    if (ids.length === 0) {
      this.selectionLabels = [];
      this.selectionExtra = 0;
      this.agentChat.clearComposeContext(SELECTION_SLOT_KEY);
      return;
    }

    const graph = this.sceneManager.getActiveSceneGraph();
    const listed = ids.slice(0, SELECTION_LIST_LIMIT);
    this.refreshSelectionLabels();

    const detailed = listed.map(id => {
      const node = graph?.nodeMap.get(id);
      return node ? `${node.name} (${node.type}) [${id}]` : `[${id}]`;
    });
    const extra = this.selectionExtra > 0 ? ` (+${this.selectionExtra} more)` : '';
    this.agentChat.composeContext({
      attachment: {
        name: ids.length === 1 ? this.selectionLabels[0] : `${ids.length} nodes selected`,
        content: `Selected in the scene view: ${detailed.join(', ')}${extra}`,
      },
      replaceKey: SELECTION_SLOT_KEY,
    });
  }

  /**
   * Re-read the names of the currently selected nodes.
   *
   * Split out of {@link syncSelection} because the strip caches on the selected node IDS, and a
   * rename changes none of them: with the properties drawer a node can now be renamed from inside
   * this very view, and the strip above it went on showing the old name.
   */
  private refreshSelectionLabels(): void {
    const ids = [...appState.selection.nodeIds];
    if (ids.length === 0) {
      this.selectionLabels = [];
      this.selectionExtra = 0;
      return;
    }
    const graph = this.sceneManager.getActiveSceneGraph();
    const listed = ids.slice(0, SELECTION_LIST_LIMIT);
    this.selectionLabels = listed.map(id => {
      const node = graph?.nodeMap.get(id);
      return node ? `${node.name} (${node.type})` : id;
    });
    this.selectionExtra = ids.length - listed.length;
  }

  private retractSelectionChip(): void {
    if (this.stagedSelection === null || this.stagedSelection === '') {
      return;
    }
    this.stagedSelection = null;
    this.agentChat.clearComposeContext(SELECTION_SLOT_KEY);
  }

  protected render() {
    return html`
      ${this.renderSelectionStrip()}
      <div class="flow-scene__body" data-inspector=${this.inspectorOpen ? 'open' : 'closed'}>
        <pix3-editor-tab standalone></pix3-editor-tab>
        ${this.renderInspectorDrawer()}
      </div>
    `;
  }

  /**
   * The typed-value surface Vibe was missing.
   *
   * It mounts the SAME `pix3-inspector-panel` Studio docks, rather than a second, smaller
   * inspector: the panel already reads `appState.selection` on its own and routes every edit
   * through `UpdateObjectPropertyCommand`, so reusing it costs no plumbing and — more importantly —
   * makes it impossible for Vibe's inspector to drift from Studio's as node schemas change.
   */
  private renderInspectorDrawer() {
    if (!this.inspectorOpen) {
      return nothing;
    }
    return html`
      <aside class="flow-scene__inspector" aria-label="Properties">
        ${this.inspectorLoaded
          ? html`<pix3-inspector-panel></pix3-inspector-panel>`
          : html`<div class="flow-scene__inspector-loading">Loading properties…</div>`}
      </aside>
    `;
  }

  private readonly toggleInspector = (): void => {
    this.inspectorOpen = !this.inspectorOpen;
    appState.ui.flowInspectorOpen = this.inspectorOpen;
    if (this.inspectorOpen) {
      void this.ensureInspectorLoaded();
    }
  };

  private async ensureInspectorLoaded(): Promise<void> {
    if (this.inspectorLoaded || this.inspectorLoading) {
      return;
    }
    this.inspectorLoading = true;
    try {
      await import('@/ui/object-inspector/inspector-panel');
      this.inspectorLoaded = true;
    } catch (error) {
      // A drawer that cannot load is a missing feature, not a broken stage: leave it closed and
      // say so, rather than taking the viewport down with it.
      console.error('[Pix3FlowSceneView] Failed to load the properties panel:', error);
      this.inspectorOpen = false;
      appState.ui.flowInspectorOpen = false;
    } finally {
      this.inspectorLoading = false;
    }
  }

  private renderSelectionStrip() {
    const hasSelection = this.selectionLabels.length > 0;
    const names = this.selectionLabels.join(', ');
    const extra = this.selectionExtra > 0 ? ` +${this.selectionExtra} more` : '';
    return html`
      <div
        class="flow-scene__strip"
        data-empty=${hasSelection ? 'false' : 'true'}
        role="status"
        aria-live="polite"
      >
        ${this.icons.getIcon(hasSelection ? 'crosshair' : 'mouse-pointer', IconSize.SMALL)}
        <span class="flow-scene__strip-text" title=${hasSelection ? `${names}${extra}` : ''}
          >${hasSelection
            ? `${names}${extra}`
            : 'Click an object to select it — the chat sees your selection.'}</span
        >
        ${this.renderSaveState()}
        <button
          class="flow-scene__properties"
          type="button"
          aria-pressed=${this.inspectorOpen ? 'true' : 'false'}
          title=${this.inspectorOpen ? 'Hide properties' : 'Show properties'}
          aria-label=${this.inspectorOpen ? 'Hide properties' : 'Show properties'}
          @click=${this.toggleInspector}
        >
          ${this.icons.getIcon('sliders', IconSize.SMALL)}
        </button>
        <button
          class="flow-scene__play"
          type="button"
          title="Play — back to the running game"
          aria-label="Play"
          @click=${this.startGame}
        >
          ${this.icons.getIcon('play', IconSize.SMALL)}
        </button>
      </div>
    `;
  }

  /**
   * The receipt for the write-back.
   *
   * Small, and only while it says something: the save is automatic, so the question this answers is
   * not "did I save" but "is my change in the file yet" — asked exactly once, right after an edit,
   * by a user who is about to hit Download HTML.
   */
  private renderSaveState() {
    if (this.saveState === 'idle') {
      return nothing;
    }
    const saving = this.saveState === 'saving';
    return html`
      <span class="flow-scene__save" data-state=${this.saveState}>
        ${this.icons.getIcon(saving ? 'save' : 'check', IconSize.SMALL)}
        <span>${saving ? 'Saving…' : 'Saved'}</span>
      </span>
    `;
  }

  /**
   * The way back to the game, from the view a stop drops the user into.
   *
   * The stage's own Play/Restart bar lives inside `.flow-stage`, which is hidden while this view is
   * up — so without this button the only route back is noticing the Game segment above, and the
   * one control every prototyping loop needs would be off screen exactly when the game is stopped.
   * No view switching here: starting flips `appState.ui.isPlaying`, and the shell follows that.
   */
  private readonly startGame = (): void => {
    void this.commandDispatcher.executeById('game.start');
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-flow-scene-view': Pix3FlowSceneView;
  }
}
