/** Codex CLI discovery and the single model entry exposed by this bridge. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { probeExecutable, resolveExecutable } from './executables.ts';

export const CODEX_AGENT_ID = 'codex';
export const CODEX_LABEL = 'Codex CLI';

export interface CodexStatus {
  readonly available: boolean;
  readonly path?: string;
  readonly version?: string;
  readonly auth: 'ok' | 'missing' | 'unknown';
  readonly mcp: 'registered' | 'missing';
  readonly toolsEnabled: boolean;
  readonly diagnostics: Array<{ reason: string; severity: 'error' | 'warning'; message: string; detail?: string }>;
}

/** npm's Windows launcher is a .cmd script; spawn the package's native executable directly. */
export const nativeCodexPath = (candidate: string): string => {
  if (!/\.(?:cmd|ps1)$/i.test(candidate)) return candidate;
  const root = path.dirname(candidate);
  if (process.platform === 'win32') {
    const pkg = `codex-win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
    const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    for (const packageRoot of [
      path.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', pkg),
      path.join(root, 'node_modules', '@openai', pkg),
    ]) {
      for (const tail of [path.join('vendor', triple, 'bin', 'codex.exe'),
        path.join('vendor', triple, 'codex', 'codex.exe')]) {
        const executable = path.join(packageRoot, tail);
        if (fs.existsSync(executable)) return executable;
      }
    }
  }
  return candidate;
};

export const detectCodex = async (): Promise<CodexStatus> => {
  if (process.env.PIX3_CODEX_DISABLED === '1') {
    return { available: false, auth: 'unknown', mcp: 'missing', toolsEnabled: false,
      diagnostics: [{ reason: 'disabled', severity: 'warning', message: 'Codex lane disabled by PIX3_CODEX_DISABLED=1.' }] };
  }
  const found = resolveExecutable('codex', {
    override: process.env.PIX3_CODEX_BIN,
    wellKnownDirs: [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'],
  });
  if (!found) {
    return { available: false, auth: 'unknown', mcp: 'missing', toolsEnabled: false,
      diagnostics: [{ reason: 'not-installed', severity: 'error', message: 'Codex CLI was not found.',
        detail: 'Install @openai/codex or set PIX3_CODEX_BIN to the executable path.' }] };
  }
  const binary = nativeCodexPath(found);
  const probe = await probeExecutable(binary, ['--version'], { timeoutMs: 15_000 });
  if (!probe.ok) {
    return { available: false, auth: 'unknown', mcp: 'missing', toolsEnabled: false,
      diagnostics: [{ reason: 'version-probe-failed', severity: 'error', message: 'Codex CLI could not start.',
        detail: (probe.stderr || probe.stdout).trim().slice(0, 400) }] };
  }
  const help = await probeExecutable(binary, ['exec', '--help'], { timeoutMs: 15_000 });
  if (!help.ok || !help.stdout.includes('--ignore-user-config')) {
    return { available: false, path: binary, version: probe.stdout.trim(), auth: 'unknown',
      mcp: 'missing', toolsEnabled: false, diagnostics: [{ reason: 'outdated-cli', severity: 'error',
        message: 'Codex CLI is too old for the Pix3 bridge.',
        detail: 'Update @openai/codex to the latest release and restart the bridge.' }] };
  }
  const login = await probeExecutable(binary, ['login', 'status'], { timeoutMs: 15_000 });
  const auth = login.ok ? 'ok' : /not logged|not signed|login required/i.test(login.stdout + login.stderr)
    ? 'missing' : 'unknown';
  const toolsEnabled = process.env.PIX3_CODEX_ALLOW_TOOLS === '1';
  return { available: true, path: binary, version: probe.stdout.trim().split(/\r?\n/)[0],
    auth, mcp: toolsEnabled ? 'registered' : 'missing', toolsEnabled,
    diagnostics: [
      ...(!toolsEnabled ? [{ reason: 'tools-disabled', severity: 'warning' as const,
        message: 'Codex editor tools are disabled.',
        detail: 'Set PIX3_CODEX_ALLOW_TOOLS=1 and restart the bridge to enable them. This uses Codex full-access mode.' }] : []),
      ...(auth === 'missing' ? [{ reason: 'not-authenticated', severity: 'error' as const,
        message: 'Codex CLI is not signed in.', detail: 'Run `codex login`.' }] : []),
    ] };
};

const model = (id: string, label: string, description: string, toolsEnabled: boolean) => ({
  id, label, description,
  capabilities: {
    supportsTools: toolsEnabled,
    supportsImages: false,
    supportsSystemPrompt: true,
    maxOutputTokens: 32_000,
    contextWindow: 200_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  pricing: { inputPer1M: 0, outputPer1M: 0 },
});

export const codexModels = (toolsEnabled: boolean) => [
  model('gpt-5.6-sol', 'GPT-5.6 Sol (Codex)', 'Runs through your Codex CLI sign-in.', toolsEnabled),
  model('gpt-5.6-terra', 'GPT-5.6 Terra (Codex)', 'Runs through your Codex CLI sign-in.', toolsEnabled),
  model('gpt-5.6-luna', 'GPT-5.6 Luna (Codex)', 'Runs through your Codex CLI sign-in.', toolsEnabled),
];
