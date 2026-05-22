import { Script, type PropertySchemaProvider, type ScriptComponent, ScriptRegistry } from '@pix3/runtime';

function isScriptCtor(value: unknown): value is (new (id: string, type: string) => ScriptComponent) & PropertySchemaProvider {
  if (typeof value !== 'function') {
    return false;
  }

  const ctor = value as { prototype?: object; getPropertySchema?: unknown };
  const hasSchema = typeof ctor.getPropertySchema === 'function';
  if (!hasSchema) {
    return false;
  }

  const baseProto = (Script as unknown as { prototype?: object }).prototype;
  let current = ctor.prototype;
  while (current) {
    if (current === baseProto) {
      return true;
    }
    current = Object.getPrototypeOf(current);
  }

  return false;
}

export function registerProjectScripts(registry: ScriptRegistry): void {
  const modules = {
    ...import.meta.glob(
      [
        '../scripts/**/*.ts',
        '!../scripts/**/*.spec.ts',
        '!../scripts/**/*.test.ts',
        '!../scripts/**/*.d.ts',
      ],
      { eager: true }
    ),
    ...import.meta.glob(
      [
        '../src/scripts/**/*.ts',
        '!../src/scripts/**/*.spec.ts',
        '!../src/scripts/**/*.test.ts',
        '!../src/scripts/**/*.d.ts',
      ],
      { eager: true }
    ),
  };

  for (const [sourceFile, exportsMap] of Object.entries(modules)) {
    for (const [exportName, value] of Object.entries(exportsMap as Record<string, unknown>)) {
      if (!isScriptCtor(value)) {
        continue;
      }

      const scriptId = `user:${exportName}`;
      registry.registerComponent({
        id: scriptId,
        displayName: exportName,
        description: `Project component from ${sourceFile}`,
        category: 'Project',
        componentClass: value,
        keywords: ['project', 'component', exportName.toLowerCase()],
      });
    }
  }
}