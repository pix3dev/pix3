import { subscribe } from 'valtio/vanilla';
import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { appState, type MergeBannerState } from '@/state';
import { IconService, IconSize } from '@/services/editor/IconService';
import { ExternalMergeService } from '@/services/project/coauthoring/ExternalMergeService';
import type { MergeConflict } from '@/services/project/external-merge/merge-external-version';
import { describePath } from '@/services/project/external-merge/scene-doc';
import './pix3-merge-banner.ts.css';

const VALUE_PREVIEW_CHARS = 48;

/** Short, readable preview of a scene value for the details list. */
export function formatMergeValue(value: unknown, present = true): string {
  if (!present || value === undefined) return 'removed';
  let text: string;
  try {
    text =
      typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > VALUE_PREVIEW_CHARS ? `${text.slice(0, VALUE_PREVIEW_CHARS - 1)}…` : text;
}

/**
 * The non-blocking merge banner of plan §4.3 / §5 C3, one row per scene whose external version
 * needed the human:
 *
 * - `conflicts`: "Agent changed N properties you edited — yours were kept." with
 *   [Accept agent's version] (all, undoable), [Details] (each conflict: your value → the agent's,
 *   with a per-item Accept) and [Restore my version before the agent's changes] (journal).
 * - `rejected`: "The agent's version could not be merged: <reason>" with [Accept agent's version]
 *   (reload the file as is, release the protected set) and [Keep mine] (write the editor's
 *   version over it).
 *
 * Every action goes through `ExternalMergeService` (Commands / Operations underneath).
 */
@customElement('pix3-merge-banner')
export class Pix3MergeBanner extends ComponentBase {
  @inject(IconService)
  private readonly icons!: IconService;

  @inject(ExternalMergeService)
  private readonly merges!: ExternalMergeService;

  @state() private banners: MergeBannerState[] = [];
  @state() private expanded = new Set<string>();
  @state() private busy = new Set<string>();

  private disposeSubscription?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.sync();
    this.disposeSubscription = subscribe(appState.project.coauthoring, () => this.sync());
  }

  disconnectedCallback(): void {
    this.disposeSubscription?.();
    this.disposeSubscription = undefined;
    super.disconnectedCallback();
  }

  private sync(): void {
    const merges = appState.project.coauthoring.merges;
    this.banners = Object.values(merges)
      .map(b => JSON.parse(JSON.stringify(b)) as MergeBannerState)
      .sort((a, b) => a.at - b.at);
    const paths = new Set(this.banners.map(b => b.path));
    const expanded = new Set([...this.expanded].filter(p => paths.has(p)));
    if (expanded.size !== this.expanded.size) this.expanded = expanded;
  }

  protected render() {
    if (this.banners.length === 0) return null;
    return html`<div class="merge-banner-stack">
      ${this.banners.map(b => this.renderBanner(b))}
    </div>`;
  }

  private renderBanner(banner: MergeBannerState) {
    const busy = this.busy.has(banner.path);
    const scene = sceneLabel(banner);
    if (banner.status === 'rejected') {
      return html`
        <div class="merge-banner merge-banner--error" role="alert" data-path=${banner.path}>
          <div class="merge-banner__row">
            <span class="merge-banner__icon" aria-hidden="true"
              >${this.icons.getIcon('alert-triangle', IconSize.SMALL)}</span
            >
            <span class="merge-banner__text">
              The agent's version of <strong>${scene}</strong> could not be merged:
              ${banner.reason ?? 'unknown reason'}. Your version is kept in the editor.
            </span>
            <div class="merge-banner__actions">
              <button
                type="button"
                class="merge-banner__btn merge-banner__btn--primary"
                data-action="accept-rejected"
                ?disabled=${busy}
                @click=${() => this.run(banner.path, () => this.merges.acceptRejected(banner.path))}
              >
                Accept agent's version
              </button>
              <button
                type="button"
                class="merge-banner__btn"
                data-action="keep-mine"
                ?disabled=${busy}
                @click=${() => this.run(banner.path, () => this.merges.keepMine(banner.path))}
              >
                Keep mine
              </button>
            </div>
          </div>
        </div>
      `;
    }

    const count = banner.conflicts.length;
    const open = this.expanded.has(banner.path);
    return html`
      <div class="merge-banner" role="status" data-path=${banner.path}>
        <div class="merge-banner__row">
          <span class="merge-banner__icon" aria-hidden="true"
            >${this.icons.getIcon('git-merge', IconSize.SMALL)}</span
          >
          <span class="merge-banner__text">
            Agent changed ${count} ${count === 1 ? 'property' : 'properties'} you edited in
            <strong>${scene}</strong> — yours were kept.
          </span>
          <div class="merge-banner__actions">
            <button
              type="button"
              class="merge-banner__btn merge-banner__btn--primary"
              data-action="accept-all"
              ?disabled=${busy}
              @click=${() => this.run(banner.path, () => this.merges.acceptConflicts(banner.path))}
            >
              Accept agent's version
            </button>
            <button
              type="button"
              class="merge-banner__btn"
              data-action="details"
              aria-expanded=${open ? 'true' : 'false'}
              @click=${() => this.toggle(banner.path)}
            >
              Details
              <span class="merge-banner__chevron" aria-hidden="true"
                >${this.icons.getIcon(open ? 'chevron-up' : 'chevron-down', IconSize.SMALL)}</span
              >
            </button>
            <button
              type="button"
              class="merge-banner__btn"
              data-action="restore"
              ?disabled=${busy || !banner.restoreRef}
              title="Restore the version you had right before the agent's change (undoable)"
              @click=${() =>
                this.run(banner.path, () => this.merges.restoreBeforeMerge(banner.path))}
            >
              <span class="merge-banner__btn-icon" aria-hidden="true"
                >${this.icons.getIcon('rotate-ccw', IconSize.SMALL)}</span
              >
              Restore my version before the agent's changes
            </button>
            <button
              type="button"
              class="merge-banner__btn merge-banner__btn--icon"
              data-action="dismiss"
              title="Dismiss"
              aria-label="Dismiss"
              @click=${() => this.merges.dismiss(banner.path)}
            >
              ${this.icons.getIcon('x', IconSize.SMALL)}
            </button>
          </div>
        </div>
        ${open
          ? html`<ul class="merge-banner__details">
              ${banner.conflicts.map(conflict => this.renderConflict(banner, conflict, busy))}
            </ul>`
          : null}
      </div>
    `;
  }

  private renderConflict(banner: MergeBannerState, conflict: MergeConflict, busy: boolean) {
    const hasValues = 'humanValue' in conflict || conflict.agentValue !== undefined;
    return html`
      <li class="merge-banner__conflict" data-conflict=${conflict.id}>
        <div class="merge-banner__conflict-text">
          <span class="merge-banner__conflict-message">${conflict.message}</span>
          ${conflict.path && conflict.path.length > 0
            ? html`<span class="merge-banner__conflict-path">${describePath(conflict.path)}</span>`
            : null}
          ${hasValues
            ? html`<span class="merge-banner__values">
                <span class="merge-banner__value merge-banner__value--mine"
                  >${formatMergeValue(conflict.humanValue, 'humanValue' in conflict)}</span
                >
                <span class="merge-banner__arrow" aria-label="becomes"
                  >${this.icons.getIcon('arrow-right', IconSize.SMALL)}</span
                >
                <span class="merge-banner__value merge-banner__value--agent"
                  >${formatMergeValue(conflict.agentValue, conflict.agentPresent)}</span
                >
              </span>`
            : null}
        </div>
        <button
          type="button"
          class="merge-banner__btn"
          data-action="accept-one"
          ?disabled=${busy}
          @click=${() =>
            this.run(banner.path, () => this.merges.acceptConflicts(banner.path, [conflict.id]))}
        >
          Accept
        </button>
      </li>
    `;
  }

  private toggle(path: string): void {
    const next = new Set(this.expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.expanded = next;
  }

  private async run(path: string, action: () => Promise<boolean>): Promise<void> {
    if (this.busy.has(path)) return;
    this.busy = new Set([...this.busy, path]);
    try {
      await action();
    } catch (error) {
      console.error('[Pix3MergeBanner] Action failed', error);
    } finally {
      const next = new Set(this.busy);
      next.delete(path);
      this.busy = next;
    }
  }
}

function sceneLabel(banner: MergeBannerState): string {
  const descriptor = appState.scenes.descriptors[banner.sceneId];
  return descriptor?.name || banner.path.split('/').pop() || banner.path;
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-merge-banner': Pix3MergeBanner;
  }
}
