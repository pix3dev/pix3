/**
 * `netKindTable` behaviour. The index *is* the wire `Kind`, so what matters here is that indices are
 * stable, that both spellings of a path resolve to the same one, and that the reserved authored
 * segment can never shift a prefab's kind.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  getNetKindTable,
  NetKindTable,
  registerNetworkPrefab,
  resetNetKindTable,
  setNetworkPrefabTable,
} from './net-kind-table';

const PLAYER = 'res://prefabs/player.pix3scene';
const BOMB = 'res://prefabs/bomb.pix3scene';

describe('NetKindTable', () => {
  afterEach(() => {
    resetNetKindTable();
  });

  it('maps a prefab path to its index and back', () => {
    const table = new NetKindTable([BOMB, PLAYER]);

    expect(table.kindOf(BOMB)).toBe(0);
    expect(table.kindOf(PLAYER)).toBe(1);
    expect(table.prefabPathOf(0)).toBe(BOMB);
    expect(table.prefabPathOf(1)).toBe(PLAYER);
    expect(table.prefabCount).toBe(2);
    expect(table.isEmpty).toBe(false);
  });

  it('resolves a path with or without the res:// scheme, and with either slash', () => {
    const table = new NetKindTable([PLAYER]);

    expect(table.kindOf('prefabs/player.pix3scene')).toBe(0);
    expect(table.kindOf('./prefabs/player.pix3scene')).toBe(0);
    expect(table.kindOf('res://prefabs\\player.pix3scene')).toBe(0);
    // The stored spelling survives, so a lookup by kind still hands back a path the loader takes.
    expect(table.prefabPathOf(0)).toBe(PLAYER);
  });

  it('answers null for an unknown path and an out-of-range kind', () => {
    const table = new NetKindTable([PLAYER]);

    expect(table.kindOf('res://prefabs/ghost.pix3scene')).toBeNull();
    expect(table.prefabPathOf(1)).toBeNull();
    expect(table.prefabPathOf(-1)).toBeNull();
    expect(table.prefabPathOf(1.5)).toBeNull();
  });

  it('collapses a duplicate path onto its first index', () => {
    const table = new NetKindTable([BOMB, PLAYER, 'prefabs/bomb.pix3scene']);

    expect(table.prefabCount).toBe(2);
    expect(table.kindOf(BOMB)).toBe(0);
  });

  it('registers idempotently and appends in call order', () => {
    const table = new NetKindTable();

    expect(table.register(PLAYER)).toBe(0);
    expect(table.register(BOMB)).toBe(1);
    expect(table.register(PLAYER)).toBe(0);
    expect(table.prefabCount).toBe(2);
  });

  it('reserves the authored segment after the prefabs, and refuses to shift it', () => {
    const table = new NetKindTable({ prefabs: [BOMB], authored: ['scene:door-a'] });

    expect(table.size).toBe(2);
    expect(table.prefabCount).toBe(1);
    // Index 1 is an authored binding, not a prefab: resolving it to a prefab path would hand the
    // binder a scene node id to instantiate.
    expect(table.prefabPathOf(1)).toBeNull();
    expect(() => table.register(PLAYER)).toThrow(/authored/);
  });

  it('replaces the whole table rather than merging into it', () => {
    const table = new NetKindTable([PLAYER, BOMB]);
    table.replaceAll([BOMB]);

    expect(table.prefabCount).toBe(1);
    expect(table.kindOf(BOMB)).toBe(0);
    expect(table.kindOf(PLAYER)).toBeNull();
  });

  it('shares one process-wide table for hosts with no explicit one', () => {
    expect(getNetKindTable().isEmpty).toBe(true);

    setNetworkPrefabTable({ prefabs: [BOMB, PLAYER] });
    expect(getNetKindTable().kindOf(PLAYER)).toBe(1);

    // The fallback for a session with no built manifest.
    expect(registerNetworkPrefab('res://prefabs/crate.pix3scene')).toBe(2);
    expect(getNetKindTable().prefabPathOf(2)).toBe('res://prefabs/crate.pix3scene');
  });
});
