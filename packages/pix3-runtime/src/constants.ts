export const LAYER_3D = 0;
export const LAYER_2D = 1;
export const LAYER_GIZMOS = 2;
/**
 * 2D "overlay" band. Nodes on this layer are drawn AFTER the post-processing
 * composer (see {@link ./core/PostProcessingPipeline}), so screen effects like
 * bloom/vignette never touch them — e.g. a restart dialog shown over a blurred
 * game-over scene. A {@link ./nodes/2D/CanvasLayer2D} node routes its subtree
 * to this layer; ordinary 2D content stays on {@link LAYER_2D} and passes
 * through post-processing ("whole frame").
 */
export const LAYER_2D_OVERLAY = 3;
