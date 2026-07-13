import { describe, expect, it } from 'vitest';
import { AgentSkillsService } from './AgentSkillsService';

describe('AgentSkillsService', () => {
  const service = new AgentSkillsService();

  it('bundles the three P0 skill packs with non-empty content', () => {
    const ids = service.list().map(skill => skill.id);
    expect(ids).toEqual(['game-prototype', 'asset-generation', 'verify-and-fix']);
    for (const skill of service.list()) {
      expect(skill.content.length).toBeGreaterThan(100);
      expect(skill.whenToUse).toBeTruthy();
    }
  });

  it('emits one index line per skill', () => {
    const lines = service.indexLines();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^- game-prototype — /);
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
});
