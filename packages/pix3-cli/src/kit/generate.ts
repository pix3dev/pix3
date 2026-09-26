import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/**
 * The agent-kit generator (plan §5 B: "Генерируется из существующих источников, а не копируется
 * руками"). Hand-written prose lives in `packages/pix3-cli/kit-src/` as templates; everything that
 * already has a source of truth elsewhere in the repo is pulled in at build time:
 *
 * - `{{include:<repo path>}}` — a whole file;
 * - `{{include:<repo path>#<heading>}}` — one section of a Markdown file: the text under that
 *   heading down to the next heading of the same or a higher level (sub-sections included). The
 *   heading is matched by its descriptive text with any numbering stripped (`7.1 Key Principles` is
 *   `Key Principles`), exactly first, else as a unique prefix. Options after `|`: `heading` (keep
 *   the heading line itself), `only` (stop at the first sub-heading), `shift=<n>` (move every
 *   included heading `n` levels down, or up when negative);
 * - `{{include:<repo path>@<text>}}` — the one paragraph or list item whose text (after `- ` and
 *   `**`) starts with `<text>`;
 * - `{{generated:<name>}}` — a block computed from code (`core-components`, `mcp-tools`,
 *   `mcp-error-codes`);
 * - `{{version}}` — the CLI version; `{{# … }}` — a template comment, removed with its line.
 *
 * Relative Markdown links in included text become plain text (their targets are repo files the
 * project does not have). Any `{{` left after expansion fails the build — the drift spec asserts
 * that too. No dependencies: string work over the files.
 *
 * Output: `<outDir>/files/<project path>` (a `kit-src/skills/<name>/…` template lands at
 * `.claude/skills/<name>/…`) and `<outDir>/kit.json`.
 */

import {
  KIT_FILES_DIR,
  KIT_FORMAT,
  KIT_MANIFEST,
  type CoreComponentInfo,
  type GenerateKitOptions,
  type KitManifestFile,
} from './kit-format.ts';

export type {
  CoreComponentInfo,
  CoreComponentProperty,
  GenerateKitOptions,
  KitManifestFile,
} from './kit-format.ts';
export { KIT_FILES_DIR, KIT_FORMAT, KIT_MANIFEST } from './kit-format.ts';

const DIRECTIVE = /\{\{(include|generated):([^}]+)\}\}|\{\{version\}\}/g;
const COMMENT_LINE = /^[ \t]*\{\{#[^}]*\}\}[ \t]*\r?\n/gm;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

interface Heading {
  readonly index: number;
  readonly level: number;
  readonly text: string;
}

export class KitTemplateError extends Error {}

const normalizeHeading = (text: string): string =>
  text
    .replace(/\\/g, '')
    .replace(/^\d+(?:\.\d+[a-z]?)*\.?\s+/, '') // `7.`, `7.1`, `6.19a`, `6.19a.1` — not `2D`
    .trim()
    .toLowerCase();

const scanHeadings = (lines: readonly string[]): Heading[] => {
  const out: Heading[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const match = HEADING.exec(line);
    if (match) out.push({ index, level: match[1].length, text: match[2] });
  });
  return out;
};

const findHeading = (headings: readonly Heading[], query: string, where: string): Heading => {
  const wanted = normalizeHeading(query);
  const exact = headings.filter(h => normalizeHeading(h.text) === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new KitTemplateError(`${where}: heading "${query}" is ambiguous`);
  const prefixed = headings.filter(h => normalizeHeading(h.text).startsWith(wanted));
  if (prefixed.length === 1) return prefixed[0];
  throw new KitTemplateError(
    prefixed.length === 0
      ? `${where}: no heading "${query}"`
      : `${where}: heading "${query}" matches ${prefixed.length} headings`
  );
};

const shiftHeadings = (lines: string[], shift: number): string[] => {
  if (shift === 0) return lines;
  let fenced = false;
  return lines.map(line => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    const match = HEADING.exec(line);
    if (!match) return line;
    const level = Math.min(6, Math.max(1, match[1].length + shift));
    return `${'#'.repeat(level)} ${match[2]}`;
  });
};

const trimBlock = (lines: string[]): string[] => {
  let start = 0;
  let end = lines.length;
  const blank = (line: string) => line.trim() === '' || line.trim() === '---';
  while (start < end && blank(lines[start])) start++;
  while (end > start && blank(lines[end - 1])) end--;
  return lines.slice(start, end);
};

/** Relative Markdown links → their text (the targets are repo files a project does not have). */
export const unlinkRelative = (text: string): string =>
  text.replace(/(?<!!)\[([^\]\n]+)\]\((?!https?:|mailto:)[^)\s]+\)/g, '$1');

const extractSection = (text: string, query: string, options: string[], where: string): string => {
  const lines = text.split(/\r?\n/);
  const headings = scanHeadings(lines);
  const heading = findHeading(headings, query, where);
  const only = options.includes('only');
  const next = headings.find(h => h.index > heading.index && (only || h.level <= heading.level));
  const body = lines.slice(
    options.includes('heading') ? heading.index : heading.index + 1,
    next?.index ?? lines.length
  );
  const shiftOption = options.find(option => option.startsWith('shift='));
  const shift = shiftOption ? Number(shiftOption.slice('shift='.length)) : 0;
  if (!Number.isInteger(shift)) throw new KitTemplateError(`${where}: bad ${shiftOption}`);
  return trimBlock(shiftHeadings(body, shift)).join('\n');
};

const stripParagraphMarks = (line: string): string =>
  line
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^\*\*/, '');

const extractParagraph = (text: string, prefix: string, where: string): string => {
  const lines = text.split(/\r?\n/);
  let fenced = false;
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced && stripParagraphMarks(line).startsWith(prefix)) starts.push(index);
  });
  if (starts.length !== 1) {
    throw new KitTemplateError(
      `${where}: ${starts.length === 0 ? 'no' : starts.length} paragraph(s) start with "${prefix}"`
    );
  }
  const start = starts[0];
  const isItem = /^\s*[-*]\s+/.test(lines[start]);
  let end = start + 1;
  while (
    end < lines.length &&
    lines[end].trim() !== '' &&
    !(isItem && /^\s*[-*]\s+/.test(lines[end])) &&
    !HEADING.test(lines[end])
  ) {
    end++;
  }
  return lines.slice(start, end).join('\n');
};

const markdownCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const renderCoreComponents = (components: readonly CoreComponentInfo[]): string => {
  const out: string[] = [];
  for (const component of [...components].sort((a, b) => a.id.localeCompare(b.id))) {
    out.push(`### \`${component.id}\``, '');
    if (component.description) out.push(component.description, '');
    if (component.properties.length === 0) {
      out.push('No config keys.', '');
      continue;
    }
    out.push('| Key | Type | Default | Notes |', '| --- | --- | --- | --- |');
    for (const property of component.properties) {
      out.push(
        `| \`${property.name}\` | ${property.type} | ${property.default !== undefined ? `\`${markdownCell(property.default)}\`` : '—'} | ${markdownCell(property.notes ?? '')} |`
      );
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
};

const renderGenerated = (name: string, options: GenerateKitOptions, where: string): string => {
  switch (name.trim()) {
    case 'core-components':
      return renderCoreComponents(options.coreComponents);
    case 'mcp-tools':
      return options.mcpTools.map(tool => `- \`${tool.name}\` — ${tool.summary}`).join('\n');
    case 'mcp-error-codes':
      return options.mcpErrorCodes.map(code => `\`${code}\``).join(', ');
    default:
      throw new KitTemplateError(`${where}: unknown generated block "${name}"`);
  }
};

export interface ExpandedTemplate {
  readonly text: string;
  readonly sources: readonly string[];
}

/** Expand one template's directives. */
export const expandTemplate = (
  template: string,
  where: string,
  options: GenerateKitOptions
): ExpandedTemplate => {
  const sources = new Set<string>();
  const cache = new Map<string, string>();
  const read = (path: string): string => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    let text: string;
    try {
      text = readFileSync(join(options.repoRoot, path), 'utf8');
    } catch {
      throw new KitTemplateError(`${where}: include source ${path} does not exist`);
    }
    cache.set(path, text);
    sources.add(path);
    return text;
  };
  const text = template.replace(COMMENT_LINE, '').replace(DIRECTIVE, (whole, kind, spec) => {
    if (whole === '{{version}}') return options.version;
    if (kind === 'generated') return renderGenerated(String(spec), options, where);
    const [target, ...rest] = String(spec)
      .split('|')
      .map(part => part.trim());
    const hash = target.indexOf('#');
    const at = target.indexOf('@');
    if (hash > 0) {
      return unlinkRelative(
        extractSection(read(target.slice(0, hash)), target.slice(hash + 1), rest, where)
      );
    }
    if (at > 0) {
      return unlinkRelative(
        extractParagraph(read(target.slice(0, at)), target.slice(at + 1), where)
      );
    }
    return unlinkRelative(trimBlock(read(target).split(/\r?\n/)).join('\n'));
  });
  const leftover = /\{\{[^}]*\}\}/.exec(text);
  if (leftover) throw new KitTemplateError(`${where}: unresolved directive ${leftover[0]}`);
  return { text, sources: [...sources] };
};

const walk = (root: string, dir = root): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, full));
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out.sort();
};

/** Project path of a template (`skills/<name>/…` → `.claude/skills/<name>/…`). */
export const projectPathOfTemplate = (templatePath: string): string =>
  templatePath.startsWith('skills/') ? `.claude/${templatePath}` : templatePath;

/** The template files of `kit-src` (project-relative source paths). */
export const listTemplates = (kitSrcDir: string): string[] => walk(kitSrcDir);

/** Build the kit into `outDir` (replaced). */
export const generateKit = (options: GenerateKitOptions): KitManifestFile => {
  // Staged beside the target (same filesystem, so the final rename is atomic); removed on failure.
  const staging = `${options.outDir}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    const files: string[] = [];
    const sources = new Set<string>();
    for (const templatePath of listTemplates(options.kitSrcDir)) {
      const template = readFileSync(join(options.kitSrcDir, templatePath), 'utf8');
      const expanded = expandTemplate(template, `kit-src/${templatePath}`, options);
      for (const source of expanded.sources) sources.add(source);
      const projectPath = projectPathOfTemplate(templatePath);
      const target = join(staging, KIT_FILES_DIR, projectPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, expanded.text.endsWith('\n') ? expanded.text : `${expanded.text}\n`);
      files.push(projectPath);
    }
    const manifest: KitManifestFile = {
      format: KIT_FORMAT,
      version: options.version,
      inputsStamp: options.inputsStamp ?? null,
      files: files.sort(),
      sources: [...sources].sort(),
    };
    writeFileSync(join(staging, KIT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(options.outDir, { recursive: true, force: true });
    mkdirSync(dirname(options.outDir), { recursive: true });
    renameSync(staging, options.outDir);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};
