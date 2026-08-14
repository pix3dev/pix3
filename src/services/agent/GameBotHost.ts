/**
 * Turns a stored policy file into a live {@link BotPolicy} (§5.3, phase 8).
 *
 * This service owns exactly two things — **where policies come from** and **how a
 * TypeScript file becomes a callable object** — and deliberately nothing about how a
 * policy is driven. The driving is `BotSession` in `game-bots.ts` (pure, spec'd
 * against a fake world) and the live world is built in `GameTestService` next to the
 * monkey's and the routine's, because that is where the readers of the running scene
 * already live and a second spelling of "where is a node" is the drift this codebase
 * keeps paying for.
 *
 * ## Compilation reuses the editor's own compiler, on purpose
 *
 * `ScriptCompilerService` is what compiles the project's real scripts, with the same
 * externals (`@pix3/runtime`, `three`) resolved through the same import map. A policy
 * therefore has the same capabilities and the same failure messages as a game script,
 * and there is no second toolchain to keep in step. The whole
 * `design/tests/bots/` folder is handed to the bundler rather than the single entry
 * file, so a policy may import a sibling helper — which is what keeps three policies
 * that share a "where is the hero" routine from copying it three times.
 *
 * ## The type declarations are written, not documented
 *
 * On the first successful compile in a project, `design/tests/bots/pix3-test-bot.d.ts`
 * is written next to the policies. A policy is never type-checked (esbuild erases
 * types), so this file buys exactly one thing: completion on `bot.` in whatever
 * editor the file is open in. That is worth a file — a model that cannot see the
 * method list invents one.
 */

import { inject, injectable } from '@/fw/di';
import {
  botFilePath,
  BOT_DIRECTORY,
  describeAvailableBots,
  InMemoryBotStore,
  resolveBotPolicy,
  type BotPolicy,
  type BotStore,
  type StoredBot,
} from '@/services/agent/game-bots';
import { BOT_DTS_FILE_NAME, PIX3_TEST_BOT_DTS } from '@/services/agent/pix3-test-bot-dts';
import { ScriptCompilerService } from '@/services/scripting/ScriptCompilerService';

/**
 * Fixed name of the generated entry module.
 *
 * A fixed name is what makes the compiled namespace addressable: the compiler derives
 * an export name from the entry path (`__bot_entry__.ts` → `__bot_entry__`), and
 * re-deriving that transform from a policy's own path here would be a copy of a
 * private rule in another file.
 */
const ENTRY_FILE = '__bot_entry__.ts';
const ENTRY_EXPORT = '__bot_entry__';
/** The name the entry re-exports the policy's own namespace under. */
const NAMESPACE_EXPORT = 'policyModule';

/** Type-only files in the bots folder — compiled by nobody, listed as nothing. */
const DECLARATION_SUFFIX = '.d.ts';

export interface BotLoadFailure {
  error: string;
}

export interface BotLoaded {
  policy: BotPolicy;
  /** The file's bare name — how the run addresses it and how the report names it. */
  name: string;
  /** Compiler warnings, passed through so a policy that compiled oddly says so. */
  warnings: string[];
}

/** Where the d.ts is written, so the caller can say it happened. */
export const BOT_DTS_PATH = `${BOT_DIRECTORY}/${BOT_DTS_FILE_NAME}`;

/**
 * The narrow write seam. `ProjectStorageService` is the store's own dependency; the
 * host only ever writes the declaration file, so it asks for exactly that much and
 * a spec can pass a two-line fake.
 */
export interface BotDeclarationWriter {
  writeTextFile(path: string, contents: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
}

@injectable()
export class GameBotHost {
  @inject(ScriptCompilerService)
  private readonly compiler!: ScriptCompilerService;

  private store: BotStore = new InMemoryBotStore();
  private declarations: BotDeclarationWriter | null = null;
  /** Written once per project swap, not once per run — it is a constant file. */
  private declarationsWritten = false;

  /** Swap in the project-file store — same seam, same reason as traces and routines. */
  setStore(store: BotStore): void {
    this.store = store;
    this.declarationsWritten = false;
  }

  getStore(): BotStore {
    return this.store;
  }

  /**
   * Where the generated `.d.ts` goes. Cleared with `null` when no project is open,
   * in which case nothing is written and policies still compile — the declarations
   * are an authoring convenience, never a dependency of a run.
   */
  setDeclarationWriter(writer: BotDeclarationWriter | null): void {
    // Identity-guarded: the tool layer re-points this on every call (a project can be
    // opened or closed between two runs), and resetting the written flag each time
    // would rewrite the declaration file on every single bot run.
    if (this.declarations === writer) return;
    this.declarations = writer;
    this.declarationsWritten = false;
  }

  /**
   * Load, compile and instantiate one policy.
   *
   * Every failure is a sentence rather than a throw, because each of them is
   * something the agent can fix in one edit: a name that does not exist (answered
   * with what does), a file that does not compile (answered with the compiler's own
   * file/line), or a module that exported the wrong shape (answered with the shape
   * it should have exported).
   */
  async load(name: string): Promise<BotLoaded | BotLoadFailure> {
    const trimmed = name.trim();
    if (!trimmed) {
      return {
        error: `game_run \`bot.name\` must name a stored policy, e.g. {bot: {name: 'dodge'}} for ${BOT_DIRECTORY}/dodge.ts.`,
      };
    }

    let stored: StoredBot | null;
    let siblings: StoredBot[];
    try {
      [stored, siblings] = await Promise.all([this.store.load(trimmed), this.store.list()]);
    } catch (error) {
      return { error: `Could not read ${BOT_DIRECTORY}: ${describeError(error)}` };
    }
    if (!stored) {
      return {
        error: `No policy stored at ${botFilePath(trimmed)}. ${describeAvailableBots(siblings)} Write one with fs_write — it is a single file exporting {name, tick(bot)}.`,
      };
    }

    const compiled = await this.compile(stored, siblings);
    if ('error' in compiled) return compiled;

    const resolved = resolveBotPolicy(compiled.namespace);
    if ('error' in resolved) {
      return { error: `${stored.path}: ${resolved.error}` };
    }

    return { policy: resolved.policy, name: stored.name, warnings: compiled.warnings };
  }

  /**
   * Bundle the policy and evaluate it.
   *
   * The evaluation is the same blob-URL dynamic import the project script loader
   * uses, and for the same reason: it is the one way to get a real ES module — with
   * the editor's import map resolving `@pix3/runtime` and `three` — out of a string.
   * The URL is revoked immediately; the module object outlives it.
   */
  private async compile(
    stored: StoredBot,
    siblings: readonly StoredBot[]
  ): Promise<{ namespace: unknown; warnings: string[] } | BotLoadFailure> {
    const files = new Map<string, string>();
    for (const bot of siblings) {
      if (bot.path.endsWith(DECLARATION_SUFFIX)) continue;
      files.set(bot.path, bot.source);
    }
    files.set(stored.path, stored.source);
    files.set(ENTRY_FILE, buildEntryModule(stored.path));

    let code: string;
    let warnings: string[];
    try {
      const result = await this.compiler.bundleVirtualProject(files, {
        entryFiles: [ENTRY_FILE],
        entryStrategy: 're-export',
      });
      code = result.code;
      warnings = result.warnings;
    } catch (error) {
      return { error: `${stored.path} does not compile: ${describeCompilationError(error)}` };
    }
    if (!code.trim()) {
      return { error: `${stored.path} compiled to nothing — the file is empty.` };
    }

    // Written once the BUNDLE succeeded, and deliberately before the module is
    // evaluated. A file that bundles cleanly and then throws at top level is a real
    // policy with a real bug, and declarations are exactly what helps fix it; a file
    // that does not bundle at all is the one case where writing a file as a side
    // effect of a failed call would be a surprise.
    await this.ensureDeclarations();

    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    try {
      const module = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
      const entry = module[ENTRY_EXPORT] as Record<string, unknown> | undefined;
      return { namespace: entry?.[NAMESPACE_EXPORT] ?? entry ?? module, warnings };
    } catch (error) {
      // A throw here is the policy's own module body failing (a top-level statement
      // that references something absent), which is a different fix from a syntax
      // error and has to read differently.
      return {
        error: `${stored.path} failed while loading: ${describeError(error)}. This is the file's TOP-LEVEL code throwing, not its tick() — move work that needs the running game into start(bot) or tick(bot).`,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Write the ambient declarations next to the policies, at most once per project.
   *
   * Failures are swallowed: a read-only project, a revoked permission or a missing
   * directory must not turn a runnable policy into a refused run. The file gives
   * completion in an editor and nothing else depends on it.
   */
  private async ensureDeclarations(): Promise<void> {
    if (this.declarationsWritten || !this.declarations) return;
    this.declarationsWritten = true;
    try {
      await this.declarations.createDirectory(BOT_DIRECTORY);
    } catch {
      /* the write below is the one whose failure would matter, and it is swallowed too */
    }
    try {
      await this.declarations.writeTextFile(BOT_DTS_PATH, PIX3_TEST_BOT_DTS);
    } catch {
      /* authoring convenience only — never a precondition of a run */
    }
  }
}

/**
 * The generated entry: import the policy's module namespace and re-export it whole.
 *
 * A **namespace**, not `export { default }`: a policy may export its object as
 * `default`, `policy` or `bot`, and `export { default } from` is a hard compile error
 * against a file that chose one of the other two. Re-exporting the namespace defers
 * that choice to `resolveBotPolicy`, where the rule belongs — the bundler glue has no
 * business knowing the contract.
 */
function buildEntryModule(entryPath: string): string {
  const specifier = `./${entryPath.replace(/\.ts$/, '')}`;
  return `import * as ${NAMESPACE_EXPORT} from '${specifier}';\nexport { ${NAMESPACE_EXPORT} };\n`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The compiler rejects with a `CompilationError` record rather than an `Error`, and
 * the file/line in it is the whole value of the message — "Unexpected token" without
 * a position is a sentence the agent cannot act on.
 */
function describeCompilationError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const record = error as { message?: unknown; file?: unknown; line?: unknown; column?: unknown };
    const where =
      typeof record.file === 'string'
        ? ` (${record.file}${typeof record.line === 'number' ? `:${record.line}` : ''}${
            typeof record.column === 'number' ? `:${record.column}` : ''
          })`
        : '';
    return `${String(record.message)}${where}`;
  }
  return describeError(error);
}
