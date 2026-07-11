/**
 * Module-level registry of shader-effect types. Built-ins self-seed lazily on
 * first access so the registry works identically in the editor, the game
 * runtime, and vitest with no bootstrap wiring (unlike the DI ScriptRegistry).
 */
import type { ShaderEffectTypeInfo } from './shader-effect-types';
import { BUILTIN_SHADER_EFFECTS } from './register-builtin-effects';

const registry = new Map<string, ShaderEffectTypeInfo>();
let seeded = false;

/** Identifier-safe, dot-free (used to build `fx.<key>.<param>` schema names). */
const IDENT_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;

function ensureSeeded(): void {
  if (seeded) {
    return;
  }
  seeded = true;
  for (const info of BUILTIN_SHADER_EFFECTS) {
    registerShaderEffect(info);
  }
}

/**
 * Register a shader-effect type. Throws on a duplicate id/key or an
 * identifier-unsafe key/param name (these would produce colliding or invalid
 * `fx.<key>.<param>` schema property names).
 */
export function registerShaderEffect(info: ShaderEffectTypeInfo): void {
  if (!IDENT_RE.test(info.key)) {
    throw new Error(`[ShaderEffectRegistry] invalid effect key "${info.key}" (must match ${IDENT_RE})`);
  }
  for (const p of info.params) {
    if (!IDENT_RE.test(p.key)) {
      throw new Error(
        `[ShaderEffectRegistry] effect "${info.id}" has invalid param key "${p.key}" (must match ${IDENT_RE})`
      );
    }
  }
  if (registry.has(info.id)) {
    throw new Error(`[ShaderEffectRegistry] duplicate effect id "${info.id}"`);
  }
  for (const existing of registry.values()) {
    if (existing.key === info.key) {
      throw new Error(
        `[ShaderEffectRegistry] effect key "${info.key}" already used by "${existing.id}"`
      );
    }
  }
  registry.set(info.id, info);
}

export function getShaderEffectType(id: string): ShaderEffectTypeInfo | undefined {
  ensureSeeded();
  return registry.get(id);
}

export function getAllShaderEffectTypes(): ShaderEffectTypeInfo[] {
  ensureSeeded();
  return [...registry.values()];
}
