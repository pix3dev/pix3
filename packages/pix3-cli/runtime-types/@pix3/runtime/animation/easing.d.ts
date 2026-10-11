/**
 * Easing functions for keyframe animation tweens.
 *
 * All functions map a normalized progress t in [0, 1] to an eased progress.
 * Based on the standard Penner easing equations.
 */
/**
 * Easing applied to the segment FROM a keyframe TO the next keyframe.
 * 'step' holds the left key's value until the next key (no interpolation).
 */
export type KeyframeEasing = 'linear' | 'step' | 'sineIn' | 'sineOut' | 'sineInOut' | 'quadIn' | 'quadOut' | 'quadInOut' | 'cubicIn' | 'cubicOut' | 'cubicInOut' | 'expoIn' | 'expoOut' | 'expoInOut' | 'backIn' | 'backOut' | 'backInOut' | 'elasticIn' | 'elasticOut' | 'elasticInOut' | 'bounceIn' | 'bounceOut' | 'bounceInOut';
/** All easing identifiers, in menu order (for editor UI). */
export declare const EASING_NAMES: readonly KeyframeEasing[];
export declare function isKeyframeEasing(value: unknown): value is KeyframeEasing;
/** Apply an easing curve to a normalized progress value (clamped to [0, 1]). */
export declare function applyEasing(easing: KeyframeEasing, t: number): number;
