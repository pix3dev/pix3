import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isDocumentActive,
  isDocumentVisible,
  isEditorActive,
  isEditorKeepAlive,
  onEditorKeepAliveChange,
  setEditorKeepAlive,
} from '@/services/core/page-activity';

const doc = (visibilityState: DocumentVisibilityState, focused: boolean): Document =>
  ({ visibilityState, hasFocus: () => focused }) as unknown as Document;

afterEach(() => {
  setEditorKeepAlive(false);
});

describe('page-activity', () => {
  it('isEditorActive = document active OR keepalive; the raw helpers ignore keepalive', () => {
    const cases: Array<[DocumentVisibilityState, boolean, boolean, boolean]> = [
      // visibility, focused, keepalive → isEditorActive
      ['visible', true, false, true],
      ['visible', false, false, false],
      ['hidden', false, false, false],
      ['visible', false, true, true],
      ['hidden', false, true, true],
    ];
    for (const [visibility, focused, keepalive, expected] of cases) {
      setEditorKeepAlive(keepalive);
      const d = doc(visibility, focused);
      expect(isEditorActive(d), `${visibility}/${focused}/${keepalive}`).toBe(expected);
      expect(isDocumentActive(d)).toBe(visibility === 'visible' && focused);
      expect(isDocumentVisible(d)).toBe(visibility === 'visible');
    }
  });

  it('notifies listeners on changes only, and stops after unsubscribe', () => {
    const listener = vi.fn();
    const off = onEditorKeepAliveChange(listener);
    setEditorKeepAlive(true);
    setEditorKeepAlive(true);
    expect(isEditorKeepAlive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    setEditorKeepAlive(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
