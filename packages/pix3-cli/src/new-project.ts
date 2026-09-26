import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

import {
  PROJECT_MANIFEST_FILE,
  buildManifestPayload,
  createProjectId,
  renderManifest,
} from './manifest.ts';
import type { TemplateInfo } from './templates.ts';
import { CLI_VERSION } from './version.ts';

/**
 * `pix3 new <recipe> [dir]` — the file-level equivalent of the editor's
 * `ProjectService.applyTemplateFiles`: same base directories, same `{{PROJECT_NAME}}`
 * substitution, same manifest, same `.pix3/template.json`. What it deliberately does NOT write yet
 * is the agent kit (`AGENTS.md`, `.claude/skills/…`, types, MCP config) — that is phase 1 and
 * plugs in through {@link PostCreateStep}.
 */

/** The editor's flat base layout plus its companion folders (`design`, `references`). */
const BASE_DIRECTORIES = ['design', 'scenes', 'sprites', 'scripts', 'audio', 'references'];

/** Extensions the editor imports as text (and runs `{{PROJECT_NAME}}` over). */
const TEXT_EXTENSIONS = new Set(['.pix3scene', '.ts', '.md', '.yaml', '.yml', '.json', '.txt']);

export interface CreatedProject {
  readonly dir: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly template: TemplateInfo;
  /** Project-relative paths of every file written. */
  readonly files: string[];
}

/**
 * Extension point for everything that lands in a project after the template: the agent kit
 * (plan §5 B), `.pix3/types/@pix3/runtime`, `tsconfig.json`, the pinned MCP config (§5 A). Each
 * step gets the finished project and reports the files it wrote.
 */
export type PostCreateStep = (project: CreatedProject) => string[];

/** Phase 0 ships none. Phase 1 appends `installAgentKit` here. */
export const DEFAULT_POST_CREATE_STEPS: readonly PostCreateStep[] = [];

export interface CreateProjectOptions {
  readonly template: TemplateInfo;
  readonly dir: string;
  /** Defaults to the target folder's name, like the editor defaults to the folder handle name. */
  readonly projectName?: string;
  readonly projectId?: string;
  readonly postCreateSteps?: readonly PostCreateStep[];
}

const walkFiles = (root: string, dir: string = root): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(root, full));
    else if (entry.isFile()) out.push(relative(root, full).split('\\').join('/'));
  }
  return out.sort();
};

export const createProject = (options: CreateProjectOptions): CreatedProject => {
  const dir = resolve(options.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} is not empty. Choose an empty or new folder for a new project.`);
  }
  const template = options.template;
  const projectName = (options.projectName ?? basename(dir)).trim() || 'Pix3 Project';
  const projectId = options.projectId ?? createProjectId();
  const written: string[] = [];

  const writeFile = (relativePath: string, contents: string | Buffer): void => {
    const target = join(dir, relativePath);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
    written.push(relativePath);
  };

  for (const sub of [...BASE_DIRECTORIES, ...template.directories]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }

  writeFile(
    PROJECT_MANIFEST_FILE,
    renderManifest(buildManifestPayload(template, { projectName, projectId }))
  );

  for (const relativePath of walkFiles(template.filesDir)) {
    const source = join(template.filesDir, relativePath);
    if (TEXT_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
      writeFile(
        relativePath,
        readFileSync(source, 'utf8').replaceAll('{{PROJECT_NAME}}', projectName)
      );
    } else {
      writeFile(relativePath, readFileSync(source));
    }
  }

  writeFile(
    '.pix3/template.json',
    JSON.stringify(
      {
        templateId: template.id,
        editorVersion: CLI_VERSION,
        createdBy: '@pix3/cli',
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n'
  );

  const created: CreatedProject = { dir, projectId, projectName, template, files: written };
  for (const step of options.postCreateSteps ?? DEFAULT_POST_CREATE_STEPS) {
    written.push(...step(created));
  }
  return created;
};
