import { BufferGeometry } from 'three';
/**
 * Fill algorithm for {@link buildTiledSpriteGeometry} — how a single texture is
 * mapped onto a rectangle of arbitrary size.
 *
 * - `stretch`         — one quad, texture stretched to fill (like Sprite2D).
 * - `tile`            — the texture repeats across the rect at its natural size
 *                       (scaled by `tileScale`, phase-shifted by `tileOffset`).
 * - `nine-slice`      — a 3×3 grid: the four corners keep a fixed pixel size, the
 *                       edges and centre scale (or tile) to fill. Great for UI
 *                       panels / windows with rounded or decorated borders.
 * - `three-slice-h`   — a horizontal 3-part strip (left cap · middle · right cap);
 *                       only the left/right borders matter. For horizontal bars.
 * - `three-slice-v`   — a vertical 3-part strip (bottom cap · middle · top cap).
 */
export type TiledSpritePatchMode = 'stretch' | 'tile' | 'nine-slice' | 'three-slice-h' | 'three-slice-v';
/** Per-axis fill for the stretchable regions of a slice mode. */
export type TiledSpriteAxisStretch = 'stretch' | 'tile';
/** Border insets, in *source-texture pixels*, that separate the fixed corners
 * from the stretchable middle (Godot's `patch_margin_*`, Unity's sprite border). */
export interface TiledSpriteSliceBorder {
    left: number;
    right: number;
    top: number;
    bottom: number;
}
export interface TiledSpriteVector2Like {
    x: number;
    y: number;
}
export interface TiledSpriteGeometryParams {
    mode: TiledSpritePatchMode;
    /** On-screen width in design pixels. */
    width: number;
    /** On-screen height in design pixels. */
    height: number;
    /** Natural texture width in pixels (used to map borders/tiles to UVs). */
    textureWidth: number;
    /** Natural texture height in pixels. */
    textureHeight: number;
    border: TiledSpriteSliceBorder;
    /** When false, the 9-slice centre quad is omitted (hollow frame, Godot's
     * `draw_center`). Ignored by non-slice modes. */
    drawCenter: boolean;
    /** How the horizontal middle column fills in slice modes. */
    axisStretchHorizontal: TiledSpriteAxisStretch;
    /** How the vertical middle row fills in slice modes. */
    axisStretchVertical: TiledSpriteAxisStretch;
    /** Tile-size multiplier for `tile` mode (1 = natural texture size). */
    tileScale: TiledSpriteVector2Like;
    /** UV phase offset (in tiles) for `tile` mode. */
    tileOffset: TiledSpriteVector2Like;
}
/**
 * Builds a centred (`[-w/2, +w/2] × [-h/2, +h/2]`, +Z-facing) {@link BufferGeometry}
 * whose UVs map a single texture onto the rect according to `mode`. Adjacent slice
 * regions are emitted as independent quads (no shared vertices) because they carry
 * different UVs at coincident positions — so this uses per-quad UVs on a plain
 * `ClampToEdge` texture rather than `RepeatWrapping`, which also lets 9-slice edges
 * tile without clobbering the corner UVs.
 *
 * The result is shared by the runtime {@link TiledSprite2D} node and the editor
 * viewport proxy so both renderers stay pixel-identical.
 */
export declare function buildTiledSpriteGeometry(params: TiledSpriteGeometryParams): BufferGeometry;
