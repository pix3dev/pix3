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
