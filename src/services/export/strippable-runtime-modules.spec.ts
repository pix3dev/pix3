import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildStrippedModuleSource,
  NEUTRALISED_IMPORTERS,
  resolveStrippableRuntimeModules,
  STRIPPABLE_RUNTIME_MODULES,
} from '@/services/export/strippable-runtime-modules';

const RUNTIME_SRC = path.resolve(__dirname, '../../../packages/pix3-runtime/src');

const listRuntimeSources = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listRuntimeSources(entryPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      found.push(entryPath);
    }
  }
  return found;
};

const resolveRelativeImport = (fromFile: string, specifier: string): string | null => {
  const target = path.normalize(path.join(path.dirname(fromFile), specifier));
  for (const candidate of [`${target}.ts`, path.join(target, 'index.ts')]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const toModulePath = (absolutePath: string): string =>
  path.relative(RUNTIME_SRC, absolutePath).replace(/\.ts$/, '');

/**
 * Value importers per module path, mirroring what the bundler sees: `import type`
 * and named clauses where every specifier is `type X` are erased before bundling,
 * so they pin nothing.
 */
const buildValueImportGraph = (): Map<string, Set<string>> => {
  const importers = new Map<string, Set<string>>();
  const importPattern = /import\s+(type\s+)?([^'";]*?)from\s+['"]([^'"]+)['"]/g;

  for (const file of listRuntimeSources(RUNTIME_SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const [, typeKeyword, clause, specifier] = match;
      if (typeKeyword || !specifier.startsWith('.')) {
        continue;
      }
      const specifiers = clause.includes('{')
        ? clause
            .replace(/[{}]/g, '')
            .split(',')
            .map(entry => entry.trim())
            .filter(entry => entry.length > 0)
        : [];
      const onlyTypes =
        specifiers.length > 0 && specifiers.every(entry => entry.startsWith('type '));
      if (onlyTypes) {
        continue;
      }

      const resolved = resolveRelativeImport(file, specifier);
      if (!resolved) {
        continue;
      }

      const key = toModulePath(resolved);
      const existing = importers.get(key) ?? new Set<string>();
      existing.add(toModulePath(file));
      importers.set(key, existing);
    }
  }

  return importers;
};

describe('strippable runtime modules', () => {
  const graph = buildValueImportGraph();

  it('lists modules that exist in the runtime', () => {
    for (const entry of STRIPPABLE_RUNTIME_MODULES) {
      expect(
        existsSync(path.join(RUNTIME_SRC, `${entry.modulePath}.ts`)),
        `${entry.modulePath} is listed as strippable but does not exist`
      ).toBe(true);
    }
  });

  it('has no unaccounted value importer — the guard against runtime drift', () => {
    // This is the invariant that makes stubbing safe. If someone adds
    // `import { Slider2D } from '...'` to a module that a player always keeps, the
    // stub would break that module and this test is what says so.
    const listed = new Set(STRIPPABLE_RUNTIME_MODULES.map(entry => entry.modulePath));
    const neutralised = new Set<string>(NEUTRALISED_IMPORTERS);

    for (const entry of STRIPPABLE_RUNTIME_MODULES) {
      const actual = [...(graph.get(entry.modulePath) ?? new Set<string>())];
      const declared = new Set([...(entry.importers ?? []), ...(entry.lazyValueImporters ?? [])]);

      const unaccounted = actual.filter(
        importer =>
          !neutralised.has(importer) && !declared.has(importer) && importer !== entry.modulePath
      );

      expect(
        unaccounted,
        `${entry.modulePath} gained value importer(s) not declared in the table. Either add them ` +
          `to \`importers\` (if they are strippable too), justify them in \`lazyValueImporters\`, ` +
          `or drop the entry.`
      ).toEqual([]);

      // The reverse direction: a declared importer that no longer imports it is stale.
      for (const declaredImporter of declared) {
        expect(
          actual,
          `${entry.modulePath} declares importer ${declaredImporter}, which no longer imports it`
        ).toContain(declaredImporter);
      }

      for (const importer of entry.importers ?? []) {
        expect(
          listed.has(importer),
          `${entry.modulePath} declares ${importer} in \`importers\`, but that module is not itself strippable`
        ).toBe(true);
      }
    }
  });

  it('keeps behaviour ids in sync with register-behaviors', () => {
    const registerSource = readFileSync(
      path.join(RUNTIME_SRC, 'behaviors/register-behaviors.ts'),
      'utf8'
    );
    const registered = new Map<string, string>();
    const blockPattern = /id:\s*'(core:[A-Za-z0-9_]+)'[\s\S]*?componentClass:\s*([A-Za-z0-9_]+)/g;
    for (const match of registerSource.matchAll(blockPattern)) {
      registered.set(match[2], match[1]);
    }

    expect(registered.size).toBeGreaterThan(10);

    for (const entry of STRIPPABLE_RUNTIME_MODULES) {
      const className = path.basename(entry.modulePath);
      const registeredId = registered.get(className);
      if (!registeredId) {
        continue;
      }

      expect(
        entry.keepWhenMentioned,
        `${entry.modulePath} is registered as ${registeredId}; a scene naming that id must keep it`
      ).toContain(registeredId);
      expect(entry.keepWhenMentioned).toContain(className);
    }
  });

  describe('resolveStrippableRuntimeModules', () => {
    it('keeps what the project mentions and strips the rest', () => {
      const stripped = resolveStrippableRuntimeModules(name => name === 'Slider2D');
      const paths = stripped.map(entry => entry.modulePath);

      expect(paths).not.toContain('nodes/2D/UI/Slider2D');
      expect(paths).toContain('nodes/2D/UI/Checkbox2D');
      expect(paths).toContain('net/NetworkService');
    });

    it('rescues a module whose importer survives', () => {
      // ReplicatedTransformBehavior imports NetworkedNodeBehavior, which imports
      // NetworkService: mentioning only the outermost one has to keep all three.
      const stripped = resolveStrippableRuntimeModules(name => name === 'core:ReplicatedTransform');
      const paths = stripped.map(entry => entry.modulePath);

      expect(paths).not.toContain('behaviors/ReplicatedTransformBehavior');
      expect(paths).not.toContain('behaviors/NetworkedNodeBehavior');
      expect(paths).not.toContain('net/NetworkService');
    });

    it('strips nothing when everything is mentioned', () => {
      expect(resolveStrippableRuntimeModules(() => true)).toEqual([]);
    });
  });

  describe('buildStrippedModuleSource', () => {
    it('mirrors every value export and throws only on use', () => {
      const stub = buildStrippedModuleSource(
        [
          'export class Slider2D extends UIControl2D {}',
          'export const SLIDER_DEFAULTS = { value: 0 };',
          'export function makeSlider() { return null; }',
          'export interface Slider2DProps { value: number }',
          'export type SliderMode = "a" | "b";',
        ].join('\n'),
        'nodes/2D/UI/Slider2D'
      );

      expect(stub).toContain('export class Slider2D');
      expect(stub).toContain('export const SLIDER_DEFAULTS');
      expect(stub).toContain('export function makeSlider');
      // Types are erased by esbuild, so the importing module stops referencing them.
      expect(stub).not.toContain('Slider2DProps');
      expect(stub).not.toContain('SliderMode');
      expect(stub).toContain('was stripped from this build');
      // Registration reads the schema off the class; it must not explode there.
      expect(stub).toContain('static getPropertySchema()');
    });

    it('covers the real Slider2D source it will replace', () => {
      const source = readFileSync(path.join(RUNTIME_SRC, 'nodes/2D/UI/Slider2D.ts'), 'utf8');
      const stub = buildStrippedModuleSource(source, 'nodes/2D/UI/Slider2D');

      for (const match of source.matchAll(
        /export\s+(?:abstract\s+)?(?:class|const|function)\s+([A-Za-z0-9_$]+)/g
      )) {
        expect(stub, `stub is missing the ${match[1]} export`).toContain(match[1]);
      }
    });
  });
});
