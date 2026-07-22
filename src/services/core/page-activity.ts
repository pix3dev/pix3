export const isDocumentActive = (documentRef: Document): boolean => {
  const visibilityState = documentRef.visibilityState;
  const isVisible = visibilityState === undefined || visibilityState === 'visible';
  const hasFocus = typeof documentRef.hasFocus === 'function' ? documentRef.hasFocus() : true;

  return isVisible && hasFocus;
};
