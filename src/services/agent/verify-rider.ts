/**
 * The verify rider: the harness's own verdict, riding back in the result of the tool that caused
 * it, instead of waiting for the agent to think of checking.
 *
 * Measured on one Flow increment (`.plans/agent-one-shot-generation.md` §1): 39 % of the turn's
 * wall-clock went to the verification ceremony — `compile_scripts` → `play_start` → `play_status` →
 * `read_errors` — hop after hop, each paying the transport floor and the context tax. The first
 * of those hops is the one the agent would always make next after editing a script, and it needs
 * no judgement to make, so the harness makes it: a script write answers with its own compile
 * verdict. The precedent is `renderability-note.ts` — "a check you have to think to run is a check
 * that gets skipped precisely when it matters".
 *
 * What it must never do is say PASS about *intent*. The rider reports facts of exactly one sort
 * here — it compiled, or it did not — and names what it did NOT check in {@link VerifyRider.unverified},
 * so that silence cannot be read as proof. `compile.ok` deliberately does not discharge the turn's
 * verify debt in `AgentChatService` (see `GAME_PROOF_TOOLS`): a green type-check has never been
 * evidence that a game works, and an eval run (S2) already showed a model reading a truthful
 * description as a success report.
 */

/** Script directories the compiler actually bundles — mirrors `SCRIPT_DIRECTORIES`. */
const SCRIPT_SOURCE_DIRECTORIES = ['scripts/', 'src/scripts/'] as const;

/** Suffixes the compiler skips — mirrors `EXCLUDED_SCRIPT_SUFFIXES`. */
const EXCLUDED_SCRIPT_SUFFIXES = ['.spec.ts', '.test.ts', '.d.ts'] as const;

/** Diagnostics carried in a rider. Beyond a handful the agent should read the compile itself. */
export const VERIFY_RIDER_MAX_DIAGNOSTICS = 5;

/** Hard cap on one diagnostic message, so a deeply-nested type error cannot flood the result. */
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 240;

export interface VerifyRiderDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface VerifyRiderCompile {
  readonly ok: boolean;
  /** Type errors found (absent when the bundle itself failed — there was nothing to type-check). */
  readonly errorCount?: number;
  /** Wall-clock of the compile the harness ran, so its cost stays visible and measurable. */
  readonly elapsedMs?: number;
  readonly diagnostics?: readonly VerifyRiderDiagnostic[];
  /** How many diagnostics were dropped to stay under {@link VERIFY_RIDER_MAX_DIAGNOSTICS}. */
  readonly moreDiagnostics?: number;
  /**
   * Whether the build reached the live `ScriptRegistry`. A type error does NOT stop it — the bundle
   * is already registered and `play_restart` runs this code — but a bundle failure does. Said out
   * loud because the difference decides whether the agent's next step is a restart or another fix.
   */
  readonly registered?: boolean;
  /** Module specifiers the compile could not resolve — see {@link missingImportNote}. */
  readonly missingImports?: readonly string[];
  /** Bundle failure (esbuild), with its location when one was reported. */
  readonly error?: string;
  readonly file?: string;
  readonly line?: number;
}

export interface VerifyRider {
  readonly compile?: VerifyRiderCompile;
  /**
   * What this rider did NOT check, always present. Its job is to keep the agent from reading a
   * quiet result as a verified one — the failure mode the gate exists to prevent.
   */
  readonly unverified: readonly string[];
  readonly note?: string;
}

/**
 * Whether a write to this path changes something `compile_scripts` would compile.
 *
 * Paths arrive already normalised by `safePath` (no `res://`, no leading slash).
 */
export const isCompilableScriptPath = (path: string): boolean => {
  const lower = path.toLowerCase();
  if (!lower.endsWith('.ts') && !lower.endsWith('.js')) return false;
  if (EXCLUDED_SCRIPT_SUFFIXES.some(suffix => lower.endsWith(suffix))) return false;
  return SCRIPT_SOURCE_DIRECTORIES.some(directory => lower.startsWith(directory));
};

/**
 * True when a compile result carries an actual verdict about code.
 *
 * `compile_scripts` answers `ok: true` with a `message` when the project has no scripts at all, or
 * none that extend `Script`. That is not a verdict about anything the agent just wrote, so it rides
 * nowhere: an empty rider is worse than none, because it reads like a pass.
 */
const hasCompileVerdict = (result: Record<string, unknown>): boolean =>
  result.bundled === true || typeof result.error === 'string';

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const toRiderDiagnostic = (raw: unknown): VerifyRiderDiagnostic | null => {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as { file?: unknown; line?: unknown; message?: unknown; category?: unknown };
  if (entry.category === 'warning') return null;
  if (typeof entry.message !== 'string') return null;
  const message =
    entry.message.length > MAX_DIAGNOSTIC_MESSAGE_CHARS
      ? `${entry.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS - 1)}…`
      : entry.message;
  return {
    file: typeof entry.file === 'string' ? entry.file : '(unknown)',
    line: asNumber(entry.line) ?? 0,
    message,
  };
};

/**
 * Saying what was checked is only half of it. Left alone, "compile ok" is exactly the sentence an
 * agent uses to close a turn without ever running the game — so every rider names the two things a
 * compile cannot answer, in the words of the tools that can.
 */
const UNVERIFIED_AFTER_WRITE: readonly string[] = [
  'runtime — this build has not been run since the edit (play_start, or play_restart if it is already running, then read_errors)',
  'gameplay — nothing has watched the change in the running game (game_run / game_input)',
];

/**
 * The prose an agent actually reads — so it has to carry the limit, not just the saving.
 *
 * `verify.compile.ok: true` is the substring a skimming model latches onto, and a note that talks
 * only about the call it saved leaves "verified" as the obvious reading. The second sentence is the
 * whole reason `unverified` exists, said where it cannot be skipped.
 */
const RIDER_NOTE =
  'compile_scripts ran automatically after this write — do not call it again for this edit. This is a compile verdict only: nothing has RUN this code (see unverified).';

/**
 * The one false alarm this design creates: an agent authoring a feature across several files gets a
 * compile after the FIRST one, against imports it has not written yet.
 *
 * Said in terms of the SYMPTOM, not of the file names. A missing-import diagnostic's `file` is the
 * file that exists — the one just written — and the module that is missing appears only inside the
 * message, so "errors naming a file you have not created" describes nothing the agent can see. And
 * it rides only when {@link findMissingImports} actually found one: a note that also greets a
 * genuine type error would be telling the agent to postpone a real fix.
 */
const missingImportNote = (missing: readonly string[]): string =>
  `Unresolved import${missing.length === 1 ? '' : 's'} (${missing.join(', ')}) — if you are part-way through writing several files, write the rest before chasing ${missing.length === 1 ? 'it' : 'them'}; only the errors that survive are yours.`;

/**
 * Module specifiers a compile could not resolve, from either lane: TypeScript's TS2307 wording and
 * esbuild's. Capped — the point is to name the pattern, not to inventory it.
 */
const findMissingImports = (texts: readonly string[]): string[] => {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(
      /(?:Cannot find module|Could not resolve)\s+['"‘“]([^'"’”]+)['"’”]/g
    )) {
      found.add(match[1]);
      if (found.size >= VERIFY_RIDER_MAX_DIAGNOSTICS) return [...found];
    }
  }
  return [...found];
};

/**
 * Shape a `compile_scripts` result into the rider that rides back with a script write.
 *
 * Pure on purpose: everything time- and service-shaped (running the compile, reading the setting)
 * stays in `AgentToolRegistry`, so the wording and the caps — the parts that decide whether an
 * agent reads this correctly — are testable without a project, a compiler or a DI container.
 */
export const buildScriptWriteRider = (
  compileResult: Record<string, unknown>
): VerifyRider | null => {
  if (!hasCompileVerdict(compileResult)) return null;

  const elapsedMs = asNumber(compileResult.elapsedMs);
  const bundleError = typeof compileResult.error === 'string' ? compileResult.error : undefined;

  if (bundleError !== undefined) {
    const missingImports = findMissingImports([bundleError]);
    return {
      compile: {
        ok: false,
        registered: false,
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
        error: bundleError,
        ...(missingImports.length > 0 ? { missingImports } : {}),
        ...(typeof compileResult.file === 'string' ? { file: compileResult.file } : {}),
        ...(asNumber(compileResult.line) === undefined
          ? {}
          : { line: asNumber(compileResult.line) }),
      },
      unverified: UNVERIFIED_AFTER_WRITE,
      note: [
        RIDER_NOTE,
        'The bundle did not build, so nothing was registered — the running game is still on the previous build.',
        ...(missingImports.length > 0 ? [missingImportNote(missingImports)] : []),
      ].join(' '),
    };
  }

  const errorCount = asNumber(compileResult.errorCount) ?? 0;
  const rawDiagnostics = Array.isArray(compileResult.diagnostics) ? compileResult.diagnostics : [];
  const diagnostics = rawDiagnostics
    .map(toRiderDiagnostic)
    .filter((entry): entry is VerifyRiderDiagnostic => entry !== null);
  const shown = diagnostics.slice(0, VERIFY_RIDER_MAX_DIAGNOSTICS);
  const hidden = diagnostics.length - shown.length;

  const missingImports = findMissingImports(diagnostics.map(entry => entry.message));

  return {
    compile: {
      ok: errorCount === 0,
      errorCount,
      registered: true,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      ...(shown.length > 0 ? { diagnostics: shown } : {}),
      ...(hidden > 0 ? { moreDiagnostics: hidden } : {}),
      ...(missingImports.length > 0 ? { missingImports } : {}),
    },
    unverified: UNVERIFIED_AFTER_WRITE,
    note:
      errorCount === 0
        ? RIDER_NOTE
        : [
            RIDER_NOTE,
            'The bundle built and registered despite these, so play_restart does run this code.',
            ...(missingImports.length > 0 ? [missingImportNote(missingImports)] : []),
          ].join(' '),
  };
};
