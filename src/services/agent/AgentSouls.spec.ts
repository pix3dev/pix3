import { describe, expect, it } from 'vitest';
import { resolveSoul, SOUL_PRESETS, DEFAULT_SOUL_ID } from '@/services/agent/AgentSouls';

describe('resolveSoul', () => {
  const brobot = SOUL_PRESETS.find(soul => soul.id === DEFAULT_SOUL_ID)!;

  it('resolves a named preset to its name and prompt', () => {
    const resolved = resolveSoul({ soulId: 'anuta', customSoulName: '', customSoulPrompt: '' });
    const anuta = SOUL_PRESETS.find(soul => soul.id === 'anuta')!;
    expect(resolved.name).toBe(anuta.name);
    expect(resolved.prompt).toBe(anuta.prompt);
  });

  it("resolves the 'professional' preset to Pix3 Agent with no persona", () => {
    const resolved = resolveSoul({
      soulId: 'professional',
      customSoulName: '',
      customSoulPrompt: '',
    });
    expect(resolved.name).toBe('Pix3 Agent');
    expect(resolved.prompt).toBe('');
  });

  it('resolves a custom soul to its trimmed name and prompt', () => {
    const resolved = resolveSoul({
      soulId: 'custom',
      customSoulName: '  Kevin  ',
      customSoulPrompt: '  You are Kevin, a duck.  ',
    });
    expect(resolved.name).toBe('Kevin');
    expect(resolved.prompt).toBe('You are Kevin, a duck.');
  });

  it('falls back to Pix3 Agent when the custom name is blank', () => {
    const resolved = resolveSoul({
      soulId: 'custom',
      customSoulName: '   ',
      customSoulPrompt: 'A duck.',
    });
    expect(resolved.name).toBe('Pix3 Agent');
    expect(resolved.prompt).toBe('A duck.');
  });

  it('falls back to the default (Brobot) preset for an unknown id', () => {
    const resolved = resolveSoul({ soulId: 'nope', customSoulName: '', customSoulPrompt: '' });
    expect(resolved.name).toBe(brobot.name);
    expect(resolved.prompt).toBe(brobot.prompt);
  });
});
