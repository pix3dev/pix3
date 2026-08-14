import { describe, expect, it, vi } from 'vitest';
import { BOT_DTS_PATH, GameBotHost, type BotDeclarationWriter } from '@/services/agent/GameBotHost';
import { BOT_DIRECTORY, InMemoryBotStore } from '@/services/agent/game-bots';
import { PIX3_TEST_BOT_DTS } from '@/services/agent/pix3-test-bot-dts';

/**
 * The host's job is to answer every failure with something the agent can fix in one
 * edit. The success path ends in a blob-URL dynamic import, which does not exist in
 * this environment — so what is checked here is everything up to it plus **what the
 * compiler was handed**, which is where the two decisions that could silently go wrong
 * live: the fixed entry module, and keeping the generated `.d.ts` out of the bundle.
 */

interface FakeCompilerBehaviour {
  /** What `bundleVirtualProject` does: return code, return nothing, or throw. */
  code?: string;
  throws?: unknown;
}

function buildHost(
  store: InMemoryBotStore,
  behaviour: FakeCompilerBehaviour = {},
  writer?: BotDeclarationWriter
): {
  host: GameBotHost;
  bundles: Array<{ files: Map<string, string>; options: { entryFiles?: readonly string[] } }>;
} {
  const bundles: Array<{
    files: Map<string, string>;
    options: { entryFiles?: readonly string[] };
  }> = [];
  const host = new GameBotHost();
  Object.defineProperty(host, 'compiler', {
    value: {
      bundleVirtualProject: vi.fn(
        async (files: Map<string, string>, options: { entryFiles?: readonly string[] }) => {
          bundles.push({ files: new Map(files), options });
          if (behaviour.throws !== undefined) throw behaviour.throws;
          return { code: behaviour.code ?? '', warnings: [] };
        }
      ),
    },
    configurable: true,
  });
  host.setStore(store);
  if (writer) host.setDeclarationWriter(writer);
  return { host, bundles };
}

const storeWith = (entries: Record<string, string>): InMemoryBotStore => {
  const store = new InMemoryBotStore();
  for (const [name, source] of Object.entries(entries)) store.put(name, source);
  return store;
};

describe('GameBotHost.load — refusals', () => {
  it('needs a name', async () => {
    const { host } = buildHost(new InMemoryBotStore());
    const result = await host.load('   ');
    expect('error' in result && result.error).toContain('must name a stored policy');
  });

  it('answers a missing policy with the ones that exist', async () => {
    const { host } = buildHost(storeWith({ dodge: 'export default {tick(){}}' }));
    const result = await host.load('chase');
    expect('error' in result && result.error).toContain(`${BOT_DIRECTORY}/chase.ts`);
    expect('error' in result && result.error).toContain('Stored policies: dodge');
    expect('error' in result && result.error).toContain('fs_write');
  });

  it('reports a compile error with the file and line the compiler named', async () => {
    const { host } = buildHost(storeWith({ dodge: 'export default {' }), {
      throws: {
        message: 'Unexpected end of file',
        file: 'design/tests/bots/dodge.ts',
        line: 1,
        column: 16,
      },
    });
    const result = await host.load('dodge');
    expect('error' in result && result.error).toContain('does not compile');
    expect('error' in result && result.error).toContain('dodge.ts:1:16');
  });

  it('reports an empty file as empty rather than as a bad shape', async () => {
    const { host } = buildHost(storeWith({ dodge: '' }), { code: '   ' });
    const result = await host.load('dodge');
    expect('error' in result && result.error).toContain('compiled to nothing');
  });

  it('surfaces a store failure as a read failure, not as a missing policy', async () => {
    const store = new InMemoryBotStore();
    vi.spyOn(store, 'list').mockRejectedValueOnce(new Error('permission denied'));
    const { host } = buildHost(store);
    const result = await host.load('dodge');
    expect('error' in result && result.error).toContain('Could not read');
  });
});

describe('GameBotHost.load — what the compiler is handed', () => {
  it('adds a fixed entry module and compiles only it', async () => {
    const { host, bundles } = buildHost(storeWith({ dodge: 'export default {tick(){}}' }), {
      code: 'export const __bot_entry__ = {};',
    });
    await host.load('dodge');

    expect(bundles).toHaveLength(1);
    const { files, options } = bundles[0];
    expect(options.entryFiles).toEqual(['__bot_entry__.ts']);
    const entry = files.get('__bot_entry__.ts') ?? '';
    // A namespace re-export, not `export { default }`: a policy may export its object
    // as `policy` or `bot`, and `export { default } from` would be a compile error
    // against those files rather than a refusal the agent can read.
    expect(entry).toContain(`from './${BOT_DIRECTORY}/dodge'`);
    expect(entry).toContain('import * as policyModule');
    expect(entry).not.toContain('export { default }');
  });

  it('hands over the sibling policies too, so a shared helper can be imported', async () => {
    const { host, bundles } = buildHost(
      storeWith({
        dodge: "import { hero } from './helpers'; export default {tick(){ hero(); }}",
        helpers: 'export const hero = () => null;',
      }),
      { code: 'export const __bot_entry__ = {};' }
    );
    await host.load('dodge');

    const files = bundles[0].files;
    expect(files.has(`${BOT_DIRECTORY}/dodge.ts`)).toBe(true);
    expect(files.has(`${BOT_DIRECTORY}/helpers.ts`)).toBe(true);
  });

  it('never bundles the generated declaration file', async () => {
    const store = storeWith({ dodge: 'export default {tick(){}}' });
    // The store filters `.d.ts` itself; this covers the host's own guard, which is what
    // protects a bundle when some other store does not.
    store.put('pix3-test-bot.d', PIX3_TEST_BOT_DTS);
    const { host, bundles } = buildHost(store, { code: 'export const __bot_entry__ = {};' });
    await host.load('dodge');

    const paths = [...bundles[0].files.keys()];
    expect(paths.some(path => path.endsWith('.d.ts'))).toBe(false);
  });
});

describe('GameBotHost declarations', () => {
  const makeWriter = () => ({
    writeTextFile: vi.fn(async () => {}),
    createDirectory: vi.fn(async () => {}),
  });

  it('writes the declarations once, after a successful compile', async () => {
    const writer = makeWriter();
    const { host } = buildHost(
      storeWith({ dodge: 'export default {tick(){}}', chase: 'export default {tick(){}}' }),
      { code: 'export const __bot_entry__ = {};' },
      writer
    );

    await host.load('dodge');
    await host.load('chase');

    expect(writer.createDirectory).toHaveBeenCalledWith(BOT_DIRECTORY);
    expect(writer.writeTextFile).toHaveBeenCalledTimes(1);
    expect(writer.writeTextFile).toHaveBeenCalledWith(BOT_DTS_PATH, PIX3_TEST_BOT_DTS);
  });

  it('does not write them for a policy that failed to compile', async () => {
    const writer = makeWriter();
    const { host } = buildHost(
      storeWith({ dodge: 'export default {' }),
      { throws: { message: 'boom' } },
      writer
    );

    await host.load('dodge');

    expect(writer.writeTextFile).not.toHaveBeenCalled();
  });

  it('is identity-guarded, so re-pointing it at the same project writes nothing new', async () => {
    const writer = makeWriter();
    const { host } = buildHost(
      storeWith({ dodge: 'export default {tick(){}}' }),
      { code: 'export const __bot_entry__ = {};' },
      writer
    );

    await host.load('dodge');
    // The tool layer re-points this on every call; without the guard the flag would
    // reset and the file would be rewritten on every single bot run.
    host.setDeclarationWriter(writer);
    await host.load('dodge');

    expect(writer.writeTextFile).toHaveBeenCalledTimes(1);
  });

  it('never lets a failed write refuse a runnable policy', async () => {
    const writer = makeWriter();
    writer.writeTextFile.mockRejectedValue(new Error('read-only project'));
    const { host } = buildHost(
      storeWith({ dodge: 'export default {tick(){}}' }),
      { code: 'export const __bot_entry__ = {};' },
      writer
    );

    // The blob import fails in this environment, so the result is an error either way —
    // what matters is that it is the IMPORT's error and not the declaration write's.
    const result = await host.load('dodge');
    expect('error' in result && result.error).not.toContain('read-only project');
  });

  it('writes nothing at all with no project open', async () => {
    const { host } = buildHost(storeWith({ dodge: 'export default {tick(){}}' }), {
      code: 'export const __bot_entry__ = {};',
    });
    host.setDeclarationWriter(null);
    await expect(host.load('dodge')).resolves.toBeDefined();
  });
});
