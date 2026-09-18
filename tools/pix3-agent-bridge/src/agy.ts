/**
 * Discovery, health and model catalog for the **Antigravity CLI (`agy`)** lane.
 *
 * This is the "is it installed, does it work, what can it run" half of the lane; `agy-session.ts`
 * is the half that actually talks to it. The detection pipeline (version probe gates availability →
 * auth + models probed after → a single `{available, path, version, auth, diagnostics}` snapshot,
 * with every failure isolated so discovery itself cannot throw) follows `nexu-io/open-design`'s
 * `apps/daemon/src/runtimes/detection.ts` (Apache-2.0, with attribution).
 *
 * Everything measured here was measured against a live `agy` (see `.plans/agy-bridge-lane.md` §6):
 *
 *   - `agy models` prints a "Fetching available models..." banner first, then `id \t label` lines.
 *   - Model families ending in `-low|-medium|-high` are the SAME model at different reasoning
 *     depths, and the bare family id REQUIRES `--effort` (the CLI says so, and lists the levels it
 *     accepts). So a family with several variants is published as one model whose
 *     `reasoningEfforts` are exactly the variants that exist.
 *   - MCP tool calls are auto-denied in print mode unless `--dangerously-skip-permissions` is passed
 *     (`--mode accept-edits` does NOT help, and the result carries `denied_actions`). That flag is
 *     opt-in, so `supportsTools` is gated on BOTH the shim being registered and the opt-in being on
 *     — otherwise the editor would offer tools that can only ever fail.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgyConfig } from './config.ts';
import { agyShimPath } from './mcp-shim.ts';
import { probeExecutable, resolveExecutable } from './executables.ts';

/** Discovery id of this lane, as it appears in `GET /v1/providers` → `agents[]`. */
export const AGY_AGENT_ID = 'agy';
export const AGY_LABEL = 'Antigravity (agy)';
/** MCP server name the shim is registered under, inside agy's own config. */
export const AGY_MCP_SERVER_NAME = 'pix3';

/**
 * Versions this lane was actually exercised against. Anything else still runs — the parser is
 * tolerant of unknown events — but earns a warning diagnostic, because `agy`'s stream-json schema
 * is young and has already changed shape once (1.0.x had no `--model` at all).
 */
const SUPPORTED_VERSION = /^1\.[12]\.\d+$/;

/** Installers that never touch PATH. The Windows one is where `agy` actually lands today. */
const WELL_KNOWN_DIRS = (): string[] => {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA;
  return [
    ...(localAppData ? [path.join(localAppData, 'agy', 'bin')] : []),
    path.join(home, '.local', 'bin'),
    path.join(home, '.agy', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
};

/** agy's own config lives under `~/.gemini` — OAuth creds, MCP servers, settings. */
const geminiDir = (): string => path.join(os.homedir(), '.gemini');
const oauthCredsPath = (): string => path.join(geminiDir(), 'oauth_creds.json');
const mcpConfigPath = (): string => path.join(geminiDir(), 'config', 'mcp_config.json');

export interface AgyDiagnostic {
  readonly reason: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly detail?: string;
}

export type AgyAuthStatus = 'ok' | 'missing' | 'unknown';

export interface AgyStatus {
  readonly available: boolean;
  readonly path?: string;
  readonly version?: string;
  readonly auth: AgyAuthStatus;
  readonly mcp: 'registered' | 'missing';
  /** True when the editor's tools can actually be called — see the header note on permissions. */
  readonly toolsEnabled: boolean;
  readonly diagnostics: AgyDiagnostic[];
}

export interface AgyModelCapabilities {
  readonly supportsTools: boolean;
  readonly supportsImages: boolean;
  readonly supportsSystemPrompt: boolean;
  readonly maxOutputTokens: number;
  readonly contextWindow: number;
  readonly reasoningEfforts?: readonly string[];
}

export interface AgyModel {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly capabilities: AgyModelCapabilities;
  readonly pricing: { readonly inputPer1M: 0; readonly outputPer1M: 0 };
}

/** One entry of the live `agy models` catalog, after family collapsing. */
export interface AgyModelEntry {
  readonly id: string;
  readonly label: string;
  /** Reasoning levels this id accepts via `--effort`; empty when the id takes no `--effort`. */
  readonly efforts: readonly string[];
}

const EFFORT_SUFFIX = /^(.+)-(low|medium|high)$/;
/** Trailing "(High)" / "(Medium)" / "(Low)" in the human label of an effort variant. */
const EFFORT_LABEL_SUFFIX = /\s*\((?:Low|Medium|High)\)\s*$/i;

interface FamilySpec {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

/**
 * Context/output sizes by model family. `agy` does not report them, and the editor needs a number
 * to draw its context bar, so this is a static table keyed on an id prefix with a conservative
 * fallback for anything new.
 */
const FAMILY_SPECS: ReadonlyArray<readonly [string, FamilySpec]> = [
  ['gemini-3.1-pro', { contextWindow: 1_000_000, maxOutputTokens: 32_000 }],
  ['gemini-3', { contextWindow: 1_000_000, maxOutputTokens: 32_000 }],
  ['claude-opus', { contextWindow: 200_000, maxOutputTokens: 32_000 }],
  ['claude-sonnet', { contextWindow: 200_000, maxOutputTokens: 32_000 }],
  ['claude', { contextWindow: 200_000, maxOutputTokens: 16_000 }],
  ['gpt-oss', { contextWindow: 128_000, maxOutputTokens: 16_000 }],
];

const DEFAULT_SPEC: FamilySpec = { contextWindow: 128_000, maxOutputTokens: 16_000 };

const specFor = (id: string): FamilySpec =>
  FAMILY_SPECS.find(([prefix]) => id.startsWith(prefix))?.[1] ?? DEFAULT_SPEC;

/**
 * Static fallback catalog, used when `agy models` cannot be reached (offline, quota, a version that
 * renamed the subcommand). Measured from agy 1.2.5.
 */
const FALLBACK_ENTRIES: readonly AgyModelEntry[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', efforts: [] },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', efforts: [] },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', efforts: [] },
];

/**
 * Collapse `agy models` output into one entry per family.
 *
 * A family is collapsed only when it has MORE THAN ONE effort variant: `gpt-oss-120b-medium` is a
 * single id that happens to end in `-medium`, and turning it into `gpt-oss-120b --effort medium`
 * would invent a model the CLI does not accept.
 */
export const parseModelCatalog = (stdout: string): AgyModelEntry[] => {
  const raw: Array<{ id: string; label: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue; // banner lines ("Fetching available models...") have no tab
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (id) raw.push({ id, label: label || id });
  }

  const families = new Map<string, { label: string; efforts: string[] }>();
  for (const { id, label } of raw) {
    const match = EFFORT_SUFFIX.exec(id);
    if (!match) continue;
    const [, family, effort] = match;
    const entry = families.get(family) ?? { label: label.replace(EFFORT_LABEL_SUFFIX, ''), efforts: [] };
    if (!entry.efforts.includes(effort)) entry.efforts.push(effort);
    families.set(family, entry);
  }

  const order = ['low', 'medium', 'high'];
  const entries: AgyModelEntry[] = [];
  for (const { id, label } of raw) {
    const match = EFFORT_SUFFIX.exec(id);
    const family = match?.[1];
    if (family) {
      const collapsed = families.get(family);
      if (!collapsed) continue;
      if (collapsed.efforts.length < 2) {
        // Single-variant "family" — keep the literal id the CLI knows.
        if (!entries.some(entry => entry.id === id)) {
          entries.push({ id, label, efforts: [] });
        }
        continue;
      }
      if (entries.some(entry => entry.id === family)) continue;
      entries.push({
        id: family,
        label: collapsed.label,
        efforts: [...collapsed.efforts].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
      });
      continue;
    }
    if (!entries.some(entry => entry.id === id)) entries.push({ id, label, efforts: [] });
  }
  return entries;
};

/** Turn a catalog entry into the editor-facing model record served by `GET /agents/agy/v1/models`. */
export const toAgyModel = (entry: AgyModelEntry, supportsTools: boolean): AgyModel => {
  const spec = specFor(entry.id);
  return {
    id: entry.id,
    label: `${entry.label} (agy)`,
    description: 'Antigravity CLI — runs on your Antigravity subscription, no metered key.',
    capabilities: {
      supportsTools,
      // agy's print mode takes text only: there is no flag for handing it an image.
      supportsImages: false,
      supportsSystemPrompt: true,
      maxOutputTokens: spec.maxOutputTokens,
      contextWindow: spec.contextWindow,
      ...(entry.efforts.length > 0 ? { reasoningEfforts: entry.efforts } : {}),
    },
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  };
};

/** Quota / rate-limit signatures in agy's output, adapted from open-design's `runtimes/auth.ts`. */
const QUOTA_PATTERN = /RESOURCE_EXHAUSTED|Individual quota reached|quota exceeded|\b429\b/i;
/** Auth signatures. Deliberately narrow: an unrecognized failure is `unknown`, never `missing`. */
const AUTH_PATTERN = /not (?:authenticated|logged in)|UNAUTHENTICATED|401|login required|please (?:log|sign) in/i;

export const looksLikeQuota = (text: string): boolean => QUOTA_PATTERN.test(text);
export const looksLikeAuth = (text: string): boolean => AUTH_PATTERN.test(text);

/** Is the shim registered in agy's MCP config, and pointing at the shim we ship? */
export const readMcpRegistration = (): { registered: boolean; command?: string } => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(mcpConfigPath(), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { registered: false };
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== 'object' || servers === null) return { registered: false };
    const entry = (servers as Record<string, unknown>)[AGY_MCP_SERVER_NAME];
    if (typeof entry !== 'object' || entry === null) return { registered: false };
    const record = entry as { command?: unknown; args?: unknown; disabled?: unknown };
    if (record.disabled === true) return { registered: false };
    const args = Array.isArray(record.args) ? record.args.map(String) : [];
    const command = [String(record.command ?? ''), ...args].join(' ');
    const expected = agyShimPath();
    const registered = args.some(arg => path.normalize(arg) === path.normalize(expected));
    return { registered, command };
  } catch {
    return { registered: false };
  }
};

/**
 * Full detection sweep. Never throws: an agent that cannot be probed is reported unavailable with a
 * diagnostic, because discovery serves every other lane in the same response.
 */
export const detectAgy = async (config: AgyConfig): Promise<AgyStatus> => {
  const diagnostics: AgyDiagnostic[] = [];
  if (process.env.PIX3_AGY_DISABLED === '1') {
    // Kill switch for CI and for anyone who does not want the bridge probing a CLI at all: the
    // detection spawns a real process, which is exactly what a hermetic test must not do.
    return {
      available: false,
      auth: 'unknown',
      mcp: 'missing',
      toolsEnabled: false,
      diagnostics: [
        {
          reason: 'disabled',
          severity: 'warning',
          message: 'The Antigravity lane is disabled (PIX3_AGY_DISABLED=1).',
        },
      ],
    };
  }
  const unavailable = (extra: AgyDiagnostic): AgyStatus => ({
    available: false,
    auth: 'unknown',
    mcp: 'missing',
    toolsEnabled: false,
    diagnostics: [...diagnostics, extra],
  });

  let binary: string | null;
  try {
    binary = resolveExecutable('agy', {
      override: config.bin ?? process.env.PIX3_AGY_BIN,
      wellKnownDirs: WELL_KNOWN_DIRS(),
    });
  } catch (error) {
    return unavailable({
      reason: 'resolve-failed',
      severity: 'error',
      message: 'Could not search for the agy executable.',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (!binary) {
    return unavailable({
      reason: 'not-installed',
      severity: 'error',
      message: 'The Antigravity CLI (agy) was not found on PATH or in its usual install directory.',
      detail: 'Install it, or point the bridge at it with PIX3_AGY_BIN=/path/to/agy.',
    });
  }

  // The version probe gates everything else: if the binary will not even report a version, running
  // a model turn through it is not going to go better.
  const version = await probeExecutable(binary, ['--version'], { timeoutMs: 15_000 });
  if (!version.ok) {
    return unavailable({
      reason: 'version-probe-failed',
      severity: 'error',
      message: version.timedOut
        ? 'agy did not answer `--version` in time.'
        : 'agy could not be started.',
      detail: (version.stderr || version.stdout).trim().slice(0, 400),
    });
  }
  const versionText = (version.stdout || version.stderr).trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (versionText && !SUPPORTED_VERSION.test(versionText)) {
    diagnostics.push({
      reason: 'untested-version',
      severity: 'warning',
      message: `agy ${versionText} has not been verified with this bridge.`,
      detail: 'The stream-json schema may have changed; unknown events are logged and ignored.',
    });
  }

  // Cheap pre-check before spending a network round trip on the auth probe.
  const hasCreds = fs.existsSync(oauthCredsPath());
  const models = await probeExecutable(binary, ['models'], { timeoutMs: 45_000 });
  const modelsText = `${models.stdout}\n${models.stderr}`;
  let auth: AgyAuthStatus;
  if (models.ok && modelsText.includes('\t')) {
    auth = 'ok';
  } else if (looksLikeAuth(modelsText) || (!hasCreds && !models.ok)) {
    auth = 'missing';
  } else {
    auth = 'unknown';
  }

  if (auth === 'missing') {
    diagnostics.push({
      reason: 'not-authenticated',
      severity: 'error',
      message: 'agy is installed but not signed in.',
      detail: 'Run `agy` once in a terminal and complete the Google sign-in, then reload the editor.',
    });
  } else if (auth === 'unknown') {
    diagnostics.push({
      reason: 'auth-probe-inconclusive',
      severity: 'warning',
      message: 'Could not confirm that agy is signed in.',
      detail: looksLikeQuota(modelsText)
        ? 'Its model list came back with a quota error — the subscription may be exhausted for now.'
        : (modelsText.trim().slice(0, 400) || 'The `agy models` probe produced no usable output.'),
    });
  }

  const mcp = readMcpRegistration();
  if (!mcp.registered) {
    diagnostics.push({
      reason: 'mcp-not-registered',
      severity: 'warning',
      message: 'Editor tools are unavailable: the pix3 MCP shim is not registered with agy.',
      detail: 'Run `pix3-agent-bridge agy setup` to register it.',
    });
  } else if (!config.skipPermissions) {
    diagnostics.push({
      reason: 'tool-permissions-off',
      severity: 'warning',
      message: 'Editor tools are unavailable: agy auto-denies MCP calls in print mode.',
      detail:
        'Letting them through needs agy\'s --dangerously-skip-permissions, which also un-gates its ' +
        'own shell/file/browser tools on this machine. Enable deliberately with ' +
        '`pix3-agent-bridge agy setup --allow-tools`.',
    });
  }

  return {
    available: true,
    path: binary,
    ...(versionText ? { version: versionText } : {}),
    auth,
    mcp: mcp.registered ? 'registered' : 'missing',
    toolsEnabled: mcp.registered && config.skipPermissions === true,
    diagnostics,
  };
};

/**
 * Live model catalog, cached per bridge process. `agy models` costs a network round trip, and the
 * editor re-probes on every settings panel open, so a short TTL keeps that from becoming a stampede.
 */
export class AgyModelCatalog {
  private entries: AgyModelEntry[] | null = null;
  private fetchedAt = 0;
  private inFlight: Promise<AgyModelEntry[]> | null = null;

  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number = 5 * 60_000, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async list(binary: string | undefined): Promise<AgyModelEntry[]> {
    if (this.entries && this.now() - this.fetchedAt < this.ttlMs) return this.entries;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh(binary).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(binary: string | undefined): Promise<AgyModelEntry[]> {
    if (!binary) return this.entries ?? [...FALLBACK_ENTRIES];
    const probe = await probeExecutable(binary, ['models'], { timeoutMs: 45_000 });
    const parsed = parseModelCatalog(probe.stdout);
    if (parsed.length === 0) {
      // Keep whatever we had rather than blanking the picker on one bad probe.
      return this.entries ?? [...FALLBACK_ENTRIES];
    }
    this.entries = parsed;
    this.fetchedAt = this.now();
    return parsed;
  }
}
