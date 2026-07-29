/**
 * A `netId` is an opaque `uint32` handle for one entity inside one room, packed as
 * `slot | (generation << 16)`: the low 16 bits index a slot in the entity table, the high 16 bits are
 * the slot's reuse generation.
 *
 * **Why 16/16.** Server→client records address entities by `u16 Slot`, which caps `MaxEntities` at
 * 65535 anyway, so slot bits beyond 16 are unusable. Spending them on generations buys 65 536 reuses
 * per slot instead of 4 096, for free.
 *
 * **Generations start at 1**, which keeps {@link NET_ID_NONE} (0) permanently unusable as a live id,
 * so 0 is a safe "no entity" sentinel.
 *
 * **Clients must treat the value as opaque** and never compute slots or generations from it. These
 * helpers exist for the server side of the contract and for tests; a client resolves entities through
 * the slot → netId table it learns from `FullRecord`s.
 */

/** Bits reserved for the slot index. */
export const NET_ID_SLOT_BITS = 16;

/** Bits reserved for the reuse generation. */
export const NET_ID_GENERATION_BITS = 16;

/** Mask isolating the slot bits. */
export const NET_ID_SLOT_MASK = 0x0000ffff;

/** Mask isolating the generation bits, already shifted into place. */
export const NET_ID_GENERATION_MASK = 0xffff0000;

/** Largest addressable slot index. */
export const NET_ID_MAX_SLOT = 65535;

/** Largest generation a slot may reach before it must be retired (never wrapped). */
export const NET_ID_MAX_GENERATION = 65535;

/** Reserved sentinel meaning "no entity". Never a valid live id, because generations start at 1. */
export const NET_ID_NONE = 0;

/**
 * Packs a slot and a generation into a wire id. Out-of-range inputs are masked rather than throwing,
 * because this sits on the spawn path; callers must respect {@link NET_ID_MAX_SLOT} and
 * {@link NET_ID_MAX_GENERATION}.
 */
export function packNetId(slot: number, generation: number): number {
  const packed =
    (slot & NET_ID_SLOT_MASK) | ((generation & NET_ID_MAX_GENERATION) << NET_ID_SLOT_BITS);
  // `<<` yields a signed int32, so a generation with its top bit set would come out negative.
  return packed >>> 0;
}

/** Extracts the entity-table slot index. */
export function netIdSlot(netId: number): number {
  return netId & NET_ID_SLOT_MASK;
}

/** Extracts the slot's reuse generation. */
export function netIdGeneration(netId: number): number {
  return (netId >>> NET_ID_SLOT_BITS) & NET_ID_SLOT_MASK;
}

/**
 * True when the id could name a live entity, i.e. its generation is not 0. Cheap first-pass
 * validation; the entity table still has to confirm the generation.
 */
export function isValidNetId(netId: number): boolean {
  return (netId & NET_ID_GENERATION_MASK) !== 0;
}
