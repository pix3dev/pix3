import { describe, expect, it } from 'vitest';
import { ProjectTemplateService } from './ProjectTemplateService';

/**
 * The `hidden` flag exists for exactly one reason: `idea-blank` is scaffolding a code path picks on
 * the user's behalf, and it must not surface anywhere a template is offered as a CHOICE — not in the
 * create-project picker and not in the Flow recipe resolver, which falls back to "any 2D template"
 * and would otherwise hand a prototype an empty canvas.
 */
describe('ProjectTemplateService — hidden templates', () => {
  const service = new ProjectTemplateService();

  it('parses `hidden: true` out of template.yaml', () => {
    expect(service.getTemplate('idea-blank')?.hidden).toBe(true);
  });

  it('keeps hidden templates out of the visible list', () => {
    const visible = service.getVisibleTemplates().map(template => template.id);
    expect(visible).not.toContain('idea-blank');
    expect(visible.length).toBeGreaterThan(0);
    // The bundled starters are still listed — the filter is a filter, not a purge.
    expect(visible).toContain('empty-2d');
  });

  it('still returns a hidden template by id, and still lists it in the complete set', () => {
    expect(service.getTemplate('idea-blank')?.id).toBe('idea-blank');
    expect(service.getTemplates().map(template => template.id)).toContain('idea-blank');
  });

  it('leaves every other template unhidden', () => {
    const hidden = service
      .getTemplates()
      .filter(template => template.hidden === true)
      .map(template => template.id);
    expect(hidden).toEqual(['idea-blank']);
  });
});
