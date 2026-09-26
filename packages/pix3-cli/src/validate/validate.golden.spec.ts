// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { createProject } from '../new-project.ts';
import { listTemplates } from '../templates.ts';
import type { Diagnostic } from './diagnostics.ts';
import { validateProject } from './validate.ts';

/**
 * Golden test against false errors (plan §5 A): every scene and prefab the editor ships must pass
 * `pix3 validate` — both levels — with zero errors. A template is validated the way a user meets
 * it: scaffolded by `pix3 new` (placeholders substituted, manifest written), then validated as a
 * whole project, so unused-asset and prefab checks see the real tree. Warnings are allowed and
 * printed, so a new one is visible in the test output rather than silently accepted.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-validate-golden-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const EDITOR_TEMPLATES_DIR = fileURLToPath(new URL('../../../../src/templates/', import.meta.url));

const summarize = (label: string, diagnostics: readonly Diagnostic[]): void => {
  const warnings = diagnostics.filter(d => d.severity === 'warning');
  if (warnings.length === 0) return;
  console.info(
    `${label}: ${warnings.length} warning(s)\n${warnings
      .map(w => `  ${w.file}${w.line ? `:${w.line}` : ''} ${w.code} ${w.message}`)
      .join('\n')}`
  );
};

const errorLines = (diagnostics: readonly Diagnostic[]): string[] =>
  diagnostics
    .filter(d => d.severity === 'error')
    .map(d => `${d.file}${d.line ? `:${d.line}` : ''} ${d.code} ${d.message}`);

describe('pix3 validate golden: shipped templates have no errors', () => {
  const templates = listTemplates();

  it('finds the templates', () => {
    expect(templates.length).toBeGreaterThan(8);
  });

  for (const template of templates) {
    it(`${template.id} validates clean (levels 1 and 2)`, async () => {
      const dir = join(scratch, template.id);
      createProject({ template, dir, projectName: 'Golden' });
      const report = await validateProject({ projectRoot: dir });
      summarize(template.id, report.diagnostics);
      expect(report.files.length).toBeGreaterThan(0);
      expect(errorLines(report.diagnostics)).toEqual([]);
      // Level 2 must actually have hydrated every scene, user scripts included.
      expect(report.level2).toMatchObject({ state: 'ran', filesSkipped: 0 });
      expect(report.notes).toEqual([]);
    });
  }

  const editorScenes = readdirSync(EDITOR_TEMPLATES_DIR).filter(f => f.endsWith('.pix3scene'));

  it('finds the editor-level template scenes (src/templates/*.pix3scene)', () => {
    expect(editorScenes).toContain('startup-scene.pix3scene');
  });

  for (const scene of editorScenes) {
    it(`src/templates/${scene} validates clean`, async () => {
      const report = await validateProject({ projectRoot: EDITOR_TEMPLATES_DIR, files: [scene] });
      summarize(scene, report.diagnostics);
      expect(errorLines(report.diagnostics)).toEqual([]);
      expect(report.level2).toMatchObject({ state: 'ran', filesHydrated: 1 });
    });
  }
});
