import * as THREE from 'three';
import { injectable } from '@/fw/di';
import {
  computeWorldBounds,
  fitOrthoToBounds,
  generateSphereDirections,
  viewProjectionMatrix,
} from './ao-bake-math';

/** One mesh to bake AO for. `mesh` supplies geometry + world matrix. */
export interface AOBakeTarget {
  id: string;
  mesh: THREE.Mesh;
}

export interface AOBakeOptions {
  /** Lightmap texture resolution (px, square). Default 256. */
  resolution?: number;
  /** Occluder depth-map resolution (px). Default 512. */
  depthResolution?: number;
  /** Hemisphere/sphere sample directions. More = smoother, slower. Default 64. */
  samples?: number;
  /** Depth-compare bias to avoid self-occlusion acne. Default 0.004. */
  bias?: number;
  /** Gutter dilation iterations (fills UV seams). Default 4. */
  dilate?: number;
}

interface ResolvedOptions extends Required<AOBakeOptions> {}

const DEFAULTS: ResolvedOptions = {
  resolution: 256,
  depthResolution: 512,
  samples: 64,
  bias: 0.004,
  dilate: 4,
};

const BAKE_VERTEX = /* glsl */ `
  attribute vec2 aLightUV;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = vec4(aLightUV * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const BAKE_FRAGMENT = /* glsl */ `
  #include <packing>
  uniform sampler2D uDepth;
  uniform mat4 uLightVP;
  uniform vec3 uDir;
  uniform float uBias;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  void main() {
    float w = max(0.0, dot(normalize(vWorldNormal), uDir));
    if (w <= 0.0) { gl_FragColor = vec4(0.0); return; }
    vec4 clip = uLightVP * vec4(vWorldPos, 1.0);
    vec3 ndc = clip.xyz / clip.w;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    float myDepth = ndc.z * 0.5 + 0.5;
    float stored = unpackRGBAToDepth(texture2D(uDepth, uv));
    float visible = (myDepth <= stored + uBias) ? 1.0 : 0.0;
    // R = sum(weight * visible), G = sum(weight) -> normalized to visibility later.
    gl_FragColor = vec4(w * visible, w, 0.0, 1.0);
  }
`;

const NORMALIZE_FRAGMENT = /* glsl */ `
  uniform sampler2D uAccum;
  varying vec2 vUv;
  void main() {
    vec4 a = texture2D(uAccum, vUv);
    float vis = a.g > 0.0 ? a.r / a.g : 1.0;
    // A = coverage flag: 1 where the mesh shell wrote, 0 in UV gutters.
    gl_FragColor = vec4(vec3(vis), a.g > 0.0 ? 1.0 : 0.0);
  }
`;

const DILATE_FRAGMENT = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uTex, vUv);
    if (c.a > 0.5) { gl_FragColor = c; return; }
    // Uncovered gutter texel: average any covered 8-neighbours.
    vec3 sum = vec3(0.0); float n = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec4 s = texture2D(uTex, vUv + vec2(float(x), float(y)) * uTexel);
        if (s.a > 0.5) { sum += s.rgb; n += 1.0; }
      }
    }
    gl_FragColor = n > 0.0 ? vec4(sum / n, 1.0) : c;
  }
`;

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/**
 * Bakes ambient occlusion into per-mesh lightmap textures on the GPU.
 *
 * Technique (validated against a ground+box probe before it was written):
 * sample many directions over the sphere; for each, render the occluder set's
 * depth from an orthographic camera looking along it, then render each target in
 * its lightmap-UV space, accumulating cosine-weighted visibility by re-projecting
 * each texel's world position into the depth map. A normalize pass turns the
 * accumulated (Σw·vis, Σw) into a visibility value, a dilation pass fills UV
 * gutters, and the result is read back and PNG-encoded.
 *
 * Editor-only: uses an offscreen `WebGLRenderer`, so it never touches the live
 * viewport renderer. Meshes are baked through reparent-safe proxies (shared
 * geometry + copied world matrix), so the real scene graph is untouched.
 */
@injectable()
export class AOBakeService {
  /**
   * Bake AO for every target, occluded by all `occluders` (usually the same
   * meshes). Returns a PNG (as bytes) per target id. The visibility is stored so
   * white = fully open, dark = occluded — matching three's `aoMap` convention.
   */
  async bake(
    targets: readonly AOBakeTarget[],
    occluders: readonly THREE.Mesh[],
    options: AOBakeOptions = {}
  ): Promise<Map<string, Uint8Array>> {
    const opts: ResolvedOptions = { ...DEFAULTS, ...options };
    const results = new Map<string, Uint8Array>();
    if (targets.length === 0) {
      return results;
    }

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.autoClear = false;
    renderer.setSize(opts.resolution, opts.resolution, false);

    // Occluder depth scene (proxies so we never reparent live meshes).
    const occScene = new THREE.Scene();
    occScene.overrideMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
    });
    const occluderProxies: THREE.Mesh[] = [];
    for (const occ of occluders) {
      occ.updateWorldMatrix(true, false);
      const proxy = new THREE.Mesh(occ.geometry);
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(occ.matrixWorld);
      proxy.matrixWorld.copy(occ.matrixWorld);
      occScene.add(proxy);
      occluderProxies.push(proxy);
    }

    const bounds = computeWorldBounds(occluderProxies);
    const dirs = generateSphereDirections(opts.samples);
    const dirVPs = new Map<number, THREE.Matrix4>();

    const depthRT = new THREE.WebGLRenderTarget(opts.depthResolution, opts.depthResolution, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    const lightCam = new THREE.OrthographicCamera();

    const bakeMat = new THREE.ShaderMaterial({
      uniforms: {
        uDepth: { value: depthRT.texture },
        uLightVP: { value: new THREE.Matrix4() },
        uDir: { value: new THREE.Vector3() },
        uBias: { value: opts.bias },
      },
      vertexShader: BAKE_VERTEX,
      fragmentShader: BAKE_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    // Per-target accumulation targets (kept live across the direction loop so
    // depth is rendered once per direction, not once per direction-per-target).
    const accums = targets.map(
      () =>
        new THREE.WebGLRenderTarget(opts.resolution, opts.resolution, {
          type: THREE.HalfFloatType,
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
        })
    );
    const bakeScenes = targets.map(target => {
      const mesh = target.mesh;
      mesh.updateWorldMatrix(true, false);
      const geometry = mesh.geometry;
      // Alias the lightmap UV (uv1, fallback uv) into a custom attribute the
      // bake shader reads by name — avoids clashing with three's built-in `uv`.
      const lightUV = geometry.getAttribute('uv1') ?? geometry.getAttribute('uv');
      if (lightUV) {
        geometry.setAttribute('aLightUV', lightUV);
      }
      const proxy = new THREE.Mesh(geometry, bakeMat);
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(mesh.matrixWorld);
      proxy.matrixWorld.copy(mesh.matrixWorld);
      const scene = new THREE.Scene();
      scene.add(proxy);
      return scene;
    });

    // Clear all accumulation buffers once.
    renderer.setClearColor(0x000000, 0);
    for (const accum of accums) {
      renderer.setRenderTarget(accum);
      renderer.clear(true, true, true);
    }

    for (let di = 0; di < dirs.length; di += 1) {
      const dir = dirs[di];
      fitOrthoToBounds(lightCam, bounds, dir);
      const vp = viewProjectionMatrix(lightCam);
      dirVPs.set(di, vp);

      // Occluder depth map (white clear = far → unoccluded by default).
      renderer.setRenderTarget(depthRT);
      renderer.setClearColor(0xffffff, 1.0);
      renderer.clear(true, true, true);
      renderer.render(occScene, lightCam);

      bakeMat.uniforms.uDir.value.copy(dir);
      bakeMat.uniforms.uLightVP.value.copy(vp);
      for (let ti = 0; ti < targets.length; ti += 1) {
        renderer.setRenderTarget(accums[ti]);
        renderer.render(bakeScenes[ti], lightCam);
      }
    }

    // Normalize + dilate + read back, per target.
    const quad = this.createFullscreenQuad();
    for (let ti = 0; ti < targets.length; ti += 1) {
      const bytes = this.finalizeTarget(renderer, quad, accums[ti], opts);
      results.set(targets[ti].id, await this.encodePng(bytes, opts.resolution));
    }

    // Cleanup — restore geometries and dispose GPU resources.
    for (const target of targets) {
      target.mesh.geometry.deleteAttribute('aLightUV');
    }
    quad.dispose();
    bakeMat.dispose();
    depthRT.dispose();
    accums.forEach(a => a.dispose());
    (occScene.overrideMaterial as THREE.Material | null)?.dispose();
    renderer.setRenderTarget(null);
    renderer.dispose();

    return results;
  }

  private createFullscreenQuad(): { mesh: THREE.Mesh; scene: THREE.Scene; dispose(): void } {
    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry);
    const scene = new THREE.Scene();
    scene.add(mesh);
    return {
      mesh,
      scene,
      dispose: () => {
        geometry.dispose();
      },
    };
  }

  /** Normalize the accumulation buffer, dilate gutters, read back RGBA bytes. */
  private finalizeTarget(
    renderer: THREE.WebGLRenderer,
    quad: { mesh: THREE.Mesh; scene: THREE.Scene },
    accum: THREE.WebGLRenderTarget,
    opts: ResolvedOptions
  ): Uint8Array {
    const size = opts.resolution;
    const rtA = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    const rtB = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    const dummyCam = new THREE.OrthographicCamera();

    const normalizeMat = new THREE.ShaderMaterial({
      uniforms: { uAccum: { value: accum.texture } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: NORMALIZE_FRAGMENT,
      depthTest: false,
    });
    quad.mesh.material = normalizeMat;
    renderer.setRenderTarget(rtA);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(quad.scene, dummyCam);

    const dilateMat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uTexel: { value: new THREE.Vector2(1 / size, 1 / size) },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: DILATE_FRAGMENT,
      depthTest: false,
    });
    quad.mesh.material = dilateMat;
    let src = rtA;
    let dst = rtB;
    for (let i = 0; i < opts.dilate; i += 1) {
      dilateMat.uniforms.uTex.value = src.texture;
      renderer.setRenderTarget(dst);
      renderer.clear(true, true, true);
      renderer.render(quad.scene, dummyCam);
      const tmp = src;
      src = dst;
      dst = tmp;
    }

    const buffer = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(src, 0, 0, size, size, buffer);

    normalizeMat.dispose();
    dilateMat.dispose();
    rtA.dispose();
    rtB.dispose();
    return buffer;
  }

  /**
   * Encode RGBA bytes into a PNG. `readRenderTargetPixels` returns rows
   * bottom-up (row 0 = uv.v 0). The AO textures are sampled with `flipY = false`
   * (set in `GeometryMesh.setAOMap`), which uploads image row 0 as uv.v 0 — so
   * we write the buffer verbatim. (An extra flip here would mirror the map
   * vertically, which on a floor plane reads as a Z mirror of the occlusion.)
   */
  private async encodePng(rgba: Uint8Array, size: number): Promise<Uint8Array> {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('AO bake: could not get a 2D canvas context for PNG encoding.');
    }
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer.slice(0)), size, size), 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      throw new Error('AO bake: PNG encoding failed (toBlob returned null).');
    }
    return new Uint8Array(await blob.arrayBuffer());
  }
}
