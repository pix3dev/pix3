import { describe, expect, it } from 'vitest';

import {
  getAllShaderEffectTypes,
  getShaderEffectType,
  registerShaderEffect,
} from './ShaderEffectRegistry';
import type { ShaderEffectTypeInfo } from './shader-effect-types';

function makeInfo(overrides: Partial<ShaderEffectTypeInfo>): ShaderEffectTypeInfo {
  return {
    id: 'test:sample',
    key: 'sample',
    displayName: 'Sample',
    description: '',
    category: 'Test',
    keywords: [],
    define: 'PIX3_FX_SAMPLE',
    chunks: [],
    params: [],
    createUniforms: () => ({}),
    ...overrides,
  };
}

describe('ShaderEffectRegistry', () => {
  it('lazily seeds the four built-in effects', () => {
    const ids = getAllShaderEffectTypes().map(e => e.id);
    expect(ids).toEqual(
      expect.arrayContaining(['core:dissolve', 'core:rim', 'core:uv-scroll', 'core:flash'])
    );
    expect(getShaderEffectType('core:dissolve')?.key).toBe('dissolve');
    expect(getShaderEffectType('core:nope')).toBeUndefined();
  });

  it('rejects a duplicate id', () => {
    expect(() => registerShaderEffect(makeInfo({ id: 'core:dissolve', key: 'dupId' }))).toThrow(
      /duplicate effect id/
    );
  });

  it('rejects a duplicate key', () => {
    expect(() =>
      registerShaderEffect(makeInfo({ id: 'test:dupKey', key: 'dissolve' }))
    ).toThrow(/key "dissolve" already used/);
  });

  it('rejects an identifier-unsafe key', () => {
    expect(() => registerShaderEffect(makeInfo({ id: 'test:badkey', key: 'bad.key' }))).toThrow(
      /invalid effect key/
    );
  });

  it('rejects an identifier-unsafe param key', () => {
    expect(() =>
      registerShaderEffect(
        makeInfo({
          id: 'test:badparam',
          key: 'badparam',
          params: [{ key: 'not ok', type: 'number', default: 0 }],
        })
      )
    ).toThrow(/invalid param key/);
  });
});
