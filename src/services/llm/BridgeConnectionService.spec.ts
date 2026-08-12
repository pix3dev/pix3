import { describe, expect, it } from 'vitest';

import {
  readPairingTokenFromHash,
  stripPairingTokenFromHash,
} from '@/services/llm/BridgeConnectionService';

/**
 * The pairing link (`<editor>/#bridge-token=…`) is how the bridge hands the editor its token without
 * a copy-paste. Two properties matter and are easy to break: the token must survive URL escaping
 * intact (it is base64url, so `-`/`_` and a possible `%3D` are all in play), and it must be removed
 * from the hash without taking any co-located routing (`#welcome`) with it.
 */
describe('bridge pairing link', () => {
  it('reads a token that shares the hash with a route', () => {
    expect(readPairingTokenFromHash('#bridge-token=abc123')).toBe('abc123');
    expect(readPairingTokenFromHash('#welcome&bridge-token=abc123')).toBe('abc123');
    expect(readPairingTokenFromHash('#bridge-token=abc123&welcome')).toBe('abc123');
  });

  it('decodes escaped characters and rejects an empty value', () => {
    expect(readPairingTokenFromHash('#bridge-token=a%2Bb%2Fc%3D')).toBe('a+b/c=');
    expect(readPairingTokenFromHash('#bridge-token=')).toBeNull();
    expect(readPairingTokenFromHash('#welcome')).toBeNull();
    expect(readPairingTokenFromHash('')).toBeNull();
  });

  it('keeps a base64url token (the bridge format) byte-for-byte', () => {
    const token = 'BHB3-_xyzABCDEFGHIJKLMNOPQRSTzWLe';
    expect(readPairingTokenFromHash(`#bridge-token=${encodeURIComponent(token)}`)).toBe(token);
  });

  it('strips only the pairing entry, preserving the rest of the hash', () => {
    expect(stripPairingTokenFromHash('#bridge-token=abc123')).toBe('');
    expect(stripPairingTokenFromHash('#welcome&bridge-token=abc123')).toBe('#welcome');
    expect(stripPairingTokenFromHash('#bridge-token=abc123&welcome')).toBe('#welcome');
    expect(stripPairingTokenFromHash('#welcome')).toBe('#welcome');
  });

  it('ignores a key that merely starts with the pairing key', () => {
    expect(readPairingTokenFromHash('#bridge-token-legacy=abc123')).toBeNull();
    expect(stripPairingTokenFromHash('#bridge-token-legacy=abc123')).toBe(
      '#bridge-token-legacy=abc123'
    );
  });
});
