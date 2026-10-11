import { Vector2 } from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import { type LabelVAlign } from '../../../core/label-text-layout';
import type { PropertySchema } from '../../../fw/property-schema';
import type { TrParams } from '../../../core/localization/localization-types';
export interface Label2DProps extends UIControl2DProps {
    /** Fixed box width in logical px; 0 = auto-size to the text (no word wrap). */
    width?: number;
    /** Fixed box height in logical px; 0 = auto-size to the wrapped lines. */
    height?: number;
    /** Vertical alignment of the text inside a fixed-height box. */
    labelVAlign?: LabelVAlign;
    /** Characters per second for the typewriter reveal; 0 disables it. */
    typewriterSpeed?: number;
    /** Glow colour (CSS string); only visible while `glowStrength` > 0. */
    glowColor?: string;
    /** Glow amount 0..4; 0 (default) = no glow, so existing scenes are unchanged. */
    glowStrength?: number;
    /** Outline colour (CSS string); only visible while `outlineWidth` > 0. */
    outlineColor?: string;
    /** Outline half-width in px; 0 (default) = no outline. */
    outlineWidth?: number;
}
/**
 * A multiline text label control for 2D UI.
 *
 * - Explicit `\n` breaks lines; a fixed `width` additionally word-wraps.
 * - `labelAlign` / `labelVAlign` position the text inside the fixed box.
 * - `typewriterSpeed` > 0 reveals the text character by character in play
 *   mode; the node emits `'typewriter-complete'` when the reveal finishes.
 * - `glowStrength` / `outlineWidth` add a neon glow and/or a contrast outline in
 *   the canvas render (both off by default). HUD labels under a `CanvasLayer2D`
 *   are drawn after post-processing and can never bloom, so this is how HUD text
 *   glows.
 */
export declare class Label2D extends UIControl2D {
    width: number;
    height: number;
    labelVAlign: LabelVAlign;
    typewriterSpeed: number;
    glowColor: string;
    glowStrength: number;
    outlineColor: string;
    outlineWidth: number;
    private renderState;
    private typewriterVisible;
    private typewriterActive;
    /** Interpolation params for `labelKey` (runtime-only, not serialized). */
    private labelKeyParams;
    constructor(props: Label2DProps);
    /**
     * `Label2D` predates the shared caption outline and keeps `outlineWidth` / `outlineColor` as the
     * source of truth (they also size the canvas bleed). The inherited pair aliases them, so there is
     * one outline on a label however it is addressed — and the inspector shows it once.
     */
    get labelOutlineWidth(): number;
    set labelOutlineWidth(value: number);
    get labelOutlineColor(): string;
    set labelOutlineColor(value: string);
    getDisplayText(): string;
    /**
     * Replace the label with a literal string; restarts the typewriter reveal when enabled. Clears any
     * bound localization key — an explicit literal overrides localization.
     */
    setText(text: string): void;
    /** Bind the label to a translation key; re-resolves on locale change (via the tree walk). */
    setTextKey(key: string, params?: TrParams): void;
    /** True while a typewriter reveal is still printing characters. */
    get isTyping(): boolean;
    /** Finish the typewriter reveal instantly (show the full text). */
    skipTypewriter(): void;
    /** Restart the typewriter reveal from the first character. */
    restartTypewriter(): void;
    tick(dt: number): void;
    isPointInBounds(worldPoint: Vector2): boolean;
    updateLabel(): void;
    private finishTypewriter;
    private repaint;
    static getPropertySchema(): PropertySchema;
    private static clampGlowStrength;
}
