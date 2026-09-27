// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createProject } from '../new-project.ts';
import { listTemplates } from '../templates.ts';
import { ProjectFiles } from '../validate/project.ts';
import { errorSummary, runSmoke } from './command.ts';
import { isSmokeFailure } from './report.ts';

/**
 * Golden: every template `pix3 new` can create runs headless with zero errors — its default scene
 * (what `pix3 smoke` picks with no argument) and every other scene a game starts in (not prefabs,
 * not `scenes/ui/` overlays, which are instanced into those). Scaffolded the way a user meets it,
 * so placeholders are substituted and the manifest is real.
 *
 * No template is exempt. A template that genuinely cannot run headless would be listed here with
 * the reason and asserted to fail with exactly that — never silenced.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-smoke-golden-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const FRAMES = 120;

describe('pix3 smoke golden: shipped templates run clean', () => {
  const templates = listTemplates();

  it('finds the templates', () => {
    expect(templates.length).toBeGreaterThan(8);
  });

  for (const template of templates) {
    it(`${template.id} runs ${FRAMES} frames with no errors`, async () => {
      const dir = join(scratch, template.id);
      createProject({ template, dir, projectName: 'Golden' });
      const defaultRun = await runSmoke({ projectRoot: dir, frames: FRAMES });
      expect(errorSummary(defaultRun)).toEqual([]);
      if (isSmokeFailure(defaultRun)) return;
      expect(defaultRun).toMatchObject({ ok: true, frames: FRAMES, firstFrameOk: true });
      expect(defaultRun.nodes.start).toBeGreaterThan(0);
      if (template.entryScenePath) expect(defaultRun.scene).toBe(template.entryScenePath);

      const others = new ProjectFiles(dir)
        .scenes()
        .filter(scene => scene !== defaultRun.scene && !/(^|\/)(prefabs?|ui)\//.test(scene));
      for (const scene of others) {
        const run = await runSmoke({ projectRoot: dir, scene, frames: FRAMES });
        expect(errorSummary(run), scene).toEqual([]);
        expect(run, scene).toMatchObject({ ok: true, frames: FRAMES, firstFrameOk: true });
      }
      const warnings = isSmokeFailure(defaultRun) ? [] : defaultRun.warnings;
      if (warnings.length > 0) {
        console.info(`${template.id}: ${warnings.map(w => `${w.code} ${w.message}`).join('\n  ')}`);
      }
    });
  }
});
