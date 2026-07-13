import { describe, expect, it } from 'vitest';

import {
  flattenDiagnosticMessage,
  mapDiagnosticCategory,
} from './script-diagnostics-format';

describe('flattenDiagnosticMessage', () => {
  it('returns a plain string message unchanged', () => {
    expect(
      flattenDiagnosticMessage("Cannot assign to 'position' because it is a read-only property.")
    ).toBe("Cannot assign to 'position' because it is a read-only property.");
  });

  it('flattens a single-linked message chain depth-first', () => {
    const chain = {
      messageText: "Type 'Vector3' is not assignable to type 'never'.",
      next: { messageText: 'The intersected type is impossible.' },
    };
    expect(flattenDiagnosticMessage(chain)).toBe(
      "Type 'Vector3' is not assignable to type 'never'. The intersected type is impossible."
    );
  });

  it('flattens a chain whose next is an array of children', () => {
    const chain = {
      messageText: 'Top level.',
      next: [
        { messageText: 'First reason.' },
        { messageText: 'Second reason.', next: { messageText: 'Nested detail.' } },
      ],
    };
    expect(flattenDiagnosticMessage(chain)).toBe(
      'Top level. First reason. Second reason. Nested detail.'
    );
  });
});

describe('mapDiagnosticCategory', () => {
  it('maps TS categories to log levels, dropping suggestions/messages', () => {
    expect(mapDiagnosticCategory(1)).toBe('error'); // Error
    expect(mapDiagnosticCategory(0)).toBe('warning'); // Warning
    expect(mapDiagnosticCategory(2)).toBeNull(); // Suggestion
    expect(mapDiagnosticCategory(3)).toBeNull(); // Message
  });
});
