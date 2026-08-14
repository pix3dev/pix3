import { describe, expect, it, vi } from 'vitest';
import {
  BOT_DIRECTORY,
  BotSession,
  botFilePath,
  botNameFromPath,
  buildBotVerdict,
  DEFAULT_TAP_HOLD_FRAMES,
  describeAvailableBots,
  InMemoryBotStore,
  parseBotSpec,
  resolveBotPolicy,
  type BotActuatorChannel,
  type BotHit,
  type BotNodeView,
  type BotPolicy,
  type BotReport,
  type BotWorld,
  type Pix3TestBot,
} from '@/services/agent/game-bots';

// ---------------------------------------------------------------------------
// A fake world that records what was asked of it
// ---------------------------------------------------------------------------

interface FakeWorld extends BotWorld {
  calls: string[];
  refuse: Set<string>;
  nodes: BotNodeView[];
}

function makeWorld(
  channel: BotActuatorChannel = 'physical-input',
  over: Partial<BotWorld> = {}
): FakeWorld {
  const calls: string[] = [];
  const refuse = new Set<string>();
  const nodes: BotNodeView[] = [];
  const gate = (call: string): string | null => {
    if (refuse.has(call)) return `refused: ${call}`;
    calls.push(call);
    return null;
  };
  return {
    calls,
    refuse,
    nodes,
    channel,
    findNodes: query => nodes.filter(node => node.name === query || node.type === query),
    nearestOfType: () => null,
    raycast: () => null,
    gameState: () => null,
    pressAction: action => gate(`press:${action}`),
    releaseAction: action => gate(`release:${action}`),
    tapDown: target => gate(`tapDown:${target}`),
    tapUp: target => {
      calls.push(`tapUp:${target}`);
    },
    setAxisValue: (name, value) => gate(`axis:${name}=${value}`),
    pointAt: point => gate(`pointAt:${point.x},${point.y}`),
    releaseAll: () => {
      calls.push('releaseAll');
    },
    ...over,
  };
}

function policyOf(tick: (bot: Pix3TestBot) => void, over: Partial<BotPolicy> = {}): BotPolicy {
  return { tick, ...over };
}

/** Tick a session `count` times, as the runner's frame hook would. */
function run(session: BotSession, count: number): void {
  for (let i = 0; i < count; i += 1) session.tick();
}

// ---------------------------------------------------------------------------

describe('bot paths', () => {
  it('resolves a bare name and a full path to the same file', () => {
    expect(botFilePath('dodge')).toBe(`${BOT_DIRECTORY}/dodge.ts`);
    expect(botFilePath('dodge.ts')).toBe(`${BOT_DIRECTORY}/dodge.ts`);
    expect(botFilePath(`${BOT_DIRECTORY}/dodge.ts`)).toBe(`${BOT_DIRECTORY}/dodge.ts`);
    expect(botNameFromPath(`${BOT_DIRECTORY}/dodge.ts`)).toBe('dodge');
  });

  it('lists what exists, so a missing policy is answered with the alternatives', async () => {
    const store = new InMemoryBotStore();
    expect(describeAvailableBots(await store.list())).toContain('No policies are stored');
    store.put('dodge', 'export default { tick() {} }');
    store.put('chase', 'export default { tick() {} }');
    expect(describeAvailableBots(await store.list())).toBe('Stored policies: chase, dodge.');
    expect((await store.load('dodge'))?.path).toBe(`${BOT_DIRECTORY}/dodge.ts`);
    expect(await store.load('missing')).toBeNull();
  });
});

describe('resolveBotPolicy', () => {
  it('accepts default, policy and bot as the export name', () => {
    const tick = () => {};
    for (const namespace of [{ default: { tick } }, { policy: { tick } }, { bot: { tick } }]) {
      const resolved = resolveBotPolicy(namespace);
      expect('policy' in resolved && resolved.policy.tick).toBe(tick);
    }
  });

  it('refuses a module with no tick — the mistake whose symptom would be silence', () => {
    const resolved = resolveBotPolicy({ default: { name: 'x' } });
    expect('error' in resolved && resolved.error).toContain('no `tick(bot)` function');
  });

  it('refuses a policy whose lifecycle hook is not callable', () => {
    const resolved = resolveBotPolicy({ default: { tick: () => {}, start: 3 } });
    expect('error' in resolved && resolved.error).toContain('`start` is not a function');
  });

  it('refuses a module that exported nothing of the shape', () => {
    expect('error' in resolveBotPolicy({})).toBe(true);
    expect('error' in resolveBotPolicy(null)).toBe(true);
  });
});

describe('parseBotSpec', () => {
  it('defaults the channel to physical-input — the rung that proves the most', () => {
    const parsed = parseBotSpec({ name: 'dodge' });
    expect('spec' in parsed && parsed.spec).toEqual({ name: 'dodge', channel: 'physical-input' });
  });

  it('accepts the bare name as a string', () => {
    const parsed = parseBotSpec('dodge');
    expect('spec' in parsed && parsed.spec.name).toBe('dodge');
  });

  it('takes direct-action when it is asked for explicitly', () => {
    const parsed = parseBotSpec({ name: 'dodge', channel: 'direct-action' });
    expect('spec' in parsed && parsed.spec.channel).toBe('direct-action');
  });

  it('refuses an unknown channel rather than falling back to the default', () => {
    const parsed = parseBotSpec({ name: 'dodge', channel: 'direct' });
    expect('error' in parsed && parsed.error).toContain('physical-input');
    expect('error' in parsed && parsed.error).toContain('direct-action');
  });

  it('refuses unknown fields — a policy takes no arguments', () => {
    const parsed = parseBotSpec({ name: 'dodge', args: { speed: 2 } });
    expect('error' in parsed && parsed.error).toContain('"args"');
  });

  it('needs a name', () => {
    expect('error' in parseBotSpec({ channel: 'direct-action' })).toBe(true);
    expect('error' in parseBotSpec({ name: '   ' })).toBe(true);
  });
});

describe('BotSession lifecycle', () => {
  it('runs start once before the first tick and counts frames from 1', () => {
    const seen: number[] = [];
    const start = vi.fn((bot: Pix3TestBot) => seen.push(bot.frame));
    const session = new BotSession(
      'p',
      policyOf(bot => seen.push(bot.frame), { start }),
      makeWorld()
    );
    run(session, 3);
    expect(start).toHaveBeenCalledTimes(1);
    // start sees frame 1 (it runs inside the first tick), then the three ticks.
    expect(seen).toEqual([1, 1, 2, 3]);
    expect(session.report().frames).toBe(3);
  });

  it('stops ticking the policy once it called done, and reports the verdict frame', () => {
    let ticks = 0;
    const session = new BotSession(
      'p',
      policyOf(bot => {
        ticks += 1;
        bot.press('Key_Space');
        if (bot.frame === 2) bot.done(false, 'hero died');
      }),
      makeWorld()
    );
    run(session, 6);
    expect(ticks).toBe(2);
    expect(session.finished).toBe(true);
    expect(session.outcome).toEqual({ pass: false, reason: 'hero died', frame: 2 });
    expect(session.report().done?.reason).toBe('hero died');
  });

  it('keeps the FIRST verdict and notes the second', () => {
    const session = new BotSession(
      'p',
      policyOf(bot => {
        bot.done(true, 'first');
        bot.done(false, 'second');
      }),
      makeWorld()
    );
    session.tick();
    expect(session.outcome?.reason).toBe('first');
    const messages = session.report().log.map(entry => entry.message);
    expect(messages.some(message => message.includes('done() was called again'))).toBe(true);
  });

  it('ignores a verdict from end(): by then the run has already ended', () => {
    const session = new BotSession(
      'p',
      policyOf(() => {}, { end: bot => bot.done(true, 'too late') }),
      makeWorld()
    );
    session.tick();
    session.dispose();
    expect(session.report().done).toBeUndefined();
    expect(
      session
        .report()
        .log.map(entry => entry.message)
        .join(' ')
    ).toContain('called from end()');
  });

  it('runs end and releases everything on dispose, even after a crash', () => {
    const world = makeWorld();
    const end = vi.fn();
    const session = new BotSession(
      'p',
      policyOf(
        () => {
          throw new Error('boom');
        },
        { end }
      ),
      world
    );
    session.tick();
    session.dispose();
    expect(end).toHaveBeenCalledTimes(1);
    expect(world.calls).toContain('releaseAll');
  });
});

describe('BotSession isolation', () => {
  it('reports the first throw on its own channel and ends the policy', () => {
    const onError = vi.fn();
    let ticks = 0;
    const session = new BotSession(
      'p',
      policyOf(() => {
        ticks += 1;
        throw new Error('bad policy');
      }),
      makeWorld(),
      onError
    );
    run(session, 5);
    expect(ticks).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(session.crash?.message).toContain('bad policy');
    expect(session.outcome).toBeNull();
    expect(session.report().error?.frame).toBe(1);
  });

  it('never lets a throw escape into the caller — the runner ticks this', () => {
    const session = new BotSession(
      'p',
      policyOf(() => {
        throw new Error('boom');
      }),
      makeWorld()
    );
    expect(() => session.tick()).not.toThrow();
    expect(() => session.dispose()).not.toThrow();
  });

  it('answers the empty reading when a sensor throws, and says so once', () => {
    const world = makeWorld('physical-input', {
      findNodes: () => {
        throw new Error('scene gone');
      },
    });
    let seen: BotNodeView[] | null = null;
    const session = new BotSession(
      'p',
      policyOf(bot => (seen = bot.nodes('Hero'))),
      world
    );
    session.tick();
    expect(seen).toEqual([]);
    expect(session.crash).toBeNull();
    expect(
      session
        .report()
        .log.map(entry => entry.message)
        .join(' ')
    ).toContain('a sensor failed');
  });
});

describe('BotSession actuators', () => {
  it('holds a press until release, and releases everything on dispose', () => {
    const world = makeWorld();
    const session = new BotSession(
      'p',
      policyOf(bot => {
        if (bot.frame === 1) bot.press('Key_ArrowLeft');
        if (bot.frame === 4) bot.release('Key_ArrowLeft');
      }),
      world
    );
    run(session, 5);
    expect(world.calls).toEqual(['press:Key_ArrowLeft', 'release:Key_ArrowLeft']);
    expect(session.report().sent).toBe(1);
  });

  it('auto-releases a press with a frame budget', () => {
    const world = makeWorld();
    const session = new BotSession(
      'p',
      policyOf(bot => {
        if (bot.frame === 1) bot.press('Key_Space', 2);
      }),
      world
    );
    run(session, 5);
    expect(world.calls).toEqual(['press:Key_Space', 'release:Key_Space']);
  });

  it('re-pressing a held action extends its lease instead of pressing twice', () => {
    const world = makeWorld();
    const session = new BotSession(
      'p',
      policyOf(bot => bot.press('Key_Space', 2)),
      world
    );
    run(session, 4);
    expect(world.calls.filter(call => call === 'press:Key_Space')).toHaveLength(1);
    // Still held: every tick pushed the release out by two more frames.
    expect(world.calls).not.toContain('release:Key_Space');
  });

  it('taps down now and up after the control has had frames to notice', () => {
    const world = makeWorld();
    const session = new BotSession(
      'p',
      policyOf(bot => {
        if (bot.frame === 1) bot.tap('PlayButton');
      }),
      world
    );
    run(session, DEFAULT_TAP_HOLD_FRAMES + 2);
    expect(world.calls).toEqual(['tapDown:PlayButton', 'tapUp:PlayButton']);
    expect(world.calls.indexOf('tapUp:PlayButton')).toBeGreaterThan(0);
  });

  it('clamps an axis to -1..1 and refuses a non-finite one', () => {
    const world = makeWorld();
    const session = new BotSession(
      'p',
      policyOf(bot => {
        if (bot.frame === 1) bot.axis('Horizontal', -4);
        if (bot.frame === 2) bot.axis('Horizontal', Number.NaN);
      }),
      world
    );
    run(session, 2);
    expect(world.calls).toEqual(['axis:Horizontal=-1']);
    expect(session.report().refused).toBe(1);
  });

  it('counts a refusal, logs its reason, and never throws', () => {
    const world = makeWorld();
    world.refuse.add('tapDown:Ghost');
    const session = new BotSession(
      'p',
      policyOf(bot => bot.tap('Ghost')),
      world
    );
    expect(() => session.tick()).not.toThrow();
    const report = session.report();
    expect(report.sent).toBe(0);
    expect(report.refused).toBe(1);
    expect(report.log.some(entry => entry.kind === 'refused')).toBe(true);
    expect(report.notes.join(' ')).toContain('was refused');
  });

  it('refuses an empty target instead of asking the world about it', () => {
    const world = makeWorld();
    const session = new BotSession(
      'p',
      policyOf(bot => {
        bot.tap('');
        bot.press('  ');
        bot.axis('', 1);
      }),
      world
    );
    session.tick();
    expect(world.calls).toEqual([]);
    expect(session.report().refused).toBe(3);
  });

  it('releasing something that was never held is a no-op, not a refusal', () => {
    const world = makeWorld();
    const session = new BotSession(
      'p',
      policyOf(bot => bot.release('Key_Space')),
      world
    );
    session.tick();
    expect(world.calls).toEqual([]);
    expect(session.report().refused).toBe(0);
  });
});

describe('BotSession report', () => {
  it('always states that a direct-action run proves no binding', () => {
    const session = new BotSession(
      'p',
      policyOf(() => {}),
      makeWorld('direct-action')
    );
    session.tick();
    expect(session.report().notes.join(' ')).toContain('proves NOTHING about');
    expect(session.report().channel).toBe('direct-action');
  });

  it('says nothing of the kind on physical-input', () => {
    const session = new BotSession(
      'p',
      policyOf(() => {}),
      makeWorld()
    );
    session.tick();
    expect(session.report().notes.join(' ')).not.toContain('proves NOTHING');
  });

  it('carries the policy label only when it differs from the file name', () => {
    const labelled = new BotSession(
      'dodge',
      policyOf(() => {}, { name: 'Dodge and survive' }),
      makeWorld()
    );
    expect(labelled.report().label).toBe('Dodge and survive');
    const same = new BotSession(
      'dodge',
      policyOf(() => {}, { name: 'dodge' }),
      makeWorld()
    );
    expect(same.report().label).toBeUndefined();
  });

  it('keeps a head and a tail of the log, and the full log separately', () => {
    const session = new BotSession(
      'p',
      policyOf(bot => bot.log(`tick ${bot.frame}`)),
      makeWorld()
    );
    run(session, 200);
    const report = session.report();
    expect(report.log).toHaveLength(60);
    expect(report.log[0].message).toBe('tick 1');
    expect(report.log[report.log.length - 1].message).toBe('tick 200');
    expect(session.fullLog()).toHaveLength(200);
    expect(report.notes.join(' ')).toContain('not in this reply');
  });
});

describe('buildBotVerdict', () => {
  const base: BotReport = {
    name: 'dodge',
    channel: 'physical-input',
    frames: 100,
    sent: 12,
    refused: 0,
    log: [],
    notes: [],
  };

  it('names the reason, the frame and the channel on a pass', () => {
    const verdict = buildBotVerdict(
      { ...base, done: { pass: true, reason: 'survived 30s', frame: 90 } },
      0
    );
    expect(verdict).toContain('BOT PASS dodge [physical-input]');
    expect(verdict).toContain('frame 90');
    expect(verdict).toContain('survived 30s');
  });

  it('says a fail is a fail', () => {
    const verdict = buildBotVerdict(
      { ...base, done: { pass: false, reason: 'hero died: lives 0', frame: 517 } },
      0
    );
    expect(verdict).toContain('BOT FAIL');
    expect(verdict).toContain('hero died: lives 0');
  });

  it('blames the policy file, not the game, when the policy threw', () => {
    const verdict = buildBotVerdict(
      { ...base, error: { message: 'TypeError: x is undefined', frame: 4 } },
      0
    );
    expect(verdict).toContain('BOT ERROR');
    expect(verdict).toContain('NOT in the game');
    expect(verdict).toContain('design/tests/bots/dodge.ts');
  });

  it('refuses to read as a pass when nothing was driven', () => {
    const verdict = buildBotVerdict(
      {
        ...base,
        sent: 0,
        refused: 3,
        done: { pass: true, reason: 'looked fine', frame: 10 },
      },
      0
    );
    expect(verdict).toContain('BOT NOTHING DRIVEN');
    expect(verdict).toContain('a game it did not play');
    expect(verdict).not.toContain('BOT PASS');
  });

  it('marks a direct-action pass as proving no binding, and counts new errors', () => {
    const verdict = buildBotVerdict(
      {
        ...base,
        channel: 'direct-action',
        done: { pass: true, reason: 'done', frame: 5 },
      },
      2
    );
    expect(verdict).toContain('no input binding is proven');
    expect(verdict).toContain('2 NEW RUNTIME ERROR(S)');
  });

  it('says the policy reached no verdict of its own when it did not', () => {
    expect(buildBotVerdict(base, 0)).toContain('BOT UNDECIDED');
  });
});

describe('sensors are handed through unchanged', () => {
  it('passes the world origin when nearest() is called without a from', () => {
    const seen: Array<{ x: number; y: number; z?: number }> = [];
    const world = makeWorld('physical-input', {
      nearestOfType: (_type, from): BotHit | null => {
        seen.push(from);
        return null;
      },
    });
    const session = new BotSession(
      'p',
      policyOf(bot => bot.nearest('Rock2D')),
      world
    );
    session.tick();
    expect(seen).toEqual([{ x: 0, y: 0, z: 0 }]);
  });
});
