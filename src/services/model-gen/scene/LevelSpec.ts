/**
 * Types + a deterministic (zero-token) validator for the Scene lane "level spec" — the structured
 * plan a codegen model produces before it writes the `.pix3scene` YAML. The Scene-lane analogue of
 * {@link import('../SculptSpec').SculptSpec}: it blocks shallow / malformed / palette-dangling plans
 * before any YAML codegen is spent on them.
 *
 * Kept pure (no DI, no I/O) so it is trivially unit-testable and callable from anywhere.
 */

/** One area of the level with a purpose, optional bounds, and the palette assets it may use. */
export interface LevelZone {
  id: string;
  name: string;
  purpose: string;
  /** Optional rough size in metres [x, y, z]. */
  approxBoundsMeters?: [number, number, number];
  /** Inventory item ids this zone draws from. */
  paletteAssetIds?: string[];
}

/**
 * A palette gap: an asset the brief calls for that the inventory lacks. `need` names what is missing;
 * `suggestedPrompt` is a ready-to-use model-lane generation prompt the panel can hand to the model
 * lane to fill the gap. Populated by the spec stage; empty when the palette already covers the brief.
 */
export interface PaletteGap {
  need: string;
  suggestedPrompt: string;
}

/** The full plan for a level, produced by the spec stage. */
export interface LevelSpec {
  title: string;
  brief: string;
  zones: LevelZone[];
  lightingPlan: string;
  cameraIntent: string;
  /** Inventory item ids the level as a whole may use. */
  paletteAssetIds: string[];
  /** Assets the brief implies that the inventory lacks — a handoff to the model lane. */
  paletteGaps?: PaletteGap[];
  notes?: string;
}

/** Result of {@link validateLevelSpec}: `ok` plus a human-readable error list (empty when ok). */
export interface LevelSpecValidation {
  ok: boolean;
  errors: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Deterministically validate an untrusted (LLM-produced) level spec against the known inventory ids.
 * Rules:
 * - it must be a JSON object;
 * - `title` and `brief` are non-empty strings;
 * - `zones` is a non-empty array, each entry with a non-empty `id`, `name` and `purpose`;
 * - every `paletteAssetIds` entry (top-level and per-zone) must resolve to a known inventory id — a
 *   dangling palette reference is an error (the LLM invented an asset that does not exist).
 */
export function validateLevelSpec(
  spec: unknown,
  knownAssetIds: ReadonlySet<string>
): LevelSpecValidation {
  if (!isRecord(spec)) {
    return { ok: false, errors: ['Level spec must be a JSON object.'] };
  }

  const errors: string[] = [];

  if (!isNonEmptyString(spec.title)) {
    errors.push('title must be a non-empty string.');
  }
  if (!isNonEmptyString(spec.brief)) {
    errors.push('brief must be a non-empty string.');
  }

  if (!Array.isArray(spec.zones) || spec.zones.length === 0) {
    errors.push('zones must be a non-empty array.');
  } else {
    spec.zones.forEach((raw, index) => {
      if (!isRecord(raw)) {
        errors.push(`zones[${index}] must be an object.`);
        return;
      }
      if (!isNonEmptyString(raw.id)) {
        errors.push(`zones[${index}].id must be a non-empty string.`);
      }
      if (!isNonEmptyString(raw.name)) {
        errors.push(`zones[${index}].name must be a non-empty string.`);
      }
      if (!isNonEmptyString(raw.purpose)) {
        errors.push(`zones[${index}].purpose must be a non-empty string.`);
      }
      collectDanglingPaletteRefs(
        raw.paletteAssetIds,
        knownAssetIds,
        `zones[${index}].paletteAssetIds`,
        errors
      );
    });
  }

  collectDanglingPaletteRefs(spec.paletteAssetIds, knownAssetIds, 'paletteAssetIds', errors);

  // `paletteGaps` is advisory (a model-lane handoff), never a hard gate: repair it in place rather
  // than rejecting the spec — drop the field when malformed, keep only well-formed entries.
  repairPaletteGaps(spec);

  return { ok: errors.length === 0, errors };
}

/**
 * Normalize an untrusted `paletteGaps` in place: remove it entirely unless it is an array, and keep
 * only entries shaped `{ need: non-empty string; suggestedPrompt: non-empty string }`. Never pushes
 * an error — a malformed gap list is repaired, not rejected.
 */
function repairPaletteGaps(spec: Record<string, unknown>): void {
  const value = spec.paletteGaps;
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value)) {
    delete spec.paletteGaps;
    return;
  }
  const repaired = value.filter(
    (entry): entry is { need: string; suggestedPrompt: string } =>
      isRecord(entry) && isNonEmptyString(entry.need) && isNonEmptyString(entry.suggestedPrompt)
  );
  if (repaired.length === 0) {
    delete spec.paletteGaps;
    return;
  }
  spec.paletteGaps = repaired;
}

/** Push an error for every palette id that is not in `knownAssetIds`; ignores an absent list. */
function collectDanglingPaletteRefs(
  value: unknown,
  knownAssetIds: ReadonlySet<string>,
  label: string,
  errors: string[]
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of inventory ids.`);
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !entry) {
      errors.push(`${label}[${index}] must be a non-empty inventory id string.`);
      return;
    }
    if (!knownAssetIds.has(entry)) {
      errors.push(`${label}[${index}] "${entry}" is not a known inventory asset.`);
    }
  });
}
