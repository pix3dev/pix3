import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { IconService, IconSize } from '@/services/editor/IconService';
import { WorkspaceModeService } from '@/services/editor/WorkspaceModeService';
import { SwitchWorkspaceModeCommand } from '@/features/editor/SwitchWorkspaceModeCommand';
import type { WorkspaceMode } from '@/state/AppState';
import './pix3-mode-switch.ts.css';

interface ModeOption {
  readonly mode: WorkspaceMode;
  readonly label: string;
  readonly icon: string;
  readonly hint: string;
}

const MODES: readonly ModeOption[] = [
  {
    mode: 'studio',
    label: 'Studio',
    icon: 'mode-studio',
    hint: 'Studio mode — the full editor: docks, scene tree, inspector',
  },
  {
    // `'flow'` stays the internal mode id (state, storage, `#flow` route); "Vibe" is what it is
    // called on screen.
    mode: 'flow',
    label: 'Vibe',
    icon: 'mode-vibe',
    hint: 'Vibe mode — chat prompt next to a live game stage',
  },
];

/**
 * The Studio ↔ Vibe switch that sits next to the project name in both shells: a segmented control,
 * always shown whole, with the mode you are in as the filled half. It reads as state first — you can
 * tell which shell you are in without hovering anything — and as the way across second. Its width
 * never changes, so it cannot nudge the centred project name it sits beside.
 */
@customElement('pix3-mode-switch')
export class Pix3ModeSwitch extends ComponentBase {
  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(WorkspaceModeService)
  private readonly workspaceModeService!: WorkspaceModeService;

  @state()
  private mode: WorkspaceMode = 'studio';

  private disposeMode?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeMode = this.workspaceModeService.subscribe(mode => {
      this.mode = mode;
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeMode?.();
    this.disposeMode = undefined;
  }

  protected render() {
    return html`
      <div class="mode-switch" role="group" aria-label="Workspace mode">
        ${this.renderOption(MODES[0])}
        <span class="mode-switch__divider" aria-hidden="true"></span>
        ${this.renderOption(MODES[1])}
      </div>
    `;
  }

  private renderOption(option: ModeOption) {
    const isCurrent = this.mode === option.mode;
    return html`
      <button
        class="mode-switch__option"
        type="button"
        data-mode=${option.mode}
        data-current=${isCurrent ? 'true' : 'false'}
        aria-pressed=${isCurrent}
        title=${isCurrent ? `You are in ${option.hint}` : `Switch to ${option.hint}`}
        @click=${() => void this.select(option.mode)}
      >
        ${this.icons.getIcon(option.icon, IconSize.SMALL)}
        <span class="mode-switch__label">${option.label}</span>
      </button>
    `;
  }

  private async select(mode: WorkspaceMode): Promise<void> {
    if (mode === this.mode) {
      return;
    }
    await this.commandDispatcher.execute(new SwitchWorkspaceModeCommand({ mode }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-mode-switch': Pix3ModeSwitch;
  }
}
