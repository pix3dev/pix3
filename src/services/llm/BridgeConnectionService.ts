import { inject, injectable } from '@/fw/di';
import { SecretStorageService } from '@/services/core/SecretStorageService';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { LlmProviderRegistry } from './LlmProviderRegistry';
import {
  BRIDGE_TOKEN_SECRET_ID,
  DEFAULT_BRIDGE_URL,
  createBridgeProvider,
  type BridgeProviderEntry,
  type BridgeProviderKind,
} from './BridgeProviders';

/** Legacy secret id for the bridge pairing token, pre-rename (single Claude-Code lane). */
const LEGACY_TOKEN_SECRET_ID = 'ai-provider:claude-bridge:api-key';

/** URL-fragment key of the bridge's one-click pairing link (`…/#bridge-token=<token>`). */
const PAIRING_FRAGMENT_KEY = 'bridge-token';

const hashEntries = (hash: string): string[] =>
  (hash.startsWith('#') ? hash.slice(1) : hash).split('&').filter(Boolean);

const entryKey = (entry: string): string => {
  const separator = entry.indexOf('=');
  return separator < 0 ? entry : entry.slice(0, separator);
};

/**
 * Pull the pairing token out of a location hash. The hash may carry other routing (`#welcome`), so
 * the key is matched as one entry among `&`-separated pairs rather than assumed to be alone.
 */
export const readPairingTokenFromHash = (hash: string): string | null => {
  for (const entry of hashEntries(hash)) {
    if (entryKey(entry) !== PAIRING_FRAGMENT_KEY) continue;
    const raw = entry.slice(entry.indexOf('=') + 1);
    try {
      return decodeURIComponent(raw).trim() || null;
    } catch {
      return raw.trim() || null; // Malformed escape — take it verbatim; the bridge decides.
    }
  }
  return null;
};

/** The same hash with the pairing entry removed, so the token never lingers in the address bar. */
export const stripPairingTokenFromHash = (hash: string): string => {
  const kept = hashEntries(hash).filter(entry => entryKey(entry) !== PAIRING_FRAGMENT_KEY);
  return kept.length > 0 ? `#${kept.join('&')}` : '';
};

const VALID_KINDS: readonly BridgeProviderKind[] = ['openai', 'anthropic', 'agent-sdk'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseEntries = (payload: unknown): BridgeProviderEntry[] => {
  const list = isRecord(payload) && Array.isArray(payload.providers) ? payload.providers : [];
  const entries: BridgeProviderEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== 'string' || !item.id) continue;
    const kind = VALID_KINDS.includes(item.kind as BridgeProviderKind)
      ? (item.kind as BridgeProviderKind)
      : 'openai';
    entries.push({
      id: item.id,
      label: typeof item.label === 'string' && item.label ? item.label : item.id,
      kind,
    });
  }
  return entries;
};

/**
 * Owns the editor's connection to a locally-running Pix3AgentBridge: the bridge URL, the pairing
 * token, and the discovery result. On each probe it fetches `GET /v1/providers` and rebuilds the
 * dynamic bridge-backed provider set in {@link LlmProviderRegistry} — so metered providers (OpenAI,
 * Anthropic, OpenCode Zen, custom endpoints, plus the Claude Code MAX lane) appear only while the
 * bridge is reachable and has them enabled. When the bridge is down, the set is cleared and the UI
 * falls back to Gemini + a "set up the bridge" call to action.
 *
 * Like {@link AgentSettingsService} this is app configuration and does NOT flow through appState.
 */
@injectable()
export class BridgeConnectionService {
  @inject(LlmProviderRegistry)
  private readonly registry!: LlmProviderRegistry;

  @inject(AgentSettingsService)
  private readonly settings!: AgentSettingsService;

  @inject(SecretStorageService)
  private readonly secrets!: SecretStorageService;

  private available = false;
  private entries: BridgeProviderEntry[] = [];
  private probing: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  /** First probe on startup, after migrating any pre-rename pairing token. */
  async initialize(): Promise<void> {
    await this.migrateLegacyToken();
    await this.consumePairingLink();
    // The bridge is often started while the editor tab is already open, in which case its pairing
    // link only changes the fragment of the loaded page — no reload, so `initialize` never re-runs.
    if (typeof window !== 'undefined') {
      window.addEventListener('hashchange', this.onHashChange);
    }
    await this.probe();
  }

  getBridgeUrl(): string {
    const configured = this.settings.getPreferences().bridgeUrl?.trim();
    return configured || DEFAULT_BRIDGE_URL;
  }

  async setBridgeUrl(url: string): Promise<void> {
    this.settings.updatePreferences({ bridgeUrl: url.trim() });
    await this.probe();
  }

  async getToken(): Promise<string | null> {
    return this.secrets.getSecret(BRIDGE_TOKEN_SECRET_ID);
  }

  async hasToken(): Promise<boolean> {
    return this.secrets.hasSecret(BRIDGE_TOKEN_SECRET_ID);
  }

  async setToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (trimmed) {
      await this.secrets.setSecret(BRIDGE_TOKEN_SECRET_ID, trimmed);
    } else {
      await this.secrets.deleteSecret(BRIDGE_TOKEN_SECRET_ID);
    }
    await this.probe();
  }

  /** True when the last probe reached the bridge and it reported at least one usable provider. */
  isAvailable(): boolean {
    return this.available;
  }

  /** Discovery entries from the last successful probe (empty when the bridge is unreachable). */
  getEntries(): BridgeProviderEntry[] {
    return [...this.entries];
  }

  /**
   * Ask the bridge to drop wedged Agent-SDK sessions (`POST /v1/sessions/reset`, bridge ≥0.3.0). An
   * empty body closes whatever the bridge itself considers stalled — see the bridge README's
   * "Wedged sessions" section. Called by {@link import('@/services/agent/AgentChatService').AgentChatService}
   * after it observes consecutive request timeouts on a bridge-backed provider, so the NEXT attempt
   * (in a fresh conversation) starts a healthy session instead of re-entering the dead one.
   *
   * Version-tolerant by design: an older bridge 404s/405s this route, and the bridge may simply be
   * unreachable. Both are expected, non-exceptional outcomes here — this method never throws, and
   * the caller must treat `false` as "nothing to do," never as a reason to abandon its own recovery
   * (the fresh-conversation handoff is valuable on its own, bridge or no bridge).
   */
  async resetSessions(): Promise<boolean> {
    const token = await this.getToken();
    if (!token) {
      return false;
    }
    const bridgeUrl = this.getBridgeUrl();
    try {
      const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}/v1/sessions/reset`, {
        method: 'POST',
        headers: { 'x-pix3-bridge-token': token, 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        return false;
      }
      await response.json().catch(() => null);
      return true;
    } catch {
      // Unreachable bridge / older bridge without the route / malformed response — all non-fatal.
      return false;
    }
  }

  /** Contact the bridge, refresh availability, and rebuild the dynamic provider set. */
  async probe(): Promise<void> {
    if (this.probing) {
      return this.probing;
    }
    this.probing = this.runProbe().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('hashchange', this.onHashChange);
    }
    this.listeners.clear();
  }

  // -- internals -------------------------------------------------------------

  private onHashChange = (): void => {
    void this.consumePairingLink().then(paired => {
      if (paired) {
        void this.probe();
      }
    });
  };

  /**
   * One-click pairing. The bridge prints `<editor>/#bridge-token=<token>`; opening it stores the
   * token and strips it from the URL right away — so a shared screenshot, a copied address or the
   * session history never carries it. Returns true when a token was actually taken.
   */
  private async consumePairingLink(): Promise<boolean> {
    if (typeof window === 'undefined') {
      return false;
    }
    const { hash } = window.location;
    const token = readPairingTokenFromHash(hash);
    if (!token) {
      return false;
    }
    // Strip first: if storing throws (locked secret store), the token still must not stay in the bar.
    const remaining = stripPairingTokenFromHash(hash);
    try {
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}${remaining}`
      );
    } catch {
      /* Non-navigable context — proceed with storing anyway. */
    }
    try {
      await this.secrets.setSecret(BRIDGE_TOKEN_SECRET_ID, token);
      return true;
    } catch {
      return false;
    }
  }

  private async runProbe(): Promise<void> {
    const token = await this.getToken();
    const bridgeUrl = this.getBridgeUrl();
    if (!token) {
      this.apply(false, []);
      return;
    }
    try {
      const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}/v1/providers`, {
        headers: { 'x-pix3-bridge-token': token },
      });
      if (!response.ok) {
        this.apply(false, []);
        return;
      }
      const entries = parseEntries(await response.json());
      this.apply(entries.length > 0, entries);
    } catch {
      // Bridge not running / unreachable — clear providers, surface the CTA.
      this.apply(false, []);
    }
  }

  private apply(available: boolean, entries: BridgeProviderEntry[]): void {
    this.available = available;
    this.entries = entries;
    const bridgeUrl = this.getBridgeUrl();
    this.registry.setBridgeProviders(entries.map(entry => createBridgeProvider(entry, bridgeUrl)));
    // The bridge is the only provider set that nominates a model per role (advisor / vision helper),
    // and it only exists once a probe succeeds — so this is where those defaults can first be filled
    // in. Deliberate picks are pinned and left alone.
    this.settings.applyAssistantDefaults();
    this.notify();
  }

  /** Carry a pre-rename pairing token (stored under the old claude-bridge secret) into the shared id. */
  private async migrateLegacyToken(): Promise<void> {
    try {
      if (await this.secrets.hasSecret(BRIDGE_TOKEN_SECRET_ID)) {
        return;
      }
      const legacy = await this.secrets.getSecret(LEGACY_TOKEN_SECRET_ID);
      if (legacy) {
        await this.secrets.setSecret(BRIDGE_TOKEN_SECRET_ID, legacy);
      }
    } catch {
      // Best-effort migration; a missing/locked secret store just means no token yet.
    }
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }
}
