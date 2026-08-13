import { describe, expect, it } from 'vitest';

import { ResourceManager } from './ResourceManager';

const HELLO_BASE64 = btoa('hello');

describe('ResourceManager embedded resources', () => {
  it('reports no embedded resources for a plain hosted build', () => {
    const manager = new ResourceManager('./');

    expect(manager.hasEmbeddedResources).toBe(false);
    expect(manager.hasEmbeddedResource('res://assets/.atlas/atlas-manifest.json')).toBe(false);
  });

  it('answers membership for a single-file build through the same path normalization as reads', async () => {
    const manager = new ResourceManager('./', {
      'assets/greeting.txt': { base64: HELLO_BASE64, mimeType: 'text/plain' },
    });

    expect(manager.hasEmbeddedResources).toBe(true);
    // res:// prefix, leading slash and backslashes all resolve to the same entry
    // a read would find — the probe must not disagree with readText.
    expect(manager.hasEmbeddedResource('res://assets/greeting.txt')).toBe(true);
    expect(manager.hasEmbeddedResource('/assets/greeting.txt')).toBe(true);
    expect(manager.hasEmbeddedResource('assets\\greeting.txt')).toBe(true);
    await expect(manager.readText('res://assets/greeting.txt')).resolves.toBe('hello');

    // The reason the probe exists: a single-file build has no siblings, so this
    // one would otherwise fall through to a network request that cannot succeed.
    expect(manager.hasEmbeddedResource('res://assets/.atlas/atlas-manifest.json')).toBe(false);
  });

  it('does not treat remote URLs as embedded', () => {
    const manager = new ResourceManager('./', {
      'assets/greeting.txt': { base64: HELLO_BASE64 },
    });

    expect(manager.hasEmbeddedResource('https://example.com/assets/greeting.txt')).toBe(false);
  });
});
