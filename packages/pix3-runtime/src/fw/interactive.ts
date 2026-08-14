/**
 * Interaction schema — the semantic channel for driving controls.
 *
 * ## Why a second channel exists
 *
 * A node can be operated two ways. The **physical** channel puts a finger at a screen coordinate
 * and lets the scene decide what was hit; it proves the control is reachable (on screen, non-zero
 * size, correct projection) and nothing else. The **semantic** channel names the control and the
 * thing to do with it (`click`, `setValue`) and proves everything that happens *after* the hit:
 * `enabled`, the ancestor scroll gate, the skin state machine, the order of the lifecycle signals,
 * the game logic listening on them.
 *
 * ## The rule that makes it honest
 *
 * `invokeInteraction` **must not call the handler directly** and must not assign the field the
 * gesture would have changed. It synthesizes a pointer position *from the control's own transform*
 * and feeds it through the exact same per-frame funnel a real finger drives. Exactly one premise is
 * bypassed — `isPointInBounds` against the position of a real finger, i.e. on-screen reachability.
 * Everything else is executed for real. A shortcut here (emit the signal, flip the field) silently
 * turns the whole layer into a no-op that can never fail.
 *
 * Argument descriptors reuse the property-schema types so one listing renderer serves both
 * inspector properties and interaction arguments.
 */

import { coerceToPropertyType, type PropertyDefinition } from './property-schema';

/**
 * One argument of an interaction, described with the property-schema vocabulary (`type`, `ui`,
 * `defaultValue`, `validation`).
 *
 * `getValue`/`setValue` are optional here and meaningless for an argument — an argument is not
 * stored on a node, so there is nothing to read it from or write it to. Keeping them optional (a
 * full `PropertyDefinition` is still assignable) avoids forcing every declaration to carry two dead
 * closures purely to satisfy the type.
 */
export type InteractionArgDefinition = Omit<PropertyDefinition, 'getValue' | 'setValue'> &
  Partial<Pick<PropertyDefinition, 'getValue' | 'setValue'>>;

/** One thing that can be done to a node, as listed to tools and agents. */
export interface InteractionDescriptor {
  /** Interaction id, unique per node: `click`, `setValue`, `setStick`, … */
  name: string;
  /** Declared arguments, in call order. Omitted = the interaction takes none. */
  args?: InteractionArgDefinition[];
  /** One line, shown in the interaction listing. */
  description?: string;
}

/**
 * Implemented by nodes (and script components) that can be operated by name instead of by
 * coordinate.
 */
export interface Interactive {
  /** Every interaction this instance currently offers. */
  getInteractions(): InteractionDescriptor[];
  /**
   * Perform one interaction through the node's real input path.
   *
   * Returns `false` — never throws — when the name is unknown, a required argument is missing or
   * unusable, or the node refuses the interaction (disabled, gesture claimed by an ancestor scroll
   * container). `true` means the interaction was delivered, not that the game reacted to it.
   */
  invokeInteraction(name: string, args?: Record<string, unknown>): boolean;
}

/** Whether a value implements the {@link Interactive} contract. */
export function isInteractive(value: unknown): value is Interactive {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Interactive>;
  return (
    typeof candidate.getInteractions === 'function' &&
    typeof candidate.invokeInteraction === 'function'
  );
}

/**
 * Read a numeric argument, coercing the way the property schema does — automation hands over model
 * JSON, where `"0.5"` is a perfectly ordinary spelling of a number. Returns `fallback` (default
 * `null`) when absent or not a finite number.
 */
export function readNumberArg(
  args: Record<string, unknown> | undefined,
  name: string,
  fallback: number | null = null
): number | null {
  const raw = args?.[name];
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const coerced = coerceToPropertyType('number', raw);
  return typeof coerced === 'number' && Number.isFinite(coerced) ? coerced : fallback;
}

/** Read a boolean argument (`"true"` / `"false"` included). Returns `fallback` when absent. */
export function readBooleanArg(
  args: Record<string, unknown> | undefined,
  name: string,
  fallback: boolean | null = null
): boolean | null {
  const raw = args?.[name];
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const coerced = coerceToPropertyType('boolean', raw);
  return typeof coerced === 'boolean' ? coerced : fallback;
}

/** Read a string argument. Returns `fallback` when absent or empty. */
export function readStringArg(
  args: Record<string, unknown> | undefined,
  name: string,
  fallback: string | null = null
): string | null {
  const raw = args?.[name];
  if (typeof raw !== 'string') {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}
