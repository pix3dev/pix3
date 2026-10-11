import { type Blending, type Material } from 'three';
/**
 * Per-node blend mode for the 2D pass (Godot `CanvasItem.blend_mode`).
 *
 * Only the four blend modes three.js exposes as plain constants are offered, so
 * a mode is a single piece of material state that resets cleanly and survives
 * serialization. `screen` is deliberately absent: it needs `CustomBlending`, and
 * every factor pair that reproduces it either ignores `material.opacity` (so the
 * node stops fading) or darkens the backdrop as the node fades out — the opacity
 * multiplier in {@link Node2D} is not premultiplied. `additive` covers the glow
 * case that usually motivates it.
 */
export type BlendMode2D = 'normal' | 'additive' | 'multiply' | 'subtract';
export declare const BLEND_MODES_2D: readonly BlendMode2D[];
/** Inspector dropdown entries (label → serialized value). */
export declare const BLEND_MODE_2D_OPTIONS: Record<string, BlendMode2D>;
/** Coerces an authored/scripted value to a known mode, falling back to `normal`. */
export declare function normalizeBlendMode2D(value: unknown): BlendMode2D;
export declare function blendingForMode2D(mode: BlendMode2D): Blending;
/**
 * Applies `mode` to a material.
 *
 * `transparent` is forced on for every non-normal mode: three.js disables
 * blending entirely for an opaque material (`WebGLState.setMaterial` falls back
 * to `NoBlending`), so an additive sprite that happened to be opaque would draw
 * exactly like a normal one.
 */
export declare function applyBlendMode2DToMaterial(material: Material, mode: BlendMode2D): void;
