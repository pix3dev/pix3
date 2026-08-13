/**
 * Persistent configuration for Pix3AgentBridge, stored in `~/.pix3/agent-bridge.json`.
 *
 * Beyond the pairing token / port / origins the bridge always had, this now holds the **provider
 * table**: for each metered LLM provider (OpenAI, Anthropic API, OpenCode Zen, or a user-defined
 * OpenAI-compatible endpoint) the upstream base URL, the API key, and an enabled flag. Keys live
 * ONLY here on the user's machine — the editor never receives them; it authenticates to the bridge
 * with the pairing token and the bridge injects the real key when forwarding upstream.
 *
 * The provider table is managed through the CLI (`pix3-agent-bridge provider add|remove|enable|…`),
 * never by hand-editing (though the file is plain JSON if you must).
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Provider ids the bridge reserves for its own intrinsic lanes (e.g. the Agent-SDK lane exposed as
 * `claude-bridge` in discovery). The CLI rejects adding a provider under one of these so `GET
 * /v1/providers` can never emit duplicate ids.
 */
export const RESERVED_PROVIDER_IDS = ['claude-bridge'] as const;

/** Upstream auth scheme: how the bridge presents the stored key to the provider. */
export type ProviderKind = 'openai' | 'anthropic';

export interface ProviderConfig {
  /**
   * `openai` → forward `Authorization: Bearer <key>` (OpenAI Chat Completions, OpenCode Zen, most
   * gateways, local Ollama/LM Studio). `anthropic` → forward `x-api-key: <key>` + `anthropic-version`
   * (native Anthropic Messages API).
   */
  kind: ProviderKind;
  /** Human label shown in the editor picker and `provider list`. */
  label: string;
  /** Upstream base URL INCLUDING the version segment, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Provider API key. Empty string = not yet configured (provider stays effectively unusable). */
  apiKey: string;
  /** When false the provider is hidden from discovery and its proxy route 404s. */
  enabled: boolean;
  /** True for the shipped presets (openai/anthropic/opencode-zen/cerebras); false for user-added. */
  builtin?: boolean;
}

export interface BridgeConfig {
  token: string;
  port: number;
  origins: string[];
  providers: Record<string, ProviderConfig>;
  /** Watchdog threshold for wedged Agent-SDK sessions — see {@link DEFAULT_STALL_TIMEOUT_MS}. */
  stallTimeoutMs: number;
}

/**
 * Shipped presets: `provider add <id> --key <k>` for one of these fills in kind/label/baseUrl so the
 * common providers are one command away. A custom OpenAI-compatible endpoint is added with an
 * arbitrary id plus an explicit `--base-url`.
 */
export const PROVIDER_PRESETS: Record<string, Omit<ProviderConfig, 'apiKey' | 'enabled'>> = {
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    builtin: true,
  },
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    builtin: true,
  },
  'opencode-zen': {
    kind: 'openai',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    builtin: true,
  },
  cerebras: {
    kind: 'openai',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    builtin: true,
  },
};

export const DEFAULT_PORT = 8484;

/**
 * Watchdog threshold: how long an Agent-SDK session may sit BUSY (an HTTP request waiting on the
 * model) with no output at all from the CLI before the bridge declares it wedged, interrupts it and
 * frees its slot.
 *
 * Sizing: the editor gives up on one `/v1/messages` call after 180 s
 * (`LLM_REQUEST_TIMEOUT_MS` in pix3's `AgentChatService`), so anything at or below that would race
 * the client's own timeout and could kill a session that is merely slow. 5 minutes sits well above
 * it while staying far below the 20-minute per-request hard cap in sessions.ts — a session that has
 * produced nothing for five minutes is dead, not thinking (a thinking-hard turn still emits
 * assistant / tool-call messages, each of which counts as progress).
 *
 * Override (most specific wins): `PIX3_BRIDGE_STALL_TIMEOUT_MS` env var, `--stall-timeout-ms <n>`
 * serve flag, `stallTimeoutMs` in `~/.pix3/agent-bridge.json`.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 5 * 60_000;

/** Floor for the watchdog threshold — below this it would start racing the editor's 180 s timeout. */
export const MIN_STALL_TIMEOUT_MS = 60_000;

/** Clamp an operator-supplied watchdog threshold; anything unusable falls back to the default. */
export const normalizeStallTimeoutMs = (value: unknown): number => {
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_STALL_TIMEOUT_MS;
  return Math.max(MIN_STALL_TIMEOUT_MS, Math.round(ms));
};

export const DEFAULT_ORIGINS = [
  'https://editor.pix3.dev',
  'https://cloud.pix3.dev',
  'http://localhost:8123',
  'http://127.0.0.1:8123',
];

const CONFIG_DIR = path.join(os.homedir(), '.pix3');
const CONFIG_PATH = path.join(CONFIG_DIR, 'agent-bridge.json');
/** Pre-rename config file. Read once to carry the existing pairing token forward on first run. */
const LEGACY_CONFIG_PATH = path.join(CONFIG_DIR, 'claude-bridge.json');

export const configPath = (): string => CONFIG_PATH;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseProviders = (raw: unknown): Record<string, ProviderConfig> => {
  if (!isRecord(raw)) return {};
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const kind = value.kind === 'anthropic' ? 'anthropic' : 'openai';
    if (typeof value.baseUrl !== 'string' || !value.baseUrl) continue;
    providers[id] = {
      kind,
      label: typeof value.label === 'string' && value.label ? value.label : id,
      baseUrl: value.baseUrl.replace(/\/$/, ''),
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      enabled: value.enabled !== false,
      builtin: value.builtin === true,
    };
  }
  return providers;
};

const readLegacyToken = (): string | null => {
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, 'utf8')) as unknown;
    if (isRecord(legacy) && typeof legacy.token === 'string' && legacy.token.length >= 16) {
      return legacy.token;
    }
  } catch {
    /* no legacy file */
  }
  return null;
};

/** Load config, creating the file (and a fresh pairing token) on first run. */
export const loadConfig = (): BridgeConfig => {
  let stored: Partial<BridgeConfig> = {};
  let existed = false;
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<BridgeConfig>;
    existed = true;
  } catch {
    /* first run */
  }

  const config: BridgeConfig = {
    token:
      typeof stored.token === 'string' && stored.token.length >= 16
        ? stored.token
        : (readLegacyToken() ?? randomBytes(24).toString('base64url')),
    port: typeof stored.port === 'number' ? stored.port : DEFAULT_PORT,
    origins: [
      ...DEFAULT_ORIGINS,
      ...(Array.isArray(stored.origins) ? stored.origins.filter(o => typeof o === 'string') : []),
    ],
    providers: parseProviders(stored.providers),
    stallTimeoutMs: normalizeStallTimeoutMs(
      process.env.PIX3_BRIDGE_STALL_TIMEOUT_MS ?? stored.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
    ),
  };

  // Persist on first run (or after a legacy-token migration) so the token is stable across restarts.
  if (!existed || !stored.token) {
    saveConfig(config);
  } else {
    // Configs written by older versions are 0644 — re-tighten them on every boot rather than only
    // when something happens to rewrite the file.
    restrictPermissions();
  }
  return config;
};

/**
 * Tighten the config to owner-only. It holds the pairing token AND every provider API key, so on a
 * shared machine the default 0644 hands all of it to any other local account. Best-effort: chmod is
 * a near-no-op on Windows, and a config on an exotic filesystem must not stop the bridge booting.
 */
const restrictPermissions = (): void => {
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* not supported here — the token check is still the real gate */
  }
};

/** Persist only the durable fields (token, port, custom origins, providers) — never the merged defaults. */
export const saveConfig = (config: BridgeConfig): void => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const customOrigins = config.origins.filter(o => !DEFAULT_ORIGINS.includes(o));
  const persisted = {
    token: config.token,
    ...(config.port !== DEFAULT_PORT ? { port: config.port } : {}),
    ...(customOrigins.length > 0 ? { origins: customOrigins } : {}),
    ...(config.stallTimeoutMs !== DEFAULT_STALL_TIMEOUT_MS
      ? { stallTimeoutMs: config.stallTimeoutMs }
      : {}),
    providers: config.providers,
  };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  restrictPermissions();
};
