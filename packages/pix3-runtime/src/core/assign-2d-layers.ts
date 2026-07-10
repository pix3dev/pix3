import type { Object3D } from 'three';

import { Node2D } from '../nodes/Node2D';
import { LAYER_2D, LAYER_2D_OVERLAY } from '../constants';

/**
 * Per-frame layer routing for the 2D passes. Stamps every Object3D under a
 * CanvasLayer2D boundary onto {@link LAYER_2D_OVERLAY} (the fixed overlay band,
 * drawn after post-processing by the identity overlay camera) and everything
 * else onto {@link LAYER_2D} (the main, Camera2D-drivable, post-processed band).
 *
 * This runs every frame (alongside `assign2DRenderOrder`) because
 * {@link Node2D.add} force-stamps LAYER_2D on every added descendant, so any
 * structural mutation or mid-life mesh churn would otherwise clobber overlay
 * routing. Unconditional both-direction stamping is self-healing for runtime
 * re-parenting in either direction.
 *
 * Boundary detection uses the {@link Node2D.isCanvasLayer} flag rather than an
 * `instanceof CanvasLayer2D` check, to avoid a circular import
 * (Node2D ← Group2D ← CanvasLayer2D).
 *
 * @returns `true` when at least one CanvasLayer2D boundary exists — the caller
 * uses this to gate the extra overlay render/raycast passes (overlay-free
 * scenes keep their original two-pass cost).
 */
export function assign2DLayers(roots: readonly Object3D[]): boolean {
  const ctx = { hasOverlay: false };
  for (const root of roots) {
    if (root instanceof Node2D) {
      stamp(root, false, ctx);
    }
  }
  return ctx.hasOverlay;
}

function stamp(obj: Object3D, inOverlay: boolean, ctx: { hasOverlay: boolean }): void {
  if (obj instanceof Node2D && obj.isCanvasLayer) {
    inOverlay = true; // nested CanvasLayer2D is idempotent — stays overlay.
  }
  if (inOverlay) {
    ctx.hasOverlay = true;
  }
  obj.layers.set(inOverlay ? LAYER_2D_OVERLAY : LAYER_2D);
  for (const child of obj.children) {
    stamp(child, inOverlay, ctx);
  }
}
