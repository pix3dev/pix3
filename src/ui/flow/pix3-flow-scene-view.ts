import type { PropertyValues } from 'lit';
import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import { AgentChatService } from '@/services/agent/AgentChatService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { IconService, IconSize } from '@/services/editor/IconService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
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

  private disposeSelection?: () => void;
  /**
   * Node ids the chip currently stands for, joined. `appState.selection` also carries the hovered
   * node, which changes on every pointer move — without this the composer would be re-raised
   * dozens of times a second for a selection that never changed.
   */
  private stagedSelection: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeSelection = subscribe(appState.selection, () => this.syncSelection());
    this.syncSelection();
    this.syncVisibility();
  }

  disconnectedCallback(): void {
    this.disposeSelection?.();
    this.disposeSelection = undefined;
    this.retractSelectionChip();
    this.setVisible(false);
    super.disconnectedCallback();
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has('active')) {
      this.syncVisibility();
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
    this.selectionLabels = listed.map(id => {
      const node = graph?.nodeMap.get(id);
      return node ? `${node.name} (${node.type})` : id;
    });
    this.selectionExtra = ids.length - listed.length;

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
      <pix3-editor-tab standalone></pix3-editor-tab>
    `;
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
