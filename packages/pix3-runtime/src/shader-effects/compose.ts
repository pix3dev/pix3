/**
 * GLSL composer: assembles the injected vertex/fragment shader text from an
 * ordered list of attached effects, and derives the program cache key.
 *
 * Node-agnostic — operates only on the attached-effect list + a merged uniform
 * bag, so any node authoring a `MeshStandardMaterial` can reuse it.
 */
import type { AttachedShaderEffect, ShaderEffectAnchor } from './shader-effect-types';

interface ComposableShader {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
}

const ANCHOR_INCLUDE: Record<ShaderEffectAnchor, string> = {
  uv_vertex: '#include <uv_vertex>',
  emissivemap_fragment: '#include <emissivemap_fragment>',
  opaque_fragment: '#include <opaque_fragment>',
};

function parsOf(effects: AttachedShaderEffect[], stage: 'vertex' | 'fragment'): string {
  return effects
    .map(e => (stage === 'vertex' ? e.info.vertexPars : e.info.fragmentPars))
    .filter((s): s is string => !!s)
    .join('\n');
}

/** Concatenate every matching chunk (in attach order), each `#ifdef`-gated. */
function chunksFor(
  effects: AttachedShaderEffect[],
  stage: 'vertex' | 'fragment',
  anchor: ShaderEffectAnchor
): string {
  const out: string[] = [];
  for (const effect of effects) {
    for (const chunk of effect.info.chunks) {
      if (chunk.stage === stage && chunk.anchor === anchor) {
        out.push(`#ifdef ${effect.info.define}\n${chunk.glsl}\n#endif`);
      }
    }
  }
  return out.join('\n');
}

function injectAfter(src: string, includeTag: string, text: string): string {
  if (!text) {
    return src;
  }
  return src.replace(includeTag, `${includeTag}\n${text}`);
}

function injectBefore(src: string, includeTag: string, text: string): string {
  if (!text) {
    return src;
  }
  return src.replace(includeTag, `${text}\n${includeTag}`);
}

/**
 * Compose the injected shader text + share the uniform refs. Mutates `shader`
 * in place (called from a material's `onBeforeCompile`). No-op when no effects
 * are attached — a plain PBR material.
 */
export function composeEffectShaders(
  shader: ComposableShader,
  effects: AttachedShaderEffect[],
  uniforms: Record<string, { value: unknown }>
): void {
  if (effects.length === 0) {
    return;
  }
  Object.assign(shader.uniforms, uniforms);

  const vertexPars = parsOf(effects, 'vertex');
  shader.vertexShader = `varying vec2 vPix3Uv;\n${vertexPars ? vertexPars + '\n' : ''}${shader.vertexShader}`;
  shader.vertexShader = injectAfter(
    shader.vertexShader,
    ANCHOR_INCLUDE.uv_vertex,
    `vPix3Uv = uv;\n${chunksFor(effects, 'vertex', 'uv_vertex')}`
  );

  const fragmentPars = parsOf(effects, 'fragment');
  shader.fragmentShader = `varying vec2 vPix3Uv;\n${fragmentPars ? fragmentPars + '\n' : ''}${shader.fragmentShader}`;
  shader.fragmentShader = injectAfter(
    shader.fragmentShader,
    ANCHOR_INCLUDE.emissivemap_fragment,
    chunksFor(effects, 'fragment', 'emissivemap_fragment')
  );
  shader.fragmentShader = injectBefore(
    shader.fragmentShader,
    ANCHOR_INCLUDE.opaque_fragment,
    chunksFor(effects, 'fragment', 'opaque_fragment')
  );
}

/**
 * Program cache key reflecting the attached set + order. MUST change when the
 * injected text changes: three re-runs `onBeforeCompile` only on a cache-key
 * miss, and an attached-but-disabled effect changes the text (its pars) without
 * changing `material.defines`. Bump the `v2` literal on any GLSL change.
 */
export function shaderEffectsCacheKey(effects: AttachedShaderEffect[]): string {
  return 'pix3-gmesh-fx-v2:' + effects.map(e => e.type).join('+');
}
