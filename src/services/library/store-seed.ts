/**
 * One-shot seeding of the curated store from the static starter pack (`public/library/`).
 *
 * The pack predates the store and is still the offline fallback (see `StoreLibraryProvider`), but a
 * fallback item cannot be curated: it has no server row, so it cannot be re-filed, featured, or
 * replaced without shipping a new editor build. Seeding uploads the very same bundles to the server
 * under their original ids, after which the provider's id-merge makes the server copy win and the
 * pack goes back to being what it is — a network-less fallback.
 *
 * Two properties make this safe to run more than once (there is no "already seeded" flag anywhere):
 * ids are stable, so an upload REPLACES the item instead of duplicating it, and whatever an admin
 * has since changed on the server (status, category, featured) is read back first and preserved.
 */

import type {
  LibraryBundle,
  LibraryItem,
  LibraryItemManifest,
  StoreItemStatus,
} from '@/services/library/library-types';
import { validateStorePublish } from '@/services/library/store-validation';

/** Category the seeded items land in when the server has no opinion on them yet. */
export const STORE_SEED_CATEGORY_ID = 'starter';
export const STORE_SEED_CATEGORY_LABEL = 'Starter Pack';

/** Publisher shown for pack content; matches the synthesized label for fallback items. */
const SEED_PUBLISHER = 'Pix3 Team';

/**
 * Bare license ids (what the shipped pack and old personal items carry) → the SPDX ids the publish
 * gate accepts. Without this the pack could only ever be seeded as drafts: `CC0` is not whitelisted.
 */
const LICENSE_ALIASES: Readonly<Record<string, string>> = {
  CC0: 'CC0-1.0',
  'CC0-1.0': 'CC0-1.0',
  'CC-BY': 'CC-BY-4.0',
  'CC-BY-4.0': 'CC-BY-4.0',
  OFL: 'OFL-1.1',
  'OFL-1.1': 'OFL-1.1',
  MIT: 'MIT',
};

/** Map a license id onto its whitelisted form; unknown ids pass through untouched (gate rejects). */
export function normalizeStoreLicense(license: string | undefined): string | undefined {
  if (!license) {
    return undefined;
  }
  return LICENSE_ALIASES[license.trim()] ?? license.trim();
}

export interface StoreSeedItemOutcome {
  id: string;
  name: string;
  /** `created` / `updated` reflect whether the server already had a row for this id. */
  result: 'created' | 'updated' | 'failed';
  /** Effective status as reported by the server (absent when the upload failed). */
  status?: StoreItemStatus;
  error?: string;
}

export interface StoreSeedResult {
  outcomes: StoreSeedItemOutcome[];
  /** False when the taxonomy row could not be ensured — seeded items then stay uncategorized. */
  categoryReady: boolean;
}

/**
 * Collaborators the seed needs. Passed in rather than imported so the panel wires the real
 * `AssetLibraryService`/`ApiClient` while a spec can drive the whole flow with plain objects.
 */
export interface StoreSeedDeps {
  /** The static pack: its items and their bundles. */
  listPackItems(): Promise<readonly LibraryItem[]>;
  getPackBundle(id: string): Promise<LibraryBundle | null>;
  /** Items the SERVER holds (never the merged aggregate — that would include the pack itself). */
  listServerItems(): Promise<readonly StoreSeedPriorItem[]>;
  /** Idempotent category upsert (`POST /categories` creates or overwrites). */
  ensureCategory(input: { id: string; label: string }): Promise<void>;
  putStoreItem(bundle: LibraryBundle): Promise<LibraryItem>;
}

/** What the server already says about an item id — the curation a re-seed must not overwrite. */
export interface StoreSeedPriorItem {
  id: string;
  status: StoreItemStatus;
  categoryPath: string | null;
}

/** Upload every pack item into the store, preserving curation already applied on the server. */
export async function seedStoreFromBuiltinPack(deps: StoreSeedDeps): Promise<StoreSeedResult> {
  const packItems = await deps.listPackItems();
  if (packItems.length === 0) {
    return { outcomes: [], categoryReady: false };
  }

  const existing = new Map<string, StoreSeedPriorItem>();
  try {
    for (const prior of await deps.listServerItems()) {
      existing.set(prior.id, prior);
    }
  } catch {
    // Unreachable server: fall through and let the uploads themselves report the failure, rather
    // than reporting nothing at all. Nothing is preserved in that case because nothing was read.
  }

  let categoryReady = false;
  try {
    await deps.ensureCategory({ id: STORE_SEED_CATEGORY_ID, label: STORE_SEED_CATEGORY_LABEL });
    categoryReady = true;
  } catch {
    // A failed taxonomy write is not fatal: items upload as drafts and an admin files them later.
  }

  const outcomes: StoreSeedItemOutcome[] = [];
  for (const item of packItems) {
    const prior = existing.get(item.manifest.id);
    const result = prior ? 'updated' : 'created';
    try {
      const bundle = await deps.getPackBundle(item.manifest.id);
      if (!bundle) {
        throw new Error('The pack bundle could not be read.');
      }
      const manifest = seedManifest(bundle.manifest, prior, categoryReady);
      const stored = await deps.putStoreItem({ manifest, files: bundle.files });
      outcomes.push({
        id: manifest.id,
        name: manifest.name,
        result,
        status: stored.manifest.status ?? manifest.status,
      });
    } catch (error) {
      outcomes.push({
        id: item.manifest.id,
        name: item.manifest.name,
        result: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { outcomes, categoryReady };
}

/**
 * Turn a pack manifest into a store manifest. Server-owned counters are dropped (the server
 * re-stamps them anyway) and the lifecycle fields defer to whatever the server already says.
 */
function seedManifest(
  packManifest: LibraryItemManifest,
  prior: StoreSeedPriorItem | undefined,
  categoryReady: boolean
): LibraryItemManifest {
  const {
    downloads: _downloads,
    featured: _featured,
    publisherId: _publisherId,
    ...base
  } = packManifest;

  const categoryPath = prior?.categoryPath ?? (categoryReady ? STORE_SEED_CATEGORY_ID : undefined);
  const candidate: LibraryItemManifest = {
    ...base,
    license: normalizeStoreLicense(base.license),
    categoryPath: categoryPath ?? undefined,
    version: base.version ?? '1.0.0',
    publisherName: base.publisherName ?? SEED_PUBLISHER,
    // An admin who unlisted or re-drafted a seeded item must not have it silently republished.
    status: prior?.status ?? 'published',
  };

  if (candidate.status === 'published' && validateStorePublish(candidate).length > 0) {
    // Publishing is gated server-side too, so an incomplete pack item would be rejected outright
    // (400, nothing written). Downgrading to a draft keeps the seed all-or-nothing per item.
    return { ...candidate, status: 'draft' };
  }
  return candidate;
}
