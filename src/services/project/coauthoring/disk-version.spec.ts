import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAppState } from '@/state';
import { readDiskVersion } from './disk-version';
import { SceneDiskStateService } from './SceneDiskStateService';
import { MemoryStorage } from './memory-storage.spec-helper';
import { SCENE_PATH, agentScene, createMergeHarness } from './merge-harness.spec-helper';

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const withBom = (text: string): Uint8Array => {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(BOM.length + body.length);
  out.set(BOM, 0);
  out.set(body, BOM.length);
  return out;
};
const nodeSha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

beforeEach(() => {
  resetAppState();
});

describe('co-authoring hashes raw bytes', () => {
  it('a BOM file hashes equal to node:crypto over its bytes (not over the decoded text)', async () => {
    const storage = new MemoryStorage();
    const bytes = withBom('version: 1.0.0\r\nroot: []\r\n');
    storage.setBytes('scenes/bom.pix3scene', bytes);

    const version = (await readDiskVersion(storage, 'scenes/bom.pix3scene'))!;
    expect(version.hash).toBe(nodeSha(bytes));
    expect(version.text.startsWith('version')).toBe(true); // the BOM is gone from the text…
    expect(version.hash).not.toBe(nodeSha(new TextEncoder().encode(version.text))); // …not the hash
    expect(await readDiskVersion(storage, 'scenes/missing.pix3scene')).toBeNull();

    const diskState = new SceneDiskStateService();
    await diskState.recordRead('res://scenes/bom.pix3scene', version.bytes, version.text);
    expect(diskState.isKnownHash('scenes/bom.pix3scene', nodeSha(bytes))).toBe(true);
  });

  it('an agent’s BOM file is loaded, recognised as known, and the next save is not refused', async () => {
    const h = await createMergeHarness();
    h.agentWrites(withBom(agentScene({ ax: 33 })));
    await h.settleExternal();
    expect(h.positionOfA()).toEqual([33, 20]);
    expect(h.diskState.getKnown(SCENE_PATH)?.hash).toBe(nodeSha(h.storage.bytes.get(SCENE_PATH)!));

    // Nothing changed since: a re-report is dropped as the known version.
    const listener = vi.fn();
    h.externalChanges.onExternalBatch(listener);
    await h.settleExternal();
    expect(listener).not.toHaveBeenCalled();

    // The pre-write check compares bytes to bytes: the human's save goes through.
    await h.humanMoveA(50);
    expect((await h.autosave()).outcome).toBe('saved');
    expect(h.diskPositionOfA()).toEqual([50, 20]);
  });
});
