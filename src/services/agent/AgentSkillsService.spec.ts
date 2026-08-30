import { describe, expect, it } from 'vitest';
import { OFF_PACKAGE_TOPICS } from '@/core/engine-source';

import { AgentSkillsService } from './AgentSkillsService';

describe('AgentSkillsService', () => {
  const service = new AgentSkillsService();

  it('bundles the shipped skill packs with non-empty content', () => {
    const ids = service.list().map(skill => skill.id);
    expect(ids).toEqual([
      'idea-stage',
      'flow-increment',
      'game-prototype',
      'asset-generation',
      'verify-and-fix',
    ]);
    for (const skill of service.list()) {
      expect(skill.content.length).toBeGreaterThan(100);
      expect(skill.whenToUse).toBeTruthy();
    }
  });

  it('emits one index line per skill', () => {
    const lines = service.indexLines();
    expect(lines).toHaveLength(5);
    // The two Flow stage skills lead the index in stage order: at the idea stage `idea-stage` is
    // the first thing to read, at the prototype stage `flow-increment` is.
    expect(lines[0]).toMatch(/^- idea-stage — /);
    expect(lines[1]).toMatch(/^- flow-increment — /);
    expect(lines[2]).toMatch(/^- game-prototype — /);
  });

  it('reads the whole skill by id', () => {
    expect(service.read('game-prototype')).toContain('game-prototype');
    expect(service.read('unknown')).toBeNull();
  });

  it('slices to a matching section (case-insensitive contains)', () => {
    const section = service.read('asset-generation', 'pick the right preset');
    expect(section).not.toBeNull();
    expect(section).toMatch(/sprite/);
    // The slice stops before the next top-level/section heading.
    expect(section).not.toMatch(/Extract style tokens once/);
  });

  it('returns null for an unknown section', () => {
    expect(service.read('verify-and-fix', 'no such heading here')).toBeNull();
  });

  it('honours the section pointer `engine_search` hands out for off-package topics', () => {
    // `engine_search` answers physics queries with a note ending in
    // `read_skill('game-prototype', 'Rapier')`. Renaming that heading would break the pointer
    // silently — the agent would get a null and be back where the note was written to rescue it.
    for (const topic of OFF_PACKAGE_TOPICS) {
      const pointer = /read_skill\('([^']+)', '([^']+)'\)/.exec(topic.note);
      expect(pointer, `topic ${topic.id} has no read_skill pointer`).not.toBeNull();
      if (!pointer) continue;
      expect(
        service.read(pointer[1], pointer[2]),
        `${topic.id} points at a dead section`
      ).toBeTruthy();
    }
  });
});
