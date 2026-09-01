/**
 * Render one `console.*` argument as a log line fragment.
 *
 * Shared by the two places that mirror a game's console somewhere a person can read it: the
 * standalone player (over the remote-preview channel) and the in-editor Game tab (into the Logs
 * panel). Kept as a leaf module with no imports so the player bundle pays nothing for it.
 */
export function stringifyLogArgument(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
