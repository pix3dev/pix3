/**
 * Module-level registry of shader-effect types. Built-ins self-seed lazily on
 * first access so the registry works identically in the editor, the game
 * runtime, and vitest with no bootstrap wiring (unlike the DI ScriptRegistry).
 */
import type { ShaderEffectTypeInfo } from './shader-effect-types';
/**
 * Register a shader-effect type. Throws on a duplicate id/key or an
 * identifier-unsafe key/param name (these would produce colliding or invalid
 * `fx.<key>.<param>` schema property names).
 */
export declare function registerShaderEffect(info: ShaderEffectTypeInfo): void;
export declare function getShaderEffectType(id: string): ShaderEffectTypeInfo | undefined;
export declare function getAllShaderEffectTypes(): ShaderEffectTypeInfo[];
