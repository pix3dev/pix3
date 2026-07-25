// @vitest-environment node
import path from 'path';
import { describe, expect, it } from 'vitest';

import { config } from '../../config.js';
import { getItemDir, resolveSafePath } from './library-storage.js';

describe('library-storage', () => {
  const itemDir = getItemDir('item-1');

  it('keeps an item directory inside the storage root', () => {
    expect(getItemDir('../../etc')).toBe(
      path.resolve(config.LIBRARY_STORAGE_DIR, encodeURIComponent('../../etc'))
    );
    expect(getItemDir('item-1').startsWith(path.resolve(config.LIBRARY_STORAGE_DIR))).toBe(true);
  });

  it('resolves a nested bundle path', () => {
    expect(resolveSafePath(itemDir, 'textures/btn.png')).toBe(
      path.join(itemDir, 'textures', 'btn.png')
    );
  });

  it('rejects paths that escape the item directory', () => {
    expect(resolveSafePath(itemDir, '../evil.txt')).toBeNull();
    expect(resolveSafePath(itemDir, 'nested/../../evil.txt')).toBeNull();
    expect(resolveSafePath(itemDir, path.resolve('/etc/passwd'))).toBeNull();
  });

  it('rejects paths that name the directory itself', () => {
    // Callers write to / send the result as a file: a directory handle would be an EISDIR 500.
    expect(resolveSafePath(itemDir, '')).toBeNull();
    expect(resolveSafePath(itemDir, '.')).toBeNull();
    expect(resolveSafePath(itemDir, 'a/..')).toBeNull();
  });
});
