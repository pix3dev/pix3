import * as runtime from '@pix3/runtime';
import { createSchemaTypeResolver } from './runtime-type-resolver';
import type { PropertyTypeResolver } from './value-equality';

let resolver: PropertyTypeResolver | null = null;

/** The schema-backed type resolver over the editor's own `@pix3/runtime` (built once). */
export function getEditorTypeResolver(): PropertyTypeResolver {
  resolver ??= createSchemaTypeResolver(runtime as unknown as Record<string, unknown>);
  return resolver;
}
