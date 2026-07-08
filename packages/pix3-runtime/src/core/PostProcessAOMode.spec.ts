import { afterEach, describe, expect, it } from 'vitest';

import { PostProcess, setProjectAODefault, getProjectAODefault } from '../nodes/PostProcess';

function makePost(aoMode: string): PostProcess {
  // bloom off so isActive()/SSAO reflect the AO mode alone.
  return new PostProcess({ id: 'pp', aoMode, bloomEnabled: false });
}

describe('PostProcess AO-mode cascade', () => {
  afterEach(() => {
    setProjectAODefault('baked'); // reset the global sink between tests
  });

  it('resolves an explicit mode directly', () => {
    expect(makePost('realtime').getResolvedAOMode()).toBe('realtime');
    expect(makePost('baked').getResolvedAOMode()).toBe('baked');
    expect(makePost('off').getResolvedAOMode()).toBe('off');
  });

  it('inherit resolves to the project default (top of the cascade)', () => {
    const node = makePost('inherit');
    setProjectAODefault('realtime');
    expect(node.getResolvedAOMode()).toBe('realtime');
    expect(getProjectAODefault()).toBe('realtime');
    setProjectAODefault('off');
    expect(node.getResolvedAOMode()).toBe('off');
  });

  it('an explicit node mode overrides the project default', () => {
    setProjectAODefault('baked');
    expect(makePost('realtime').getResolvedAOMode()).toBe('realtime');
  });

  it('project default clamps invalid / inherit values to baked', () => {
    setProjectAODefault('inherit'); // not a valid project default
    expect(getProjectAODefault()).toBe('baked');
    setProjectAODefault('nonsense');
    expect(getProjectAODefault()).toBe('baked');
  });

  it('drives ssao.enabled and isActive only when resolved to realtime', () => {
    const node = makePost('inherit');
    setProjectAODefault('baked');
    expect(node.getConfig().ssao.enabled).toBe(false);
    expect(node.isActive()).toBe(false);
    setProjectAODefault('realtime');
    expect(node.getConfig().ssao.enabled).toBe(true);
    expect(node.isActive()).toBe(true);
  });
});
