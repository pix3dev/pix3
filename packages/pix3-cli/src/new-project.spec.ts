// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { findProjectRoot, readProjectId } from './manifest.ts';
import { createProject, type PostCreateStep } from './new-project.ts';
import { listTemplates, oneLine, resolveTemplate, resolveTemplatesRoot } from './templates.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pix3-new-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const walk = (dir: string, base: string = dir): string[] =>
  readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full)];
  });

describe('templates', () => {
  it('reads the repo templates in a checkout', () => {
    expect(resolveTemplatesRoot()).toMatch(/src[\\/]templates[\\/]projects$|templates$/);
    const ids = listTemplates().map(t => t.id);
    expect(ids).toContain('recipe-tapper-2d');
    expect(ids).toContain('idea-blank');
  });

  it('marks recipes by design/recipe.md and keeps hidden templates out of lists only', () => {
    const templates = listTemplates();
    expect(templates.find(t => t.id === 'recipe-tapper-2d')?.isRecipe).toBe(true);
    expect(templates.find(t => t.id === 'empty-2d')?.isRecipe).toBe(false);
    expect(templates.find(t => t.id === 'idea-blank')?.hidden).toBe(true);
    const resolved = resolveTemplate('idea-blank', templates);
    expect('template' in resolved && resolved.template.id).toBe('idea-blank');
  });

  it('resolves short recipe names and refuses unknown ones', () => {
    const templates = listTemplates();
    const tapper = resolveTemplate('tapper', templates);
    expect('template' in tapper && tapper.template.id).toBe('recipe-tapper-2d');
    expect('error' in resolveTemplate('nope', templates)).toBe(true);
  });

  it('cuts a description to its first sentence', () => {
    expect(oneLine('One thing. Then another.')).toBe('One thing.');
    expect(oneLine('No full stop')).toBe('No full stop');
  });
});

describe('pix3 new', () => {
  it('copies every file of the recipe and writes an editor-shaped manifest', () => {
    const template = listTemplates().find(t => t.id === 'recipe-tapper-2d');
    if (!template) throw new Error('recipe-tapper-2d missing');
    const dir = join(root, 'my-game');
    const project = createProject({ template, dir });

    for (const file of walk(template.filesDir)) {
      expect(statSync(join(dir, file)).isFile()).toBe(true);
    }
    for (const sub of ['design', 'scenes', 'sprites', 'scripts', 'audio', 'references']) {
      expect(statSync(join(dir, sub)).isDirectory()).toBe(true);
    }

    const manifest = parse(readFileSync(join(dir, 'pix3project.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      version: '1.0.0',
      defaultExportScenePath: 'scenes/menu.pix3scene',
      viewportBaseSize: { width: 1080, height: 1920 },
      projectType: '2d',
      targetPlatform: 'universal',
      metadata: { projectName: 'my-game', templateId: 'recipe-tapper-2d' },
      autoloads: [],
    });
    expect(readProjectId(dir)).toBe(project.projectId);
    expect(project.projectId).toMatch(/^[0-9a-f-]{36}$/);

    const templateJson = JSON.parse(readFileSync(join(dir, '.pix3/template.json'), 'utf8')) as {
      templateId: string;
    };
    expect(templateJson.templateId).toBe('recipe-tapper-2d');
  });

  it('substitutes {{PROJECT_NAME}} in text files', () => {
    const template = listTemplates().find(t => t.id === 'empty-2d');
    if (!template) throw new Error('empty-2d missing');
    const dir = join(root, 'demo');
    createProject({ template, dir, projectName: 'Space Tapper' });
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).not.toContain('{{PROJECT_NAME}}');
    expect(readme).toContain('Space Tapper');
  });

  it('mints a different id per project', () => {
    const template = listTemplates().find(t => t.id === 'empty-2d');
    if (!template) throw new Error('empty-2d missing');
    const a = createProject({ template, dir: join(root, 'a') });
    const b = createProject({ template, dir: join(root, 'b') });
    expect(a.projectId).not.toBe(b.projectId);
  });

  it('refuses a folder that is not empty', () => {
    const template = listTemplates()[0];
    const dir = join(root, 'busy');
    mkdirSync(dir);
    writeFileSync(join(dir, 'x.txt'), 'x');
    expect(() => createProject({ template, dir })).toThrow(/not empty/);
  });

  it('runs post-create steps (the agent-kit extension point)', () => {
    const template = listTemplates()[0];
    const step: PostCreateStep = project => {
      writeFileSync(join(project.dir, 'AGENTS.md'), `# ${project.projectName}\n`);
      return ['AGENTS.md'];
    };
    const project = createProject({ template, dir: join(root, 'kit'), postCreateSteps: [step] });
    expect(project.files).toContain('AGENTS.md');
  });

  it('finds the project root from a subfolder', () => {
    const template = listTemplates()[0];
    const dir = join(root, 'nested');
    createProject({ template, dir });
    expect(findProjectRoot(join(dir, 'scenes'))).toBe(dir);
    expect(findProjectRoot(root)).toBeNull();
  });
});
