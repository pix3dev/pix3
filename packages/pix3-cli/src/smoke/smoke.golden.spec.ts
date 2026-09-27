// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createProject } from '../new-project.ts';
import { listTemplates } from '../templates.ts';
import { ProjectFiles } from '../validate/project.ts';
import { errorSummary, runSmokeSet } from './command.ts';
import { isSmokeFailure } from './report.ts';
import { STARTUP_SCENE } from './select-scenes.ts';

/**
 * Golden: every template `pix3 new` can create runs headless with zero errors — every scene a game
 * starts in (not prefabs, not `scenes/ui/` overlays, which are instanced into those), which is what
 * `pix3 smoke` with no argument runs outside git. Scaffolded the way a user meets it, so
 * placeholders are substituted and the manifest is real.
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
    it(`${template.id} runs ${FRAMES} frames with no errors in every top-level scene`, async () => {
      const dir = join(scratch, template.id);
      createProject({ template, dir, projectName: 'Golden' });
      const set = await runSmokeSet({ projectRoot: dir, frames: FRAMES, changedFiles: null });
      if ('code' in set) throw new Error(`${set.code}: ${set.reason}`);
      expect(set.selection).toBe('all');
      const scenes = set.runs.map(run => run.scene);
      const expected = new ProjectFiles(dir)
        .scenes()
        .filter(scene => !/(^|\/)(prefabs?|ui)\//.test(scene));
      expect([...scenes].sort()).toEqual(expected.sort());
      // The game before the menu: the editor's startup scene is the one an agent iterates on.
      if (expected.includes(STARTUP_SCENE)) expect(scenes[0]).toBe(STARTUP_SCENE);
      if (template.entryScenePath) expect(scenes).toContain(template.entryScenePath);
      for (const run of set.runs) {
        expect(errorSummary(run), run.scene).toEqual([]);
        if (isSmokeFailure(run)) continue;
        expect(run, run.scene).toMatchObject({ ok: true, frames: FRAMES, firstFrameOk: true });
        expect(run.nodes.start, run.scene).toBeGreaterThan(0);
        if (run.warnings.length > 0) {
          console.info(
            `${template.id} ${run.scene}: ${run.warnings.map(w => `${w.code} ${w.message}`).join('\n  ')}`
          );
        }
      }
      expect(set.ok).toBe(true);
    }, 30_000);
  }
});
