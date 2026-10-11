import { type Material, Vector2 } from 'three';
import { NodeBase, type NodeBaseProps } from './NodeBase';
import type { PropertySchema } from '../fw/property-schema';
import { type BlendMode2D } from '../core/blend-mode-2d';
export type Node2DHorizontalAlign = 'left' | 'center' | 'right' | 'stretch';
export type Node2DVerticalAlign = 'top' | 'center' | 'bottom' | 'stretch';
export interface Node2DLayoutConfig {
    enabled?: boolean;
    horizontalAlign?: Node2DHorizontalAlign;
    verticalAlign?: Node2DVerticalAlign;
}
/**
 * Container flow: children are stacked by the parent instead of sitting where they were authored.
 *
 * This is the gap the anchors could not fill. `Node2DLayoutConfig` anchors a child to an EDGE of
 * its parent, which places a close button or an OK row perfectly — but a column of settings rows
 * needs each row to know where the previous one ended, and that is a container decision. A `flow`
 * container owns the main axis; a child's own anchor still owns the cross axis.
 *
 * A `Layout2D` NODE is deliberately not what this is: that node was removed on purpose
 * (`.plans/done/layout2d-implementation-plan.md`), so the flow lives on the container that
 * already exists, exactly as the anchor config does.
 */
export interface Node2DFlowConfig {
    enabled?: boolean;
    direction?: 'vertical' | 'horizontal';
    /** Space between two children, px. */
    gap?: number;
    paddingX?: number;
    paddingY?: number;
    /** Cross-axis placement of each child inside the container. */
    align?: 'start' | 'center' | 'end';
    /** Grow the container along the main axis so the last child fits. */
    autoSize?: boolean;
}
interface ResolvedFlow {
    enabled: boolean;
    direction: 'vertical' | 'horizontal';
    gap: number;
    paddingX: number;
    paddingY: number;
    align: 'start' | 'center' | 'end';
    autoSize: boolean;
}
export interface Node2DLayoutSize {
    width: number;
    height: number;
}
export interface Node2DLayoutPosition {
    x: number;
    y: number;
}
export interface Node2DProps extends Omit<NodeBaseProps, 'type'> {
    position?: Vector2;
    scale?: Vector2;
    rotation?: number;
    opacity?: number;
    blendMode?: BlendMode2D;
    layout?: Node2DLayoutConfig;
    flow?: Node2DFlowConfig;
    zIndex?: number;
    zAsRelative?: boolean;
}
/** Godot-compatible bound for {@link Node2D.zIndex}. */
export declare const Z_INDEX_LIMIT = 4096;
export declare class Node2D extends NodeBase {
    /** Shared scratch for pointer unprojection (single-threaded, reused per call). */
    private static readonly scratchUnproject;
    /**
     * Marks this node as a CanvasLayer2D boundary — its subtree renders in the
     * fixed overlay band (LAYER_2D_OVERLAY) through the identity overlay camera,
     * unaffected by an active Camera2D. Set by the CanvasLayer2D constructor.
     */
    isCanvasLayer: boolean;
    private _opacity;
    private _computedOpacity;
    private _blendMode;
    private _zIndex;
    private _zAsRelative;
    private _layoutEnabled;
    private _flow;
    private _horizontalAlign;
    private _verticalAlign;
    private readonly authoredLayoutPosition;
    private readonly authoredLayoutSize;
    protected readonly tmpPointerWorld: Vector2;
    private hasAuthoredLayoutSize;
    private readonly opacityMaterials;
    private visibleOpacity;
    private visibilityFade;
    constructor(props: Node2DProps, nodeType?: string);
    get opacity(): number;
    set opacity(value: number);
    get computedOpacity(): number;
    /**
     * How this node's own visuals combine with what is already on screen
     * (Godot `CanvasItem.blend_mode`). Applies to the materials this node owns —
     * it is NOT inherited by child 2D nodes the way {@link opacity} is, so an
     * additive glow on a sprite leaves its children alone.
     *
     * A non-normal mode opts the node's meshes out of the 2D quad batcher
     * (`Batch2D` only merges runs that share the default blend).
     */
    get blendMode(): BlendMode2D;
    set blendMode(value: BlendMode2D);
    /** Re-applies the current blend mode to every managed material. */
    refreshBlendMode(): void;
    private syncBlendModeProperty;
    /**
     * Draw-order override for the 2D pass (Godot `z_index`). Higher draws on top.
     *
     * The 2D pass has no depth test, so paint order is normally the scene-tree DFS
     * order (see `assign2DRenderOrder`). `zIndex` lifts a node out of that order
     * without moving it in the tree: nodes are bucketed by effective z first, and
     * tree order only breaks ties inside a bucket.
     */
    get zIndex(): number;
    set zIndex(value: number);
    /**
     * When `true` (the default, as in Godot) {@link zIndex} is added to the parent's
     * effective z, so a subtree keeps its internal layering wherever it is reparented.
     * When `false` the node's `zIndex` is absolute — use it for "always on top"
     * overlays that must not inherit an ancestor's offset.
     */
    get zAsRelative(): boolean;
    set zAsRelative(value: boolean);
    /** Effective (inherited) z used by the render-order walk. */
    get effectiveZIndex(): number;
    get layoutEnabled(): boolean;
    set layoutEnabled(value: boolean);
    get horizontalAlign(): Node2DHorizontalAlign;
    set horizontalAlign(value: Node2DHorizontalAlign);
    get verticalAlign(): Node2DVerticalAlign;
    set verticalAlign(value: Node2DVerticalAlign);
    getLayoutConfig(): Node2DLayoutConfig;
    setLayoutConfig(layout: Node2DLayoutConfig | null | undefined): void;
    captureAuthoredLayoutRectFromCurrent(): void;
    getAuthoredLayoutPosition(): Node2DLayoutPosition;
    setAuthoredLayoutPosition(x: number, y: number): void;
    getAuthoredLayoutSize(): Node2DLayoutSize;
    setAuthoredLayoutSize(width: number, height: number): void;
    /**
     * The world position of the **primary** pointer (the oldest one still down; with nothing down,
     * the last hover position), or null without an input service.
     *
     * Deliberately left primary-derived when the rest of the engine switched to addressed pointers:
     * it has **no caller inside this repository** and exists purely as compatibility for user scripts
     * and consumer projects written against the single-pointer engine, where "the pointer" was
     * unambiguous. Nothing that has to follow *its own* finger may use it — resolve that finger's
     * coordinates with {@link screenPointToWorld} (see `UIControl2D`'s pointer ownership), or ask
     * `scene.getPointer2DWorldPosition(pointerId)` from a script.
     */
    protected getPointerWorldPosition(target?: Vector2): Vector2 | null;
    /**
     * Convert a point in **input/screen units** (the units of `InputService.pointerPosition` and of
     * every `PointerSnapshot`) into 2D world units, through the same projection
     * {@link getPointerWorldPosition} uses. Returns null without an input service, whose `width` /
     * `height` define the screen rect.
     *
     * This exists because multi-touch made "the pointer position" ambiguous: a control owning finger
     * #2 has to unproject #2's coordinates, not whatever the shared primary position happens to hold.
     */
    protected screenPointToWorld(screenX: number, screenY: number, target?: Vector2): Vector2 | null;
    /** True when this node or an ancestor is a CanvasLayer2D (fixed overlay band). */
    protected isInOverlayBand(): boolean;
    get flow(): ResolvedFlow;
    /** Change the container's flow; pass `{ enabled: false }` to hand children back their positions. */
    setFlow(config: Node2DFlowConfig | null): void;
    protected static normalizeFlow(config: Node2DFlowConfig | undefined): ResolvedFlow;
    /**
     * Stack this container's visible 2D children along the flow axis, in TREE ORDER.
     *
     * Coordinates follow the engine's own convention: a child's position is its CENTRE, the origin
     * is the container's centre, and y points UP — so a vertical flow walks DOWNWARD from the top
     * padding, and "the next row" means a smaller y.
     *
     * A child's own anchor still decides the cross axis when it is enabled; the flow only claims
     * the main one. That split is what lets a settings row anchor its toggle to the right edge
     * while the column decides how far down the row sits.
     */
    applyFlowLayout(): void;
    /** Write back a size when the concrete node type has one; a plain group simply records it. */
    protected setLayoutSizeIfPossible(size: Node2DLayoutSize): void;
    serializeFlow(): Record<string, unknown> | undefined;
    applyAnchoredLayoutRecursive(referenceCurrentSize: Node2DLayoutSize, referenceAuthoredSize?: Node2DLayoutSize): void;
    reflowAnchoredChildren(): void;
    getCurrentLayoutSize(): Node2DLayoutSize;
    serializeLayout(): Record<string, unknown> | undefined;
    /**
     * Hides this node with optional fade-out time in seconds.
     * When fade completes, the node visibility is set to false.
     */
    hide(fadeTime?: number, onComplete?: () => void): void;
    /**
     * Shows this node with optional fade-in time in seconds.
     */
    show(fadeTime?: number, onComplete?: () => void): void;
    tick(dt: number): void;
    protected registerOpacityMaterial(material: Material, baseOpacity?: number): void;
    protected setOpacityMaterialBase(material: Material, baseOpacity: number): void;
    private applyOpacityToMaterial;
    refreshOpacity(): void;
    private getParentComputedOpacity;
    private refreshComputedOpacityRecursive;
    private static clampOpacity;
    private static normalizeLayout;
    private static normalizeHorizontalAlign;
    private static normalizeVerticalAlign;
    private static readInitialLayoutSize;
    private static toFiniteNumber;
    private static toNonNegativeSeconds;
    private setVisibleState;
    private ensureAuthoredLayoutSize;
    private readCurrentLayoutSize;
    private applyAnchoredLayout;
    private normalizeReferenceSize;
    private resolveHorizontalLayout;
    private resolveVerticalLayout;
    private applyCurrentLayoutSize;
    private static clampZIndex;
    /**
     * Mirrors the z-order fields into `properties` so SceneSaver persists them for
     * free (it spreads `node.properties`). Defaults are deleted rather than written,
     * so scenes that never touch z-order serialize exactly as before.
     */
    private syncZOrderProperties;
    private syncLayoutProperties;
    /**
     * Override add to ensure all children of a Node2D inherit the 2D layer.
     */
    add(...object: import('three').Object3D[]): this;
    /**
     * Get the property schema for Node2D.
     * Extends NodeBase schema with 2D-specific transform properties.
     */
    static getPropertySchema(): PropertySchema;
}
export {};
