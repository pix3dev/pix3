import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeCodexImage } from './codex-image.ts';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';

test('Codex image payload is decoded from base64 or a data URL', () => {
  assert.deepEqual(decodeCodexImage(PNG), { mimeType: 'image/png', data: PNG });
  assert.deepEqual(decodeCodexImage(`data:image/png;base64,${PNG}`), {
    mimeType: 'image/png',
    data: PNG,
  });
});

test('Codex image payload rejects text and mismatched formats', () => {
  assert.throws(
    () => decodeCodexImage(Buffer.from('not an image').toString('base64')),
    /unsupported image format/
  );
  assert.throws(
    () => decodeCodexImage(`data:image/jpeg;base64,${PNG}`),
    /unsupported image format/
  );
});
