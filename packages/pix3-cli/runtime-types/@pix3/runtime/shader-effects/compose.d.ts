/**
 * GLSL composer: assembles the injected vertex/fragment shader text from an
 * ordered list of attached effects, and derives the program cache key.
 *
 * Node-agnostic — operates only on the attached-effect list + a merged uniform
 * bag, so any node authoring a `MeshStandardMaterial` can reuse it.
 */
import type { AttachedShaderEffect } from './shader-effect-types';
interface ComposableShader {
    vertexShader: string;
    fragmentShader: string;
    uniforms: Record<string, {
        value: unknown;
    }>;
}
/**
 * Compose the injected shader text + share the uniform refs. Mutates `shader`
 * in place (called from a material's `onBeforeCompile`). No-op when no effects
 * are attached — a plain PBR material.
 */
export declare function composeEffectShaders(shader: ComposableShader, effects: AttachedShaderEffect[], uniforms: Record<string, {
    value: unknown;
}>): void;
/**
 * Program cache key reflecting the attached set + order. MUST change when the
 * injected text changes: three re-runs `onBeforeCompile` only on a cache-key
 * miss, and an attached-but-disabled effect changes the text (its pars) without
 * changing `material.defines`. Bump the `v2` literal on any GLSL change.
 */
export declare function shaderEffectsCacheKey(effects: AttachedShaderEffect[]): string;
export {};
