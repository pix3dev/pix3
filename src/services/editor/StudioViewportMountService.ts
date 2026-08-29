import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

/**
 * How the shell builds the Studio branch on request. Resolves `true` once Golden Layout owns
 * `.layout-host` and a scene tab is fronted in it, `false` when it cannot get that far.
 */
export type StudioViewportMounter = () => Promise<boolean>;

/**
 * The viewport does not exist the instant the layout does: the scene tab's `pix3-editor-tab` is a
 * Lit element, and it only hands the shared canvas a host in its own update. Poll for it, but give
 * up rather than hang the agent's tool call forever.
 */
const VIEWPORT_READY_TIMEOUT_MS = 8000;
const VIEWPORT_POLL_INTERVAL_MS = 50;

/**
 * The seam that lets an agent-facing caller demand the edit-mode viewport in a session that never
 * opened Studio.
 *
 * Vibe deliberately never builds the docking editor (`pix3-editor-shell.ensureStudioLayout()`), so
 * in a session reloaded straight into `#flow` there is no viewport and `viewport_screenshot` had
 * nothing to photograph — the agent lost its only way to look at the authored scene, while the same
 * call in a session that had visited Studio once returned a correct frame. The laziness is right for
 * humans and wrong for the agent, so the agent gets to ask.
 *
 * The mounting itself is private to the shell component and the tool registry must not reach into a
 * Lit element, so the shell registers a callback here in `connectedCallback` and clears it in
 * `disconnectedCallback`. Nothing calls the callback unless a tool asks: a human-only Vibe session
 * still builds nothing. Mounting does NOT switch the user to Studio — the branch is parked offscreen
 * (see `data-studio-offscreen` in `pix3-editor-shell.ts.css`) and their screen never changes.
 */
@injectable()
export class StudioViewportMountService {
  @inject(ViewportRendererService)
  private readonly viewportRenderer!: ViewportRendererService;

  private mounter: StudioViewportMounter | null = null;
  private inFlight: Promise<boolean> | null = null;

  /**
   * Called by the shell on connect. The returned disposer clears the registration, and clears only
   * *this* callback: a second shell (a re-connect during a hot reload) must not have its mounter
   * torn out from under it by the disposer the first one still holds.
   */
  registerMounter(mounter: StudioViewportMounter): () => void {
    this.mounter = mounter;
    return () => {
      if (this.mounter === mounter) {
        this.mounter = null;
      }
    };
  }

  /** Whether the shared editor canvas exists — i.e. whether a capture can succeed at all. */
  isViewportMounted(): boolean {
    return Boolean(this.viewportRenderer.getCanvasElement());
  }

  /**
   * Ensure the edit-mode viewport exists, building the Studio branch hidden if this session never
   * did. Resolves `true` once the viewport can be captured, `false` when it cannot: no shell is
   * registered, no project is open, or the branch came up without a viewport in it.
   *
   * Concurrent callers share one mount — two screenshot tools racing must not build two layouts.
   */
  async ensureStudioViewportMounted(): Promise<boolean> {
    // Checked before anything touches the renderer, so a caller with no shell behind it (specs,
    // a torn-down editor) gets its honest `false` without spinning up a WebGL service to hear it.
    if (!this.mounter) {
      return false;
    }
    if (appState.project.status !== 'ready') {
      return false;
    }
    if (this.isViewportMounted()) {
      return true;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    const pending = this.mountAndWait();
    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.inFlight === pending) {
        this.inFlight = null;
      }
    }
  }

  dispose(): void {
    this.mounter = null;
    this.inFlight = null;
  }

  private async mountAndWait(): Promise<boolean> {
    const mounter = this.mounter;
    if (!mounter) {
      return false;
    }
    if (!(await mounter())) {
      return false;
    }
    return this.waitForViewport();
  }

  private async waitForViewport(): Promise<boolean> {
    const deadline = Date.now() + VIEWPORT_READY_TIMEOUT_MS;
    while (!this.isViewportMounted()) {
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, VIEWPORT_POLL_INTERVAL_MS));
    }
    return true;
  }
}
