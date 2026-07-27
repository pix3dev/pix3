/**
 * Converts between floats and the quantized integers that **are** the replicated values, against one
 * room's world bounds. Positions are `u16` across {@link WorldQuantizer.size}, rotation is `u8` across
 * a full turn, velocity is `i16` at 1/8 u/s.
 *
 * **Rounding is normative.** `round(v)` means exactly `Math.floor(v + 0.5)` — half rounding towards
 * +∞ — and **not** `Math.round`. The two are different functions: for `v = 0.49999999999999994` (the
 * largest double below ½) `Math.round(v)` is `0` while `Math.floor(v + 0.5)` is `1`, because the
 * addition itself rounds up to `1.0`. The C# side spells `Math.Floor(v + 0.5)` out for the same
 * reason (`MathF.Round` is banker's rounding, `MidpointRounding.AwayFromZero` disagrees on negative
 * halves). Golden vectors pin this; do not "simplify" it.
 *
 * **Intermediate arithmetic is `double`**, which is all JavaScript has, and that is deliberate rather
 * than a limitation: widening a float to a double is exact, so double intermediates are the only way
 * the two implementations land on the same integer at a rounding boundary. Never emulate float32
 * arithmetic here. The one place float32 does appear is on the way *out* — a dequantized value is
 * handed to the game as a float32, so {@link WorldQuantizer.dequantizeX} and friends apply
 * `Math.fround`, matching the C# `(float)` cast that the round-trip fixed point is defined against.
 *
 * **Non-finite input is rejected, never quantized.** One NaN poisons the spatial hash, so the
 * `tryQuantize…` methods return `false`/`null` and the caller counts a `nan` violation. In-range
 * clamping, by contrast, is silent — that is what the `clamp` in the spec table means.
 *
 * **Round-trip property.** `quantize(dequantize(quantize(v))) === quantize(v)`: a dequantized value is
 * a fixed point under a second quantize. That is what lets an owning client render its own entity from
 * the dequantized value without chasing a divergence pop, and what lets dirty detection compare
 * integers instead of floats. It holds only while the world respects
 * {@link MAX_COORDINATE_TO_SIZE_RATIO}, which the constructor enforces.
 */

/** Largest quantized position value; also the number of intervals across the world size. */
export const POSITION_MAX = 65535;

/** Quantized rotation steps in a full turn. The wire value is a `u8`, so this is 256. */
export const ROTATION_STEPS = 256;

/** Fixed-point scale for velocity: 1/8 u/s per step, −4096.0…+4095.875 u/s. */
export const VELOCITY_SCALE = 8;

/** Smallest quantized velocity (`i16` floor). */
export const VELOCITY_MIN = -32768;

/** Largest quantized velocity (`i16` ceiling). */
export const VELOCITY_MAX = 32767;

/** Smallest legal world size. A degenerate world would divide by ~0. */
export const MIN_WORLD_SIZE = 1;

/**
 * Largest ratio of any world coordinate's magnitude to the world size that still preserves the
 * round-trip fixed point.
 *
 * Dequantized values reach the game as float32, whose relative error is 2⁻²⁴. Requantizing lands on
 * the same integer only while `M × 2⁻²⁴ × 65535 / size < ½`, i.e. `M < 128 × size`, where `M` is the
 * largest coordinate magnitude in the world. A world far from the origin relative to its own size
 * (say origin 10⁷ with size 100) would break replication *silently* — positions would oscillate by a
 * quantum forever — so it is refused at construction instead.
 */
export const MAX_COORDINATE_TO_SIZE_RATIO = 128;

const TWO_PI = Math.PI * 2;

/** Output of {@link WorldQuantizer.tryQuantizePosition}, reused across calls to stay allocation-free. */
export interface QuantizedPosition {
  /** Quantized world X, `0…65535`. */
  qx: number;
  /** Quantized world Y, `0…65535`. */
  qy: number;
}

/** Creates a zeroed {@link QuantizedPosition} to pass as an out-parameter. */
export function createQuantizedPosition(): QuantizedPosition {
  return { qx: 0, qy: 0 };
}

/**
 * True when these bounds are usable: all three finite, `size` at least {@link MIN_WORLD_SIZE}, and
 * every coordinate magnitude within {@link MAX_COORDINATE_TO_SIZE_RATIO} × `size`. Call this to
 * validate configuration before constructing a {@link WorldQuantizer}.
 */
export function isValidWorld(originX: number, originY: number, size: number): boolean {
  return (
    Number.isFinite(originX) &&
    Number.isFinite(originY) &&
    Number.isFinite(size) &&
    size >= MIN_WORLD_SIZE &&
    isRatioSafe(originX, originY, size)
  );
}

/**
 * The float32 precision guard behind {@link MAX_COORDINATE_TO_SIZE_RATIO}, applied to both corners of
 * the world on both axes. `Math.fround` on the far-corner sums mirrors the C# float addition, so the
 * two implementations accept and refuse exactly the same worlds.
 */
function isRatioSafe(originX: number, originY: number, size: number): boolean {
  const limit = Math.fround(MAX_COORDINATE_TO_SIZE_RATIO * size);
  return (
    Math.abs(originX) < limit &&
    Math.abs(originY) < limit &&
    Math.abs(Math.fround(originX + size)) < limit &&
    Math.abs(Math.fround(originY + size)) < limit
  );
}

/** See the module doc — the normative rounding rule, spelled out once. */
function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

export class WorldQuantizer {
  /** World-space X of the low corner of the quantization range. */
  readonly originX: number;

  /** World-space Y of the low corner of the quantization range. */
  readonly originY: number;

  /** Side length of the square world this room quantizes against. Defaults to 4096 per room config. */
  readonly size: number;

  /**
   * Binds a quantizer to one room's world bounds.
   *
   * @throws RangeError when a bound is non-finite, `size` is below {@link MIN_WORLD_SIZE}, or the
   * bounds break {@link MAX_COORDINATE_TO_SIZE_RATIO}. Rooms are constructed on the control path, so
   * throwing here is correct: an invalid world is a configuration bug, not a runtime event, and it
   * must not be allowed to reach the tick loop.
   */
  constructor(originX: number, originY: number, size: number) {
    if (!Number.isFinite(originX)) {
      throw new RangeError(`World origin X must be finite, got ${originX}.`);
    }
    if (!Number.isFinite(originY)) {
      throw new RangeError(`World origin Y must be finite, got ${originY}.`);
    }
    if (!Number.isFinite(size) || size < MIN_WORLD_SIZE) {
      throw new RangeError(
        `World size must be finite and at least ${MIN_WORLD_SIZE}, got ${size}.`
      );
    }
    if (!isRatioSafe(originX, originY, size)) {
      throw new RangeError(
        'World bounds are too far from the origin for their size: every coordinate magnitude must ' +
          `stay below ${MAX_COORDINATE_TO_SIZE_RATIO} × size, or float32 round-tripping stops being ` +
          'a fixed point and positions oscillate by a quantum forever.'
      );
    }

    this.originX = originX;
    this.originY = originY;
    this.size = size;
  }

  /** World-space X of the far edge of the quantization range. */
  get maxX(): number {
    return this.originX + this.size;
  }

  /** World-space Y of the far edge of the quantization range. */
  get maxY(): number {
    return this.originY + this.size;
  }

  // ── Position ───────────────────────────────────────────────────────────────

  /**
   * Quantizes a world position: `clamp(round((v − origin) × 65535 / size), 0, 65535)` per axis.
   * Returns `false` — writing nothing — when either coordinate is not finite, so the caller can count
   * a `nan` violation and drop the record. Out-of-world coordinates are clamped silently.
   */
  tryQuantizePosition(x: number, y: number, out: QuantizedPosition): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      out.qx = 0;
      out.qy = 0;
      return false;
    }

    out.qx = this.quantizeAxis(x, this.originX);
    out.qy = this.quantizeAxis(y, this.originY);
    return true;
  }

  /** Dequantizes an X coordinate: `origin + q × size / 65535`, delivered as a float32. */
  dequantizeX(qx: number): number {
    return Math.fround(this.originX + (qx * this.size) / POSITION_MAX);
  }

  /** Dequantizes a Y coordinate: `origin + q × size / 65535`, delivered as a float32. */
  dequantizeY(qy: number): number {
    return Math.fround(this.originY + (qy * this.size) / POSITION_MAX);
  }

  private quantizeAxis(v: number, origin: number): number {
    const scaled = roundHalfUp(((v - origin) * POSITION_MAX) / this.size);
    if (scaled <= 0) {
      return 0;
    }
    if (scaled >= POSITION_MAX) {
      return POSITION_MAX;
    }
    return scaled;
  }
}

// ── Rotation and velocity (world-independent) ────────────────────────────────

/**
 * Quantizes a rotation in radians: wrapped into `[0, 2π)` first, then `round(w / 2π × 256) & 0xFF`.
 * The mask is what folds a value that rounded up to a full turn back onto 0. Returns `null` when
 * `rot` is not finite.
 */
export function tryQuantizeRotation(rot: number): number | null {
  if (!Number.isFinite(rot)) {
    return null;
  }

  let wrapped = rot % TWO_PI;
  if (wrapped < 0) {
    wrapped += TWO_PI;
  }

  const steps = roundHalfUp((wrapped / TWO_PI) * ROTATION_STEPS);
  return steps & 0xff;
}

/** Dequantizes a rotation: `q × 2π / 256` radians, always in `[0, 2π)`, delivered as a float32. */
export function dequantizeRotation(q: number): number {
  return Math.fround((q * TWO_PI) / ROTATION_STEPS);
}

/**
 * Quantizes a velocity component: `clamp(round(v × 8), −32768, 32767)`, i.e. 1/8 u/s resolution over
 * ±4095 u/s. Returns `null` when `v` is not finite; out-of-range speeds are clamped silently.
 */
export function tryQuantizeVelocity(v: number): number | null {
  if (!Number.isFinite(v)) {
    return null;
  }

  const scaled = roundHalfUp(v * VELOCITY_SCALE);
  if (scaled <= VELOCITY_MIN) {
    return VELOCITY_MIN;
  }
  if (scaled >= VELOCITY_MAX) {
    return VELOCITY_MAX;
  }
  return scaled;
}

/** Dequantizes a velocity component: `q / 8` units per second, delivered as a float32. */
export function dequantizeVelocity(q: number): number {
  return Math.fround(q / VELOCITY_SCALE);
}
