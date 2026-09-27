/**
 * Page activity, and the one switch that overrides it: **agent keepalive**.
 *
 * The editor pauses work while its tab is in the background (play loop, viewport loop, file
 * polling) to spare a laptop's battery when nobody is looking. In the external-agent pipeline the
 * tab is in the background almost all the time while the agent works, and the agent must never
 * wait for such a pause. `AgentKeepaliveService` decides when an agent is involved and sets
 * {@link setEditorKeepAlive}; every battery-saving gate asks {@link isEditorActive} instead of the
 * raw document state. With no agent involved nothing changes.
 *
 * Callers that genuinely need the raw state (is the human looking?) keep using
 * {@link isDocumentActive} / {@link isDocumentVisible}.
 */

export const isDocumentActive = (documentRef: Document): boolean => {
  const visibilityState = documentRef.visibilityState;
  const isVisible = visibilityState === undefined || visibilityState === 'visible';
  const hasFocus = typeof documentRef.hasFocus === 'function' ? documentRef.hasFocus() : true;

  return isVisible && hasFocus;
};

/**
 * Visible on screen, focused or not. The external-change watcher polls on this rather than
 * {@link isDocumentActive}: an editor window beside the agent's terminal is visible but unfocused,
 * and that is exactly when the agent's edits must show up (`.plans/external-agent-authoring.md`
 * §5 C1).
 */
export const isDocumentVisible = (documentRef: Document): boolean => {
  const visibilityState = documentRef.visibilityState;
  return visibilityState === undefined || visibilityState === 'visible';
};

/** True when the tab is hidden (no rAF; timers throttled) — raw, keepalive does not change it. */
export const isDocumentHidden = (documentRef: Document): boolean =>
  documentRef.visibilityState === 'hidden';

let keepAlive = false;
const keepAliveListeners = new Set<() => void>();

/** Set by `AgentKeepaliveService` only. Listeners run on every change. */
export const setEditorKeepAlive = (enabled: boolean): void => {
  if (keepAlive === enabled) return;
  keepAlive = enabled;
  for (const listener of Array.from(keepAliveListeners)) {
    try {
      listener();
    } catch (error) {
      console.error('[page-activity] keepalive listener failed', error);
    }
  }
};

/** An agent is working with this editor: background pauses must not gate its work. */
export const isEditorKeepAlive = (): boolean => keepAlive;

/** Subscribe to keepalive changes (re-evaluate a pause decision); returns the unsubscribe. */
export const onEditorKeepAliveChange = (listener: () => void): (() => void) => {
  keepAliveListeners.add(listener);
  return () => {
    keepAliveListeners.delete(listener);
  };
};

/**
 * The gate for every battery-saving pause: the document is active (visible and focused), or an
 * agent keeps the editor alive.
 */
export const isEditorActive = (documentRef: Document): boolean =>
  keepAlive || isDocumentActive(documentRef);
