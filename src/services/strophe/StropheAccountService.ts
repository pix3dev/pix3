import { inject, injectable } from '@/fw/di';
import { SecretStorageService } from '@/services/core/SecretStorageService';
import { StropheApiClient, type StropheAuth } from './StropheApiClient';
import {
  StropheError,
  type StropheAccount,
  type StropheFamilyDetail,
  type StropheFamilySummary,
  type StropheOutputType,
} from './StropheTypes';

/**
 * SecretStorage id for the Strophe API key. Shared by every Strophe lane (images, 3D) — one account,
 * one key, so pasting it in either place configures both.
 *
 * The prefix matches the image-gen provider convention (`ai-provider:<id>:api-key`) because
 * {@link import('@/services/image-gen/StropheImageProvider').StropheImageProvider} declares this
 * same id as its `apiKeySecretId`, which is what lets the AI Images tab and the Strophe tab agree.
 */
export const STROPHE_SECRET_ID = 'ai-provider:strophe:api-key';

/** Where a user creates a key. */
export const STROPHE_KEY_HELP_URL = 'https://strophe.app/settings';

/** Catalog freshness. Families come and go, but not within one editing session. */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 * Owns the Strophe credential and the cached account/catalog state, and is the single
 * {@link StropheAuth} implementation for the editor.
 *
 * The key is a long-lived account credential, so it lives in {@link SecretStorageService} (encrypted
 * IndexedDB) and never in `appState` or localStorage. Strophe's own docs advise against putting it in
 * client code at all; we do so knowingly because Pix3 is a serverless browser app, and the risk is
 * bounded by what Strophe lets a key carry: explicit scopes, a daily credit cap, and a per-generation
 * cap, all revocable instantly. The settings UI tells the user to set those caps.
 *
 * When Strophe ships a connect flow, {@link getToken} becomes "return the cached access token,
 * refreshing it when stale" and {@link onUnauthorized} performs the refresh — the client, the
 * providers and this service's public surface stay as they are.
 */
@injectable()
export class StropheAccountService implements StropheAuth {
  @inject(SecretStorageService)
  private readonly secrets!: SecretStorageService;

  private client: StropheApiClient | null = null;
  private account: StropheAccount | null = null;
  private accountPromise: Promise<StropheAccount> | null = null;
  private readonly familyCache = new Map<StropheOutputType | 'all', CatalogEntry>();
  private readonly familyDetails = new Map<string, StropheFamilyDetail>();
  private readonly listeners = new Set<() => void>();

  // -- StropheAuth -----------------------------------------------------------

  async getToken(): Promise<string> {
    return (await this.getKey()) ?? '';
  }

  // -- credential ------------------------------------------------------------

  async getKey(): Promise<string | null> {
    const value = await this.secrets.getSecret(STROPHE_SECRET_ID);
    return value && value.trim() ? value.trim() : null;
  }

  async hasKey(): Promise<boolean> {
    return Boolean(await this.getKey());
  }

  /** Store a key and drop every cache derived from the previous one. */
  async setKey(value: string): Promise<void> {
    await this.secrets.setSecret(STROPHE_SECRET_ID, value.trim());
    this.invalidate();
  }

  async clearKey(): Promise<void> {
    await this.secrets.deleteSecret(STROPHE_SECRET_ID);
    this.invalidate();
  }

  /** A client bound to this service's credential. Cheap — reuse is just an optimization. */
  getClient(): StropheApiClient {
    if (!this.client) {
      this.client = new StropheApiClient({ auth: this });
    }
    return this.client;
  }

  // -- account ---------------------------------------------------------------

  /**
   * The account snapshot (plan, credits, the key's scopes and spend limits), cached for the session.
   * Concurrent callers share one in-flight request. Returns null when no key is configured or the
   * probe fails — callers render "not connected" rather than an error, since this is status, not a
   * user action.
   */
  async getAccountStatus(opts: { refresh?: boolean } = {}): Promise<StropheAccount | null> {
    if (opts.refresh) {
      this.account = null;
      this.accountPromise = null;
    }
    if (this.account) {
      return this.account;
    }
    if (!(await this.hasKey())) {
      return null;
    }
    if (!this.accountPromise) {
      this.accountPromise = this.getClient()
        .getAccount()
        .then(account => {
          this.account = account;
          this.notify();
          return account;
        })
        .finally(() => {
          this.accountPromise = null;
        });
    }
    try {
      return await this.accountPromise;
    } catch {
      return null;
    }
  }

  /**
   * Verify a key by calling `/account` with it, WITHOUT storing it. Used by the settings tab so a
   * typo is reported at paste time instead of at first generation. Resolves with the account on
   * success; throws the typed {@link StropheError} otherwise.
   */
  async verifyKey(candidate: string): Promise<StropheAccount> {
    const key = candidate.trim();
    if (!key) {
      throw new StropheError('unauthorized', 'Enter a Strophe API key first.');
    }
    const probe = new StropheApiClient({ auth: { getToken: () => key } });
    return probe.getAccount();
  }

  // -- catalog ---------------------------------------------------------------

  /**
   * Families for one output modality (or all), cached for {@link CATALOG_TTL_MS}. Unavailable
   * families are kept — the caller decides whether to show them greyed out with their `lockReason`.
   */
  async listFamilies(
    outputType?: StropheOutputType,
    opts: { refresh?: boolean } = {}
  ): Promise<StropheFamilySummary[]> {
    const key = outputType ?? 'all';
    const cached = this.familyCache.get(key);
    if (!opts.refresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) {
      return cached.families;
    }
    const families = await this.getClient().listFamilies({ outputType });
    this.familyCache.set(key, { at: Date.now(), families });
    this.notify();
    return families;
  }

  /** One family's full schema (axes, variants, parameters), cached for the session. */
  async getFamily(
    familyId: string,
    opts: { refresh?: boolean } = {}
  ): Promise<StropheFamilyDetail> {
    const cached = this.familyDetails.get(familyId);
    if (!opts.refresh && cached) {
      return cached;
    }
    const detail = await this.getClient().getFamily(familyId);
    this.familyDetails.set(familyId, detail);
    return detail;
  }

  /** Cached families without hitting the network — for synchronous render paths. */
  peekFamilies(outputType?: StropheOutputType): readonly StropheFamilySummary[] {
    return this.familyCache.get(outputType ?? 'all')?.families ?? [];
  }

  // -- misc ------------------------------------------------------------------

  /** Notified whenever the key, account snapshot or catalog cache changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
    this.invalidate();
  }

  private invalidate(): void {
    this.client = null;
    this.account = null;
    this.accountPromise = null;
    this.familyCache.clear();
    this.familyDetails.clear();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

interface CatalogEntry {
  at: number;
  families: StropheFamilySummary[];
}

/**
 * Human-readable spend headroom for the connected account.
 *
 * Team-pool accounts report `availableCredits: null` (spending is bounded by the shared pool, not a
 * personal balance), so a plain "credits left" number is not always available. The key's own daily
 * cap is, and for our purposes it is the more useful figure anyway — it is what actually limits an
 * agent running generations unattended.
 */
export function describeSpendHeadroom(account: StropheAccount | null): string {
  if (!account) {
    return 'Not connected';
  }
  const limits = account.token?.limits;
  if (typeof limits?.dailyCredits === 'number') {
    const spent = limits.spentToday ?? 0;
    return `${Math.max(0, limits.dailyCredits - spent)} of ${limits.dailyCredits} credits left today`;
  }
  if (typeof account.availableCredits === 'number') {
    return `${account.availableCredits} credits available`;
  }
  if (account.unlimited) {
    return 'Unlimited plan';
  }
  return account.team?.name ? `Team pool — ${account.team.name}` : 'Connected';
}
