import { inject, injectable } from '@/fw/di';
import { SecretStorageService } from '@/services/SecretStorageService';
import { AgentSettingsService } from '@/services/AgentSettingsService';
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
    this.listeners.clear();
  }

  // -- internals -------------------------------------------------------------

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
