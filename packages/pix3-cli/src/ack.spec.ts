// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ACK_FILE, ackFile, readAndAck } from './ack.ts';

let root: string;
const BOM_SCENE = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from('version: 1.0.0\r\nroot: []\r\n'),
]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const acks = () => JSON.parse(readFileSync(join(root, ACK_FILE), 'utf8')).acks;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pix3-ack-'));
  writeFileSync(join(root, 'pix3project.yaml'), 'name: t\n');
  mkdirSync(join(root, 'scenes'));
  writeFileSync(join(root, 'scenes', 'main.pix3scene'), BOM_SCENE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('pix3 read', () => {
  it('returns the raw bytes and acks exactly their hash (BOM and CRLF included)', () => {
    const { bytes, record } = readAndAck({
      cwd: join(root, 'scenes'),
      file: 'main.pix3scene',
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    expect(Buffer.from(bytes).equals(BOM_SCENE)).toBe(true);
    expect(record).toEqual({
      path: 'scenes/main.pix3scene',
      sha256: sha(BOM_SCENE),
      at: '2026-09-26T10:00:00.000Z',
    });
    expect(acks()).toEqual([record]);
  });

  it('refuses files outside the project and under .pix3/', () => {
    expect(() => readAndAck({ cwd: root, file: '../elsewhere.txt' })).toThrow(/not inside/);
    expect(() => readAndAck({ cwd: root, file: '.pix3/protected.json' })).toThrow(/private/);
  });
});

describe('pix3 ack', () => {
  it('appends the given hash, keeping earlier acks and deduplicating the same pair', () => {
    const hash = 'a'.repeat(64);
    ackFile({ cwd: root, file: 'scenes/main.pix3scene', hash });
    ackFile({ cwd: root, file: 'res://scenes/main.pix3scene', hash: 'B'.repeat(64) });
    ackFile({ cwd: root, file: 'scenes/main.pix3scene', hash });
    expect(acks().map((a: { sha256: string }) => a.sha256)).toEqual(['b'.repeat(64), hash]);
  });

  it('without --sha256 hashes the current bytes; rejects a malformed hash', () => {
    expect(ackFile({ cwd: root, file: 'scenes/main.pix3scene' }).sha256).toBe(sha(BOM_SCENE));
    expect(() => ackFile({ cwd: root, file: 'scenes/main.pix3scene', hash: 'xyz' })).toThrow(
      /64 hex/
    );
  });
});
