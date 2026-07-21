/**
 * CLI for Pix3AgentBridge. Running the bridge with no subcommand starts the server (see index.ts);
 * the `provider` subcommands below manage the provider table in `~/.pix3/agent-bridge.json` — adding
 * a key, enabling/disabling, or removing a provider — without touching a running server (the editor
 * re-reads availability from `GET /v1/providers` on its next probe).
 *
 *   pix3-agent-bridge provider list
 *   pix3-agent-bridge provider add openai --key sk-...
 *   pix3-agent-bridge provider add anthropic --key sk-ant-...
 *   pix3-agent-bridge provider add opencode-zen --key ...
 *   pix3-agent-bridge provider add my-router --base-url https://openrouter.ai/api/v1 --key ... --kind openai
 *   pix3-agent-bridge provider enable|disable|remove <id>
 *   pix3-agent-bridge provider set-key <id> <key>
 */

import {
  PROVIDER_PRESETS,
  RESERVED_PROVIDER_IDS,
  configPath,
  loadConfig,
  saveConfig,
  type ProviderConfig,
} from './config.ts';

/** Parse `--flag value` / `--flag=value` pairs, returning [positional[], flags]. */
const parseArgs = (args: string[]): { positional: string[]; flags: Record<string, string> } => {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = args[i + 1] ?? '';
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
};

const maskKey = (key: string): string =>
  key.length <= 8 ? (key ? '••••' : '(none)') : `${key.slice(0, 4)}…${key.slice(-4)}`;

const printList = (providers: Record<string, ProviderConfig>): void => {
  const ids = Object.keys(providers);
  if (ids.length === 0) {
    console.log('No providers configured. Add one, e.g.:  pix3-agent-bridge provider add openai --key sk-...');
    console.log(`\nBuilt-in presets: ${Object.keys(PROVIDER_PRESETS).join(', ')}`);
    return;
  }
  console.log(`Providers (from ${configPath()}):\n`);
  for (const id of ids) {
    const p = providers[id];
    const state = p.enabled ? 'enabled' : 'disabled';
    const key = p.apiKey ? maskKey(p.apiKey) : '(no key — add one with `provider set-key`)';
    console.log(`  ${id}`);
    console.log(`    kind:    ${p.kind}`);
    console.log(`    label:   ${p.label}`);
    console.log(`    baseUrl: ${p.baseUrl}`);
    console.log(`    key:     ${key}`);
    console.log(`    status:  ${state}`);
    console.log('');
  }
};

const usage = (): void => {
  console.log(
    [
      'Usage:',
      '  pix3-agent-bridge                         start the bridge server',
      '  pix3-agent-bridge provider list',
      '  pix3-agent-bridge provider add <id> [--key <k>] [--base-url <url>] [--kind openai|anthropic] [--label <l>]',
      '  pix3-agent-bridge provider set-key <id> <key>',
      '  pix3-agent-bridge provider enable <id>',
      '  pix3-agent-bridge provider disable <id>',
      '  pix3-agent-bridge provider remove <id>',
      '',
      `Built-in presets (add with just --key): ${Object.keys(PROVIDER_PRESETS).join(', ')}`,
    ].join('\n')
  );
};

const addProvider = (
  config: ReturnType<typeof loadConfig>,
  id: string,
  flags: Record<string, string>
): void => {
  if ((RESERVED_PROVIDER_IDS as readonly string[]).includes(id)) {
    console.error(
      `Provider id "${id}" is reserved by the bridge and cannot be added. Pick a different id.`
    );
    process.exitCode = 1;
    return;
  }
  const preset = PROVIDER_PRESETS[id];
  const baseUrl = (flags['base-url'] ?? preset?.baseUrl ?? '').replace(/\/$/, '');
  if (!baseUrl) {
    console.error(
      `Provider "${id}" is not a built-in preset, so it needs an explicit --base-url ` +
        `(e.g. --base-url https://openrouter.ai/api/v1).`
    );
    process.exitCode = 1;
    return;
  }
  const kindFlag = flags.kind === 'anthropic' ? 'anthropic' : flags.kind === 'openai' ? 'openai' : undefined;
  const existing = config.providers[id];
  config.providers[id] = {
    kind: kindFlag ?? preset?.kind ?? existing?.kind ?? 'openai',
    label: flags.label ?? preset?.label ?? existing?.label ?? id,
    baseUrl,
    apiKey: flags.key ?? existing?.apiKey ?? '',
    enabled: true,
    builtin: preset?.builtin ?? existing?.builtin ?? false,
  };
  saveConfig(config);
  console.log(`Provider "${id}" added/updated and enabled.`);
  if (!config.providers[id].apiKey) {
    console.log('  Note: no API key set yet — add one with `provider set-key ' + id + ' <key>`.');
  }
};

/** Run a `provider …` subcommand. Returns true if it was handled (so the server should not start). */
export const runProviderCommand = (args: string[]): void => {
  const { positional, flags } = parseArgs(args);
  const [sub, id] = positional;
  const config = loadConfig();

  switch (sub) {
    case undefined:
    case 'list':
      printList(config.providers);
      return;
    case 'add':
      if (!id) {
        console.error('Usage: provider add <id> [--key <k>] [--base-url <url>] [--kind openai|anthropic]');
        process.exitCode = 1;
        return;
      }
      addProvider(config, id, flags);
      return;
    case 'set-key': {
      const key = positional[2];
      if (!id || !key) {
        console.error('Usage: provider set-key <id> <key>');
        process.exitCode = 1;
        return;
      }
      const provider = config.providers[id];
      if (!provider) {
        console.error(`No such provider "${id}". Add it first with \`provider add ${id}\`.`);
        process.exitCode = 1;
        return;
      }
      provider.apiKey = key;
      saveConfig(config);
      console.log(`Key updated for "${id}".`);
      return;
    }
    case 'enable':
    case 'disable': {
      const provider = id ? config.providers[id] : undefined;
      if (!provider) {
        console.error(`No such provider "${id ?? ''}".`);
        process.exitCode = 1;
        return;
      }
      provider.enabled = sub === 'enable';
      saveConfig(config);
      console.log(`Provider "${id}" ${provider.enabled ? 'enabled' : 'disabled'}.`);
      return;
    }
    case 'remove': {
      if (!id || !config.providers[id]) {
        console.error(`No such provider "${id ?? ''}".`);
        process.exitCode = 1;
        return;
      }
      delete config.providers[id];
      saveConfig(config);
      console.log(`Provider "${id}" removed.`);
      return;
    }
    default:
      console.error(`Unknown provider subcommand: ${sub}\n`);
      usage();
      process.exitCode = 1;
  }
};

export { usage };
