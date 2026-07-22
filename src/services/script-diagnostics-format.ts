/**
 * Pure helpers for turning a TypeScript worker diagnostic into the flat,
 * user-facing shape the Logs panel shows. Kept separate from
 * ProjectDiagnosticsService so they can be unit-tested without loading Monaco
 * (which cannot run under the happy-dom test environment).
 */

// TypeScript's DiagnosticCategory enum, as the Monaco worker reports it:
// Warning = 0, Error = 1, Suggestion = 2, Message = 3.
const TS_CATEGORY_WARNING = 0;
const TS_CATEGORY_ERROR = 1;

/** A TS diagnostic message, either a plain string or a nested message chain. */
export interface DiagnosticMessageChainLike {
  messageText: string;
  next?: DiagnosticMessageChainLike | DiagnosticMessageChainLike[] | undefined;
}

export type DiagnosticMessageText = string | DiagnosticMessageChainLike;

/**
 * Flatten a diagnostic message (string or nested chain) into a single line,
 * depth-first, joining the chain with spaces.
 */
export function flattenDiagnosticMessage(messageText: DiagnosticMessageText): string {
  if (typeof messageText === 'string') {
    return messageText;
  }

  const parts: string[] = [];
  const visit = (node: DiagnosticMessageChainLike): void => {
    parts.push(node.messageText);
    const next = node.next;
    if (Array.isArray(next)) {
      for (const child of next) {
        visit(child);
      }
    } else if (next) {
      visit(next);
    }
  };
  visit(messageText);
  return parts.join(' ');
}

/**
 * Map a TS diagnostic category to the two levels the Logs panel cares about, or
 * `null` for suggestions/messages that would only add noise.
 */
export function mapDiagnosticCategory(category: number): 'error' | 'warning' | null {
  if (category === TS_CATEGORY_ERROR) {
    return 'error';
  }
  if (category === TS_CATEGORY_WARNING) {
    return 'warning';
  }
  return null;
}
