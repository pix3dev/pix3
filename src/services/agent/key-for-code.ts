/**
 * `KeyboardEvent.key` for a `KeyboardEvent.code`, on a US layout.
 *
 * The runtime's `InputService` latches both fields of every key event and scripts poll either —
 * `Key_Minus` by code, or `event.key === '-'` from a DOM listener — so a synthetic event has to
 * carry the value a real keyboard would. The old per-service copies mapped only `Key*`, `Digit*`
 * and `Space`, and a `Minus` step arrived as `key: "Minus"`: a game reading `key` for zoom-out
 * never saw it, and the failure looked like dead game logic. One table, shared by `game_input`
 * and the trace replayer, so the two channels cannot drift apart again.
 */
const US_LAYOUT: Readonly<Record<string, string>> = {
  Space: ' ',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  IntlBackslash: '\\',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  CapsLock: 'CapsLock',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Control',
  ControlRight: 'Control',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
  ContextMenu: 'ContextMenu',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  NumpadMultiply: '*',
  NumpadDivide: '/',
  NumpadDecimal: '.',
  NumpadEqual: '=',
  NumpadComma: ',',
};

/**
 * Best-effort `KeyboardEvent.key` for a `code` (US layout). Letters lower-case (`KeyA` → `a`),
 * digits and numpad digits as themselves, punctuation and numpad operators as the printed
 * character, named keys (arrows, `Enter`, `Escape`, `F1`…) as their own name — which is also the
 * fallback for anything the table does not know.
 */
export function keyForCode(code: string): string {
  if (code.length === 4 && code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.length === 6 && code.startsWith('Digit')) return code.slice(5);
  if (code.length === 7 && code.startsWith('Numpad') && /\d/.test(code[6])) return code.slice(6);
  return US_LAYOUT[code] ?? code;
}
