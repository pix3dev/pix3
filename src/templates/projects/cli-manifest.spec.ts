import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { ServiceContainer, ServiceLifetime } from '@/fw/di';
import { normalizeProjectManifest, type ProjectManifest } from '@/core/ProjectManifest';
import { createProject } from '../../../packages/pix3-cli/src/new-project.ts';
import { listTemplates } from '../../../packages/pix3-cli/src/templates.ts';

/**
 * `pix3 new` (packages/pix3-cli) writes `pix3project.yaml` without the editor, so nothing but this
 * spec keeps the two from drifting. For every template the CLI's manifest must equal, byte for byte
 * apart from the id, what the editor writes for a new project from that template — the real
 * `ProjectLifecycleService.createManifest` serialised by the real `ProjectService.saveProjectManifest`
 * — and the editor must keep the CLI's `metadata.projectId` through a load/save cycle. Both sides
 * mint that id on creation (`createProjectId`), so the comparison swaps the CLI's into the editor's.
 */

const writes = new Map<string, string>();

vi.mock('@/services/project/ProjectStorageService', () => ({
  ProjectStorageService: class {
    writeTextFile = vi.fn(async (path: string, contents: string) => {
      writes.set(path, contents);
    });
  },
}));
vi.mock('@/services/project/FileSystemAPIService', () => ({
  FileSystemAPIService: class {},
  resolveFileSystemAPIService: () => ({}),
}));

const { ProjectStorageService } = await import('@/services/project/ProjectStorageService');
const { ProjectTemplateService } = await import('@/services/project/ProjectTemplateService');
const { ProjectService } = await import('@/services/project/ProjectService');
const { ProjectLifecycleService } = await import('@/services/project/ProjectLifecycleService');

const container = ServiceContainer.getInstance();
container.addService(
  container.getOrCreateToken(ProjectStorageService),
  ProjectStorageService,
  ServiceLifetime.Singleton
);
container.addService(
  container.getOrCreateToken(ProjectTemplateService),
  ProjectTemplateService,
  ServiceLifetime.Singleton
);

const editorTemplates = new ProjectTemplateService();
const projectService = new ProjectService();
const lifecycle = new ProjectLifecycleService() as unknown as {
  createManifest(params: Record<string, unknown>): ProjectManifest;
};

const editorManifestYaml = async (manifest: ProjectManifest): Promise<string> => {
  await projectService.saveProjectManifest(manifest);
  return writes.get('pix3project.yaml') ?? '';
};

const root = mkdtempSync(join(tmpdir(), 'pix3-cli-manifest-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('pix3 new → pix3project.yaml the editor would write', () => {
  // Under happy-dom `import.meta.url` is not a file URL, so the CLI cannot locate the repo
  // templates by itself here; point it at the same folder it would find in a checkout.
  const cliTemplates = listTemplates(resolve(process.cwd(), 'src/templates/projects'));

  it('sees the same templates as the editor', () => {
    expect(cliTemplates.map(t => t.id).sort()).toEqual(
      editorTemplates
        .getTemplates()
        .map(t => t.id)
        .sort()
    );
  });

  for (const template of cliTemplates) {
    it(`matches the editor for ${template.id}`, async () => {
      const editorTemplate = editorTemplates.getTemplate(template.id);
      if (!editorTemplate) throw new Error(`editor has no template ${template.id}`);
      const project = createProject({
        template,
        dir: join(root, template.id),
        projectName: 'Cli Game',
      });
      const cliYaml = readFileSync(join(project.dir, 'pix3project.yaml'), 'utf8');

      // What the create dialog submits for this template with its defaults (`applyTemplateDefaults`).
      const editorManifest = lifecycle.createManifest({
        name: 'Cli Game',
        backend: 'local',
        viewportBaseWidth: editorTemplate.viewport.width,
        viewportBaseHeight: editorTemplate.viewport.height,
        templateId: editorTemplate.id,
        projectType: editorTemplate.projectType,
        targetPlatform: editorTemplate.targetPlatform,
      });
      // Both mint a random `metadata.projectId`, in the same position; swap in the CLI's to compare.
      expect(editorManifest.metadata?.projectId).toMatch(/^[0-9a-f-]{36}$/);
      expect(editorManifest.metadata?.projectId).not.toBe(project.projectId);
      const withId: ProjectManifest = {
        ...editorManifest,
        metadata: { ...editorManifest.metadata, projectId: project.projectId },
      };
      expect(cliYaml).toBe(await editorManifestYaml(withId));

      // Round trip through the editor's loader + saver keeps the stable id.
      const reloaded = normalizeProjectManifest(parse(cliYaml));
      expect(reloaded.metadata?.projectId).toBe(project.projectId);
      expect(await editorManifestYaml(reloaded)).toBe(cliYaml);
    });
  }
});
